import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import type { Logger } from '../src/logger.js';
import { startGateway, type RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { closedPort } from './helpers.js';

/**
 * Request handling details: when the body is read, what a client hang-up
 * looks like in the logs, which request IDs are trusted, and headers on errors.
 */

let mock: MockUpstream;
let gateway: RunningGateway;
const logged: string[] = [];
const logger: Logger = {
  info: () => {},
  warn: (message) => logged.push(`warn: ${message}`),
  error: (message) => logged.push(`error: ${message}`),
};

beforeAll(async () => {
  mock = await startMockUpstream('svc');
  const deadPort = await closedPort();
  const { config } = parseConfig(`
routes:
  - path: "/locked"
    methods: ["POST"]
    upstream: { url: "${mock.url}" }
    auth: { type: "api_key", keys: ["k"] }
  - path: "/limited"
    methods: ["POST"]
    upstream: { url: "${mock.url}" }
    rate_limit: { requests: 1, window: "1m" }
  - path: "/open"
    methods: ["GET", "POST"]
    upstream: { url: "${mock.url}" }
  - path: "/down"
    methods: ["GET"]
    upstream: { url: "http://127.0.0.1:${deadPort}" }
    rate_limit: { requests: 5, window: "1m" }
`);
  gateway = await startGateway(config, { port: 0, logger });
});

afterAll(async () => {
  await gateway?.close();
  await mock?.close();
});

/**
 * Starts a POST that declares a large body but only sends the first kilobyte,
 * and resolves with the response status if one arrives before the body is done.
 */
function startLargeUpload(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gateway.port, path, method: 'POST', headers: { ...headers, 'content-length': String(5 * 1024 * 1024) } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on('error', () => {}); // destroyed on purpose once answered
    req.write(Buffer.alloc(1024));
    setTimeout(() => reject(new Error('no response while the body was still being sent')), 1_000);
  });
}

describe('the request body is read only when the request will be forwarded', () => {
  it('auth rejects an upload without waiting for (or buffering) its body', async () => {
    expect(await startLargeUpload('/locked')).toBe(401);
  });

  it('rate limiting rejects an upload without waiting for its body', async () => {
    await fetch(`${gateway.url}/limited`, { method: 'POST', body: '{}' }); // uses the only slot
    expect(await startLargeUpload('/limited')).toBe(429);
  });

  it('a request that is forwarded still gets its full body', async () => {
    const res = await fetch(`${gateway.url}/open/x`, { method: 'POST', body: '{"full":true}' });
    expect(((await res.json()) as { body: unknown }).body).toEqual({ full: true });
  });
});

describe('client hang-ups', () => {
  it('a client that disconnects mid-upload is not logged as a malformed request or an error', async () => {
    logged.length = 0;
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: gateway.port, path: '/open/x', method: 'POST', headers: { 'content-length': '1000' } });
        req.on('error', () => resolve());
        req.write('partial');
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 30);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logged).toEqual([]);
  });
});

describe('X-Request-Id from the client', () => {
  const idFor = async (value: string) =>
    (await fetch(`${gateway.url}/open/x`, { headers: { 'x-request-id': value } })).headers.get('x-request-id');

  it('keeps a well-formed ID', async () => {
    expect(await idFor('abc-123_x.y:z')).toBe('abc-123_x.y:z');
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['contains spaces', 'id with spaces'],
    ['contains quotes and braces', '{"spoof":"x"}'],
  ])('replaces an ID that is %s with a fresh UUID', async (_label, value) => {
    expect(await idFor(value)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('rate limit headers on gateway errors', () => {
  it('are included when the upstream is unreachable (502)', async () => {
    const res = await fetch(`${gateway.url}/down/x`);
    expect(res.status).toBe(502);
    expect(res.headers.get('x-ratelimit-limit')).toBe('5');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4');
  });
});

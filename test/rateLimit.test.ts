import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { startTestGateway } from './helpers.js';

/**
 * Rate limiting end to end. To get two different client IPs from one machine,
 * some tests connect over IPv4 (127.0.0.1) and IPv6 (::1): the gateway
 * listens on both and sees them as different clients.
 */

let upstream: MockUpstream;
let gateway: RunningGateway;
let ipv6Url: string;
let ipv6Available = false;

beforeAll(async () => {
  upstream = await startMockUpstream('limited');
  gateway = await startTestGateway(`
gateway:
  global_rate_limit: { requests: 2, window: "60s", strategy: "fixed_window", per: "ip" }
routes:
  - path: "/api/limited"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
    rate_limit: { requests: 3, window: "60s", strategy: "fixed_window", per: "ip" }

  - path: "/api/burst"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
    rate_limit: { requests: 10, window: "60s", strategy: "sliding_window", per: "ip" }

  - path: "/api/sliding"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
    rate_limit: { requests: 2, window: "300ms", strategy: "sliding_window", per: "ip" }

  - path: "/api/fixed"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
    rate_limit: { requests: 2, window: "300ms", strategy: "fixed_window", per: "ip" }

  - path: "/api/per-ip"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
    rate_limit: { requests: 1, window: "60s", per: "ip" }

  - path: "/api/shared"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
    rate_limit: { requests: 1, window: "60s", per: "global" }

  # No rate_limit: both inherit global_rate_limit (2 per 60s), each with its own budget.
  - path: "/api/inherit-a"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
  - path: "/api/inherit-b"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
`);
  ipv6Url = `http://[::1]:${gateway.port}`;
  ipv6Available = await fetch(`${ipv6Url}/health`).then(
    (res) => res.ok,
    () => false,
  );
});

afterAll(async () => {
  await gateway?.close();
  await upstream?.close();
});

const send = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, init);
const statuses = async (path: string, count: number) => {
  const codes: number[] = [];
  for (let i = 0; i < count; i += 1) codes.push((await send(path)).status);
  return codes;
};
const hits = (fragment: string) => upstream.requests.filter((r) => r.url.includes(fragment)).length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('rate limiting', () => {
  it('admits `requests` per window, then returns 429 without calling the upstream', async () => {
    expect(await statuses('/api/limited/a', 3)).toEqual([200, 200, 200]);
    const before = hits('/api/limited');

    const res = await send('/api/limited/a');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({
      error: 'rate_limited',
      message: 'rate limit of 3 requests per 60s exceeded',
      retry_after: 60,
    });
    expect(hits('/api/limited')).toBe(before);
  });

  it('sends X-RateLimit-* headers on admitted and rejected responses', async () => {
    const ok = await send('/api/fixed/headers');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-ratelimit-limit')).toBe('2');
    expect(ok.headers.get('x-ratelimit-remaining')).toBe('1');
    expect(ok.headers.get('x-ratelimit-reset')).toBe('1');

    await send('/api/fixed/headers');
    const rejected = await send('/api/fixed/headers');
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('x-ratelimit-remaining')).toBe('0');
    await sleep(350); // let the 300ms window pass for the next test
  });

  it('admits exactly the limit when 50 requests arrive at once', async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => send(`/api/burst/${i}`)));
    const counts = responses.reduce<Record<number, number>>((acc, res) => {
      acc[res.status] = (acc[res.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ 200: 10, 429: 40 });
    expect(hits('/api/burst')).toBe(10);
  });

  it('fixed_window: admits a fresh batch once the window has passed', async () => {
    expect(await statuses('/api/fixed/w', 3)).toEqual([200, 200, 429]);
    await sleep(350);
    expect(await statuses('/api/fixed/w', 3)).toEqual([200, 200, 429]);
  });

  it('sliding_window: frees slots as earlier requests age out', async () => {
    expect(await statuses('/api/sliding/w', 3)).toEqual([200, 200, 429]);
    await sleep(350);
    expect(await statuses('/api/sliding/w', 3)).toEqual([200, 200, 429]);
  });

  it('gives routes that inherit global_rate_limit their own budgets', async () => {
    expect(await statuses('/api/inherit-a', 3)).toEqual([200, 200, 429]);
    expect(await statuses('/api/inherit-b', 3)).toEqual([200, 200, 429]);
  });

  it('does not count requests refused with 405 against the budget', async () => {
    // Method filtering runs before rate limiting, so these never touch the 1-per-minute budget.
    for (let i = 0; i < 5; i += 1) expect((await send('/api/per-ip/x', { method: 'POST' })).status).toBe(405);
    expect((await send('/api/per-ip/x')).status).toBe(200);
  });

  it('per: "ip" keeps a separate budget for each client address', async (ctx) => {
    if (!ipv6Available) ctx.skip();
    // /api/per-ip allows 1 per minute; the IPv4 client used it in the previous test.
    expect((await send('/api/per-ip/y')).status).toBe(429);
    expect((await fetch(`${ipv6Url}/api/per-ip/y`)).status).toBe(200);
  });

  it('per: "global" shares one budget across all clients', async (ctx) => {
    if (!ipv6Available) ctx.skip();
    expect((await send('/api/shared/z')).status).toBe(200);
    expect((await fetch(`${ipv6Url}/api/shared/z`)).status).toBe(429);
  });

  it('ignores a client-supplied X-Forwarded-For, so it cannot be used to dodge the limit', async () => {
    const results: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(
        await new Promise<number>((resolve, reject) => {
          http
            .get(`${gateway.url}/api/limited/b`, { headers: { 'x-forwarded-for': `10.0.0.${i}` } }, (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            })
            .on('error', reject);
        }),
      );
    }
    expect(results.every((status) => status === 429)).toBe(true); // budget was used up in the first test
  });
});

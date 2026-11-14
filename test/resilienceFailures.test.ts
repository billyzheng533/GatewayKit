import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { closedPort, startTestGateway } from './helpers.js';

/**
 * Retry and circuit breaker when the upstream doesn't answer at all
 * (unreachable, timed out), and when the client gives up mid-retry.
 */

let mock: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  mock = await startMockUpstream('svc');
  const deadPort = await closedPort();
  gateway = await startTestGateway(`
routes:
  - path: "/api/cb-down"
    methods: ["GET"]
    upstream: { url: "http://127.0.0.1:${deadPort}" }
    circuit_breaker: { threshold: 2, window: "60s", cooldown: "60s" }

  - path: "/api/cb-timeout"
    methods: ["GET"]
    upstream: { url: "${mock.url}", timeout: "100ms" }
    circuit_breaker: { threshold: 2, window: "60s", cooldown: "60s" }

  - path: "/api/retry-abort"
    methods: ["GET"]
    upstream: { url: "${mock.url}" }
    retry: { attempts: 5, backoff: "fixed", initial_delay: "300ms", on: [503] }

  - path: "/api/retry-unlisted"
    methods: ["GET"]
    upstream: { url: "http://127.0.0.1:${deadPort}" }
    retry: { attempts: 3, backoff: "fixed", initial_delay: "200ms", on: [503] }

  - path: "/api/retry-put"
    methods: ["PUT"]
    upstream: { url: "${mock.url}" }
    retry: { attempts: 3, backoff: "fixed", initial_delay: "10ms", on: [503] }
`);
});

afterAll(async () => {
  await gateway?.close();
  await mock?.close();
});

const send = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, init);
const hits = (fragment: string) => mock.requests.filter((r) => r.url.includes(fragment)).length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('circuit breaker failure counting', () => {
  it('counts an unreachable upstream as a failure and opens', async () => {
    expect((await send('/api/cb-down')).status).toBe(502);
    expect((await send('/api/cb-down')).status).toBe(502);
    const res = await send('/api/cb-down');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'service_unavailable', retry_after: 60 });
  });

  it('counts timeouts as failures and opens, then stops calling the slow upstream', async () => {
    expect((await send('/api/cb-timeout/slow?ms=500&key=t1')).status).toBe(504);
    expect((await send('/api/cb-timeout/slow?ms=500&key=t2')).status).toBe(504);
    expect((await send('/api/cb-timeout/slow?ms=500&key=t3')).status).toBe(503);
    expect(hits('key=t3')).toBe(0);
  });
});

describe('retry failure paths', () => {
  it('stops retrying when the client disconnects during the backoff wait', async () => {
    const controller = new AbortController();
    const pending = send('/api/retry-abort/flaky?fail=100&key=abort', { signal: controller.signal });
    await sleep(100); // first attempt failed; the gateway is now waiting 300ms
    controller.abort();
    await expect(pending).rejects.toThrow();
    await sleep(500); // long enough for a second attempt, had it happened
    expect(hits('key=abort')).toBe(1);
  });

  it('does not retry an upstream failure whose status is not listed in `on`', async () => {
    const started = Date.now();
    const res = await send('/api/retry-unlisted'); // unreachable = 502, but on: [503]
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(150); // no 200ms backoff waits
  });

  it('retries PUT, which is idempotent', async () => {
    const res = await send('/api/retry-put/flaky?fail=2&key=put', { method: 'PUT', body: '{"qty":1}' });
    expect(res.status).toBe(200);
    expect(hits('key=put')).toBe(3);
    // The buffered body was resent on every attempt.
    expect(mock.requests.filter((r) => r.url.includes('key=put')).map((r) => r.body)).toEqual(Array(3).fill('{"qty":1}'));
  });
});

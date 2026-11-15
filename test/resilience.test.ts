import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backoffDelay } from '../src/features/retry/index.js';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { closedPort, startTestGateway } from './helpers.js';

/**
 * End-to-end tests for retry and the circuit breaker, against real mock
 * upstreams. Delays and cooldowns are tiny so the suite stays fast.
 */

let retryUpstream: MockUpstream;
let breakerUpstream: MockUpstream;
let bothUpstream: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  [retryUpstream, breakerUpstream, bothUpstream] = await Promise.all([
    startMockUpstream('retry'),
    startMockUpstream('breaker'),
    startMockUpstream('both'),
  ]);
  const deadPort = await closedPort();

  gateway = await startTestGateway(`
routes:
  - path: "/api/retry"
    methods: ["GET", "POST"]
    upstream: { url: "${retryUpstream.url}", timeout: "150ms" }
    retry: { attempts: 3, backoff: "fixed", initial_delay: "20ms", on: [502, 503, 504] }

  - path: "/api/backoff"
    methods: ["GET", "POST"]
    upstream: { url: "http://localhost:${deadPort}" }
    retry: { attempts: 3, backoff: "exponential", initial_delay: "50ms", on: [502] }

  - path: "/api/cb"
    methods: ["GET"]
    upstream: { url: "${breakerUpstream.url}" }
    circuit_breaker: { threshold: 3, window: "60s", cooldown: "300ms" }

  - path: "/api/both"
    methods: ["GET"]
    upstream: { url: "${bothUpstream.url}" }
    retry: { attempts: 3, backoff: "fixed", initial_delay: "10ms", on: [503] }
    circuit_breaker: { threshold: 2, window: "60s", cooldown: "10s" }
`);
});

afterAll(async () => {
  await gateway?.close();
  await Promise.all([retryUpstream, breakerUpstream, bothUpstream].map((m) => m?.close()));
});

const send = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, init);
const hits = (mock: MockUpstream, fragment: string) => mock.requests.filter((r) => r.url.includes(fragment)).length;

describe('retry', () => {
  it('computes fixed and exponential backoff', () => {
    const base = { attempts: 4, initialDelayMs: 100, onStatus: [503] };
    expect([1, 2, 3].map((n) => backoffDelay({ ...base, backoff: 'fixed' }, n))).toEqual([100, 100, 100]);
    expect([1, 2, 3].map((n) => backoffDelay({ ...base, backoff: 'exponential' }, n))).toEqual([100, 200, 400]);
  });

  it('retries a retryable status until the upstream recovers', async () => {
    const res = await send('/api/retry/flaky?fail=2&key=recovers');
    expect(res.status).toBe(200);
    expect(hits(retryUpstream, 'key=recovers')).toBe(3);
  });

  it('gives up after `attempts` tries and returns the last upstream response', async () => {
    const res = await send('/api/retry/flaky?fail=10&key=gives-up');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'flaky', call: 3 });
    expect(hits(retryUpstream, 'key=gives-up')).toBe(3);
  });

  it('does not retry statuses that are not listed in `on`', async () => {
    const res = await send('/api/retry/status/404?key=not-listed');
    expect(res.status).toBe(404);
    expect(hits(retryUpstream, 'key=not-listed')).toBe(1);
  });

  it('does not retry a POST the upstream received, to avoid duplicate side effects', async () => {
    const res = await send('/api/retry/flaky?fail=1&key=post', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(hits(retryUpstream, 'key=post')).toBe(1);
  });

  it('retries timeouts as 504 and returns 504 when every attempt times out', async () => {
    const res = await send('/api/retry/slow?ms=400&key=timeout');
    expect(res.status).toBe(504);
    expect(hits(retryUpstream, 'key=timeout')).toBe(3);
  });

  it('waits with exponential backoff between attempts (50ms + 100ms)', async () => {
    const started = Date.now();
    const res = await send('/api/backoff');
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('retries a POST when the connection was refused, since the request never arrived', async () => {
    const started = Date.now();
    const res = await send('/api/backoff', { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});

describe('circuit breaker', () => {
  it('opens after `threshold` failures, rejects without calling the upstream, then recovers after the cooldown', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await send('/api/cb/status/503')).status).toBe(503);
    }
    const before = breakerUpstream.requests.length;

    const rejected = await send('/api/cb/anything');
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(await rejected.json()).toEqual({ error: 'service_unavailable', retry_after: 1 });
    expect(breakerUpstream.requests.length).toBe(before); // upstream was not called

    await new Promise((resolve) => setTimeout(resolve, 350)); // cooldown is 300ms
    expect((await send('/api/cb/trial')).status).toBe(200); // half-open trial succeeds
    expect((await send('/api/cb/after')).status).toBe(200); // closed again
  });

  it('does not count a plain 500, so one bad request cannot open the breaker for everyone', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await send('/api/cb/status/500')).status).toBe(500);
    }
    expect((await send('/api/cb/still-closed-after-500s')).status).toBe(200);
  });

  it('counts 4xx responses as successes', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await send('/api/cb/status/404')).status).toBe(404);
    }
    expect((await send('/api/cb/still-closed')).status).toBe(200);
  });
});

describe('retry with a circuit breaker', () => {
  it('counts each attempt and stops retrying once the breaker opens', async () => {
    // Attempts 1 and 2 get 503 and trip the breaker (threshold 2); attempt 3 is
    // rejected by the breaker, and that rejection is not retried.
    const res = await send('/api/both/status/503');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'service_unavailable', retry_after: 10 });
    expect(hits(bothUpstream, '/status/503')).toBe(2);
  });
});

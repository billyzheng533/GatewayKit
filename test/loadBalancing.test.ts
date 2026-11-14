import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { closedPort, startTestGateway } from './helpers.js';

/** Load balancing end to end: which mock actually answered each request. */

let a: MockUpstream;
let b: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  [a, b] = await Promise.all([startMockUpstream('a'), startMockUpstream('b')]);
  const deadPort = await closedPort();
  gateway = await startTestGateway(`
routes:
  - path: "/rr"
    methods: ["GET"]
    upstream:
      targets: [{ url: "${a.url}" }, { url: "${b.url}" }]
      balance: "round_robin"

  - path: "/weighted"
    methods: ["GET"]
    upstream:
      targets: [{ url: "${a.url}", weight: 3 }, { url: "${b.url}", weight: 1 }]
      balance: "weighted_round_robin"

  - path: "/burst"
    methods: ["GET"]
    upstream:
      targets: [{ url: "${a.url}", weight: 3 }, { url: "${b.url}", weight: 1 }]
      balance: "weighted_round_robin"

  - path: "/strip"
    methods: ["GET"]
    strip_prefix: true
    upstream:
      targets: [{ url: "${a.url}" }, { url: "${b.url}" }]

  # One target is down. With retry, a failed attempt moves on to the next target.
  - path: "/retry-next"
    methods: ["GET"]
    upstream:
      targets: [{ url: "http://127.0.0.1:${deadPort}" }, { url: "${a.url}" }]
    retry: { attempts: 2, backoff: "fixed", initial_delay: "10ms", on: [502] }

  - path: "/one-down"
    methods: ["GET"]
    upstream:
      targets: [{ url: "http://127.0.0.1:${deadPort}" }, { url: "${a.url}" }]

  - path: "/all-down"
    methods: ["GET"]
    upstream:
      targets: [{ url: "http://127.0.0.1:${deadPort}" }, { url: "http://127.0.0.1:${deadPort}" }]
`);
});

afterAll(async () => {
  await gateway?.close();
  await Promise.all([a, b].map((m) => m?.close()));
});

/** Which mock answered each of `count` sequential requests. */
async function answeredBy(path: string, count: number): Promise<string[]> {
  const result: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await fetch(`${gateway.url}${path}`);
    result.push(res.status === 200 ? (res.headers.get('x-upstream') ?? '?') : String(res.status));
  }
  return result;
}

describe('load balancing', () => {
  it('round_robin alternates between targets', async () => {
    expect(await answeredBy('/rr/x', 4)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('weighted_round_robin sends 3 of every 4 requests to the weight-3 target, spread out', async () => {
    expect(await answeredBy('/weighted/x', 8)).toEqual(['a', 'a', 'b', 'a', 'a', 'a', 'b', 'a']);
  });

  it('splits 40 simultaneous requests exactly 30/10', async () => {
    const responses = await Promise.all(Array.from({ length: 40 }, () => fetch(`${gateway.url}/burst/x`)));
    const counts = { a: 0, b: 0 };
    for (const res of responses) counts[res.headers.get('x-upstream') as 'a' | 'b'] += 1;
    expect(counts).toEqual({ a: 30, b: 10 });
  });

  it('strips the prefix the same way for every target', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const body = (await (await fetch(`${gateway.url}/strip/123`)).json()) as { upstream: string; path: string };
      paths.push(`${body.upstream}:${body.path}`);
    }
    expect(paths).toEqual(['a:/123', 'b:/123']);
  });
});

describe('load balancing failures', () => {
  it('with retry, an attempt that fails on one target is retried on the next', async () => {
    const before = a.requests.length;
    const res = await fetch(`${gateway.url}/retry-next/x`); // attempt 1: dead target, attempt 2: a
    expect(res.status).toBe(200);
    expect(res.headers.get('x-upstream')).toBe('a');
    expect(a.requests.length).toBe(before + 1);
  });

  it('without retry, requests that land on a dead target get 502 and the rest succeed', async () => {
    // No health checks yet, so the dead target stays in the rotation.
    expect(await answeredBy('/one-down/x', 4)).toEqual(['502', 'a', '502', 'a']);
  });

  it('returns 502 when every target is down', async () => {
    expect(await answeredBy('/all-down/x', 2)).toEqual(['502', '502']);
  });
});

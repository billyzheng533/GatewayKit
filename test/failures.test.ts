import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { closedPort, startTestGateway } from './helpers.js';

/**
 * Failure modes, end to end: upstreams that misbehave in different ways, and
 * clients that go away. Each test checks two things: the client gets a sensible
 * answer (or a clean disconnect), and the gateway keeps serving afterwards.
 */

let svc: MockUpstream;
let restartable: MockUpstream;
let restartPort: number;
let breakerSvc: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  restartPort = await freePort();
  [svc, restartable, breakerSvc] = await Promise.all([
    startMockUpstream('svc'),
    startMockUpstream('restartable', restartPort),
    startMockUpstream('breaker'),
  ]);
  const deadPort = await closedPort();

  gateway = await startTestGateway(`
routes:
  - path: "/api/svc"
    methods: ["GET", "POST"]
    upstream: { url: "${svc.url}", timeout: "300ms" }
  - path: "/api/restart"
    methods: ["GET"]
    upstream: { url: "http://127.0.0.1:${restartPort}" }
  - path: "/api/dead"
    methods: ["GET"]
    upstream: { url: "http://127.0.0.1:${deadPort}" }
  - path: "/api/breaker"
    methods: ["GET"]
    upstream: { url: "${breakerSvc.url}" }
    circuit_breaker: { threshold: 1, window: "60s", cooldown: "200ms" }
`);
});

afterAll(async () => {
  await gateway?.close();
  await Promise.all([svc, restartable, breakerSvc].map((m) => m?.close()));
});

const send = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, init);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectStillServing(): Promise<void> {
  expect((await send('/health')).status).toBe(200);
  expect((await send('/api/svc/ok')).status).toBe(200);
}

describe('misbehaving upstreams', () => {
  it('returns 502 when the upstream resets the connection without responding', async () => {
    const res = await send('/api/svc/reset');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'bad_gateway' });
    await expectStillServing();
  });

  it('returns 502 when the upstream answers with something that is not HTTP', async () => {
    const res = await send('/api/svc/garbage');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'bad_gateway' });
    await expectStillServing();
  });

  it('cuts the client connection (instead of hanging) when the upstream dies mid-body', async () => {
    // Headers (200) were already relayed, so the only honest signal left is an aborted body.
    const res = await send('/api/svc/truncate');
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    await expectStillServing();
  });

  it('returns 504 for an upstream that never answers, without waiting for it', async () => {
    const started = Date.now();
    const res = await send('/api/svc/slow?ms=5000');
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expectStillServing();
  });

  it('returns 502 for every request when 50 hit a dead upstream at once, and stays up', async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, () => send('/api/dead')));
    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(502));
    await expectStillServing();
  });

  it('recovers when an upstream goes down and comes back on the same port', async () => {
    expect((await send('/api/restart/before')).status).toBe(200);

    await restartable.close();
    expect((await send('/api/restart/while-down')).status).toBe(502);

    restartable = await startMockUpstream('restartable', restartPort);
    expect((await send('/api/restart/after')).status).toBe(200);
  });
});

describe('clients that go away', () => {
  it('cancels the upstream request when the client disconnects', async () => {
    const controller = new AbortController();
    const pending = send('/api/svc/slow?ms=250&key=client-gone', { signal: controller.signal });
    await sleep(50);
    controller.abort();
    await expect(pending).rejects.toThrow();

    await sleep(50);
    const upstreamSide = svc.requests.find((r) => r.url.includes('key=client-gone'));
    expect(upstreamSide?.callerDisconnected).toBe(true);
    await expectStillServing();
  });

  it('survives a client that disconnects halfway through sending its body', async () => {
    await new Promise<void>((resolve) => {
      const req = http.request(`${gateway.url}/api/svc/upload`, {
        method: 'POST',
        headers: { 'content-length': '1000' },
      });
      req.on('error', () => resolve()); // expected: we destroy our own request
      req.write('only part of the body');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await sleep(50);
    expect(svc.requests.some((r) => r.url.includes('/upload'))).toBe(false); // never forwarded
    await expectStillServing();
  });
});

describe('circuit breaker failure path', () => {
  it('re-opens when the half-open trial request fails', async () => {
    expect((await send('/api/breaker/status/500')).status).toBe(500); // threshold 1: opens
    expect((await send('/api/breaker/ok')).status).toBe(503);

    await sleep(250); // cooldown is 200ms
    expect((await send('/api/breaker/status/500')).status).toBe(500); // trial fails: re-opens
    const rejected = await send('/api/breaker/ok');
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: 'service_unavailable', retry_after: 1 });
  });
});

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

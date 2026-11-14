import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { closedPort, startTestGateway } from './helpers.js';

/**
 * Health checks end to end: real checks against mock upstreams every 50ms,
 * with unhealthy targets taken out of (and put back into) the rotation.
 */

let a: MockUpstream;
let b: MockUpstream;
let deadPort: number;
const gateways: RunningGateway[] = [];

beforeAll(async () => {
  [a, b] = await Promise.all([startMockUpstream('a'), startMockUpstream('b')]);
  deadPort = await closedPort();
});

afterEach(async () => {
  a.setHealthy(true);
  b.setHealthy(true);
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

afterAll(async () => {
  await Promise.all([a, b].map((m) => m?.close()));
});

async function gatewayWith(targets: string[], extra = ''): Promise<RunningGateway> {
  const gateway = await startTestGateway(`
routes:
  - path: "/svc"
    methods: ["GET"]
    upstream:
      targets: [${targets.map((url) => `{ url: "${url}" }`).join(', ')}]
      timeout: "200ms"
    health_check: { path: "/healthz", interval: "50ms", unhealthy_threshold: 2 }
${extra}`);
  gateways.push(gateway);
  return gateway;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function answeredBy(gateway: RunningGateway, count: number): Promise<string[]> {
  const result: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await fetch(`${gateway.url}/svc/x`);
    result.push(res.status === 200 ? (res.headers.get('x-upstream') ?? '?') : String(res.status));
  }
  return result;
}

describe('health checks', () => {
  it('uses every target while all are healthy', async () => {
    const gateway = await gatewayWith([a.url, b.url]);
    await sleep(120);
    expect(await answeredBy(gateway, 4)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('checks the configured path on each target', async () => {
    await gatewayWith([a.url, b.url]);
    await sleep(120);
    expect(a.requests.some((r) => r.url === '/healthz')).toBe(true);
    expect(b.requests.some((r) => r.url === '/healthz')).toBe(true);
  });

  it('takes a target out of the rotation after `unhealthy_threshold` failed checks, then puts it back', async () => {
    const gateway = await gatewayWith([a.url, b.url]);
    b.setHealthy(false); // b's /healthz now answers 503, but b still serves traffic
    await sleep(200); // > 2 checks at 50ms
    expect(await answeredBy(gateway, 4)).toEqual(['a', 'a', 'a', 'a']);

    b.setHealthy(true);
    await sleep(120); // one passing check is enough
    expect((await answeredBy(gateway, 4)).sort()).toEqual(['a', 'a', 'b', 'b']);
  });

  it('stops sending traffic to a target that is down, so clients stop getting 502s', async () => {
    const gateway = await gatewayWith([`http://127.0.0.1:${deadPort}`, a.url]);
    await sleep(200);
    expect(await answeredBy(gateway, 4)).toEqual(['a', 'a', 'a', 'a']);
  });

  it('counts a slow health check as failed', async () => {
    // The check path is slower than the check timeout (min of 200ms upstream timeout and 50ms interval).
    const gateway = await startTestGateway(`
routes:
  - path: "/svc"
    methods: ["GET"]
    upstream:
      targets: [{ url: "${a.url}" }, { url: "${b.url}" }]
      timeout: "200ms"
    health_check: { path: "/slow?ms=500", interval: "50ms", unhealthy_threshold: 2 }
`);
    gateways.push(gateway);
    await sleep(250);
    const res = await fetch(`${gateway.url}/svc/x`);
    expect(res.status).toBe(503);
  });
});

describe('health check failures', () => {
  it('returns 503 without calling any upstream when every target is unhealthy', async () => {
    const gateway = await gatewayWith([a.url, b.url]);
    a.setHealthy(false);
    b.setHealthy(false);
    await sleep(200);
    const before = a.requests.filter((r) => r.url === '/svc/x').length + b.requests.filter((r) => r.url === '/svc/x').length;

    const res = await fetch(`${gateway.url}/svc/x`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_healthy_upstream', message: 'no healthy upstream target for /svc' });
    const after = a.requests.filter((r) => r.url === '/svc/x').length + b.requests.filter((r) => r.url === '/svc/x').length;
    expect(after).toBe(before);
  });

  it('recovers on its own when a target comes back', async () => {
    const gateway = await gatewayWith([a.url]);
    a.setHealthy(false);
    await sleep(200);
    expect(await answeredBy(gateway, 1)).toEqual(['503']);
    a.setHealthy(true);
    await sleep(120);
    expect(await answeredBy(gateway, 1)).toEqual(['a']);
  });

  it('stops checking when the gateway shuts down', async () => {
    const gateway = await gatewayWith([a.url]);
    await sleep(120);
    await gateway.close();
    gateways.splice(gateways.indexOf(gateway), 1);
    const checksAtClose = a.requests.filter((r) => r.url === '/healthz').length;
    await sleep(200);
    expect(a.requests.filter((r) => r.url === '/healthz').length).toBe(checksAtClose);
  });

  it('routes without health_check are unaffected by unhealthy targets', async () => {
    const gateway = await startTestGateway(`
routes:
  - path: "/svc"
    methods: ["GET"]
    upstream: { targets: [{ url: "${a.url}" }, { url: "${b.url}" }] }
`);
    gateways.push(gateway);
    b.setHealthy(false); // only affects /healthz, which nobody checks here
    await sleep(120);
    expect(await answeredBy(gateway, 2)).toEqual(['a', 'b']);
  });
});

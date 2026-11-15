import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { FAILED_ATTEMPT_WINDOW_MS, MAX_FAILED_ATTEMPTS } from '../src/features/auth/index.js';
import { startGateway, type RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';

/**
 * The separate limit on failed API key attempts, with a controllable clock so
 * the lockout window can be passed without waiting.
 */

let mock: MockUpstream;
let gateway: RunningGateway;
let clock = 1_000_000;

beforeAll(async () => {
  mock = await startMockUpstream('internal');
  const { config } = parseConfig(`
routes:
  - path: "/internal"
    methods: ["GET"]
    upstream: { url: "${mock.url}" }
    auth: { type: "api_key", keys: ["right-key"] }
`);
  gateway = await startGateway(config, { port: 0, now: () => clock });
});

afterAll(async () => {
  await gateway?.close();
  await mock?.close();
});

const attempt = (key: string | undefined, host = '127.0.0.1') =>
  fetch(`http://${host}:${gateway.port}/internal/x`, { headers: key ? { 'x-api-key': key } : {} });

describe('failed API key attempts', () => {
  it(`allows ${MAX_FAILED_ATTEMPTS} failures, then refuses every attempt from that client, even with the right key`, async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) expect((await attempt(`guess-${i}`)).status).toBe(401);

    const blocked = await attempt('right-key');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe(String(FAILED_ATTEMPT_WINDOW_MS / 1000));
    expect(await blocked.json()).toMatchObject({ error: 'too_many_failed_attempts', retry_after: 60 });
  });

  it('does not affect other clients', async (ctx) => {
    const ipv6 = await attempt('right-key', '[::1]').catch(() => null);
    if (!ipv6) ctx.skip(); // no IPv6 loopback on this machine
    expect(ipv6!.status).toBe(200);
  });

  it('lets the client try again once the window has passed', async () => {
    clock += FAILED_ATTEMPT_WINDOW_MS;
    expect((await attempt('right-key')).status).toBe(200);
  });

  it('does not count successful attempts', async () => {
    clock += FAILED_ATTEMPT_WINDOW_MS;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS * 2; i += 1) expect((await attempt('right-key')).status).toBe(200);
  });
});

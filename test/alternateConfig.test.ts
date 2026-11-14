import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { startGateway, type RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';

/**
 * Runs examples/alternate-gateway.yaml: same schema as gateway.yaml, different
 * values, routes and feature combinations. Only the upstream ports are swapped
 * for test mocks on random ports; everything else is the file as shipped.
 */

const MOCK_NAMES = ['users', 'orders', 'products-a', 'products-b', 'legacy', 'internal'];
const mocks = new Map<string, MockUpstream>();
let gateway: RunningGateway;
let warnings: string[];

beforeAll(async () => {
  const started = await Promise.all(MOCK_NAMES.map((name) => startMockUpstream(name)));
  started.forEach((mock) => mocks.set(mock.name, mock));

  let yaml = await readFile('examples/alternate-gateway.yaml', 'utf8');
  MOCK_NAMES.forEach((name, i) => {
    yaml = yaml.replaceAll(`http://localhost:${3001 + i}`, mocks.get(name)!.url);
  });
  const loaded = parseConfig(yaml);
  warnings = loaded.warnings;
  gateway = await startGateway(loaded.config, { port: 0 });
});

afterAll(async () => {
  await gateway?.close();
  await Promise.all([...mocks.values()].map((m) => m.close()));
});

const send = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, init);
const body = async (res: Response) => (await res.json()) as { upstream: string; path: string };

describe('examples/alternate-gateway.yaml', () => {
  it('loads with no warnings (anchors, merge keys and Go-style durations all understood)', () => {
    expect(warnings).toEqual([]);
  });

  it('sends unmatched paths to the catch-all "/" route', async () => {
    const res = await send('/some/other/page');
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ upstream: 'users', path: '/some/other/page' });
    expect(res.headers.get('x-ratelimit-limit')).toBe('500'); // inherited global limit
  });

  it('round-robins /v2/catalog across two targets, with the prefix stripped', async () => {
    const first = await body(await send('/v2/catalog/items/1'));
    const second = await body(await send('/v2/catalog/items/1'));
    expect([first.upstream, second.upstream].sort()).toEqual(['products-a', 'products-b']);
    expect(first.path).toBe('/items/1');
  });

  it('retries /v2/catalog on 503, moving to the next target each attempt', async () => {
    // Each mock fails its first call: target A fails, target B fails, target A succeeds.
    const res = await send('/v2/catalog/flaky?fail=1&key=alt');
    expect(res.status).toBe(200);
  });

  it('routes /v2/catalog/admin (more specific) with its own auth header', async () => {
    expect((await send('/v2/catalog/admin/reports')).status).toBe(401);
    const res = await send('/v2/catalog/admin/reports', { headers: { 'Authorization-Token': 'admin-token-1' } });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ upstream: 'internal', path: '/reports' });
  });

  it('only allows POST on /billing', async () => {
    expect((await send('/billing/charge', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await send('/billing/charge')).status).toBe(405);
  });

  it('opens the /billing circuit breaker after 2 failures', async () => {
    for (let i = 0; i < 2; i += 1) {
      expect((await send('/billing/status/500', { method: 'POST', body: '{}' })).status).toBe(500);
    }
    const res = await send('/billing/charge', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'service_unavailable', retry_after: 15 });
  });
});

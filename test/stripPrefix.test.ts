import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { startTestGateway } from './helpers.js';

/**
 * strip_prefix end to end: what path and query string does the upstream
 * actually receive? The mock echoes both back.
 */

let upstream: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  upstream = await startMockUpstream('strip');
  gateway = await startTestGateway(`
routes:
  - path: "/api/products"
    methods: ["GET"]
    strip_prefix: true
    upstream: { url: "${upstream.url}" }

  # Trailing slash in the config is normalized away.
  - path: "/api/legacy/"
    methods: ["GET"]
    strip_prefix: true
    upstream: { url: "${upstream.url}" }

  # Upstream URL with its own base path: the stripped path is appended to it.
  - path: "/api/v2"
    methods: ["GET"]
    strip_prefix: true
    upstream: { url: "${upstream.url}/base" }

  - path: "/api/keep"
    methods: ["GET"]
    strip_prefix: false
    upstream: { url: "${upstream.url}" }
`);
});

afterAll(async () => {
  await gateway?.close();
  await upstream?.close();
});

/** What the upstream received for a request to `path` on the gateway. */
async function forwarded(path: string): Promise<{ path: string; query: Record<string, string> }> {
  const res = await fetch(`${gateway.url}${path}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { path: string; query: Record<string, string> };
}

describe('strip_prefix: true', () => {
  it.each([
    ['/api/products/123', '/123'],
    ['/api/products/a/b/c', '/a/b/c'],
    ['/api/products', '/'],
    ['/api/products/', '/'],
    ['/api/products/a%20b', '/a%20b'],
    ['/api/legacy/v1/data', '/v1/data'],
  ])('forwards %s as %s', async (requested, expected) => {
    expect((await forwarded(requested)).path).toBe(expected);
  });

  it('keeps the query string when stripping', async () => {
    expect(await forwarded('/api/products/123?sort=price&page=2')).toMatchObject({
      path: '/123',
      query: { sort: 'price', page: '2' },
    });
    expect(await forwarded('/api/products?q=shoes')).toMatchObject({ path: '/', query: { q: 'shoes' } });
  });

  it('appends the stripped path to an upstream base path', async () => {
    expect((await forwarded('/api/v2/items/7')).path).toBe('/base/items/7');
  });

  it('only strips on a segment boundary: /api/productsX does not match the route at all', async () => {
    expect((await fetch(`${gateway.url}/api/productsX/1`)).status).toBe(404);
  });
});

describe('strip_prefix: false', () => {
  it('forwards the full original path', async () => {
    expect(await forwarded('/api/keep/1?x=1')).toMatchObject({ path: '/api/keep/1', query: { x: '1' } });
  });
});

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { startTestGateway } from './helpers.js';

/**
 * Path tricks that try to escape a route's prefix, end to end.
 *
 * These use the raw http client on purpose: fetch() and curl resolve ".."
 * before sending, which would hide exactly what we're testing.
 */

let products: MockUpstream;
let internal: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  [products, internal] = await Promise.all([startMockUpstream('products'), startMockUpstream('internal')]);
  gateway = await startTestGateway(`
routes:
  - path: "/api/products"
    methods: ["GET"]
    strip_prefix: true
    upstream: { url: "${products.url}" }
  - path: "/api/internal"
    methods: ["GET"]
    upstream: { url: "${internal.url}" }
`);
});

afterAll(async () => {
  await gateway?.close();
  await Promise.all([products, internal].map((m) => m?.close()));
});

interface RawResponse {
  status: number;
  body: { error?: string; message?: string; upstream?: string; path?: string };
}

/** Sends `path` exactly as written, with no client-side normalization. */
function rawGet(path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gateway.port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    req.end();
  });
}

const productHits = () => products.requests.length;

describe('path normalization', () => {
  it('routes "/api/products/../internal/x" as "/api/internal/x", not to the products upstream', async () => {
    const before = productHits();
    const res = await rawGet('/api/products/../internal/secret');
    // It's the same request as /api/internal/secret, so that route's rules (auth, limits) apply.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ upstream: 'internal', path: '/api/internal/secret' });
    expect(productHits()).toBe(before);
  });

  it('does not let encoded dot-segments escape the prefix either', async () => {
    const before = productHits();
    const res = await rawGet('/api/products/%2e%2e/%2e%2e/admin');
    expect(res.status).toBe(404); // resolves to /admin, which no route serves
    expect(productHits()).toBe(before);
  });

  it('resolves dot-segments that stay inside the route before stripping the prefix', async () => {
    expect((await rawGet('/api/products/a/../123')).body.path).toBe('/123');
    expect((await rawGet('/api/products/./123')).body.path).toBe('/123');
    expect((await rawGet('//api//products///123')).body.path).toBe('/123');
  });

  it.each([
    ['/api/products/..%2Finternal/secret', 'encoded slash'],
    ['/api/products/..%5Cinternal/secret', 'encoded backslash'],
    ['/api/products/..\\internal\\secret', 'raw backslash'],
    ['/../../etc/passwd', 'climbing above the root'],
    ['/api/products/1%00.json', 'encoded null byte'],
  ])('rejects %s (%s) with 400 without calling any upstream', async (path) => {
    const before = productHits() + internal.requests.length;
    const res = await rawGet(path);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/^invalid request path/) });
    expect(productHits() + internal.requests.length).toBe(before);
  });

  it('applies the same normalization to /health', async () => {
    expect((await rawGet('/api/../health')).body).toMatchObject({ status: 'healthy' });
  });
});

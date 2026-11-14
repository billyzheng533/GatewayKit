import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { closedPort, startTestGateway } from './helpers.js';

/**
 * End-to-end tests: a real gateway on a random port, proxying to real mock
 * upstream servers, exercised over HTTP with fetch.
 */

let users: MockUpstream;
let products: MockUpstream;
let catchAll: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  [users, products, catchAll] = await Promise.all([
    startMockUpstream('users'),
    startMockUpstream('products'),
    startMockUpstream('catch-all'),
  ]);
  const deadPort = await closedPort();

  gateway = await startTestGateway(`
gateway:
  port: 8080
  global_timeout: "2s"
routes:
  - path: "/api/users"
    methods: ["GET", "POST"]
    upstream:
      url: "${users.url}"
  - path: "/api/products"
    methods: ["GET"]
    strip_prefix: true
    upstream:
      url: "${products.url}"
      timeout: "200ms"
  - path: "/api/down"
    methods: ["GET"]
    upstream:
      url: "http://localhost:${deadPort}" # "localhost": exercises the dual-stack (IPv6 + IPv4) failure path
  - path: "/"
    methods: ["GET"]
    upstream:
      url: "${catchAll.url}"
`);
});

afterAll(async () => {
  await gateway?.close();
  await Promise.all([users, products, catchAll].map((m) => m?.close()));
});

const get = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, init);
const json = (res: Response): Promise<any> => res.json();

describe('GET /health', () => {
  it('returns 200 with status and integer uptime, even with a catch-all "/" route', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await json(res);
    expect(body).toEqual({ status: 'healthy', uptime_seconds: expect.any(Number) });
    expect(Number.isInteger(body.uptime_seconds)).toBe(true);
    expect(catchAll.requests.some((r) => r.url === '/health')).toBe(false);
  });
});

describe('proxying', () => {
  it('forwards a GET with its path and query string and returns the upstream response', async () => {
    const res = await get('/api/users/42?expand=orders&x=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-upstream')).toBe('users');
    const body = await json(res);
    expect(body).toMatchObject({ method: 'GET', path: '/api/users/42', query: { expand: 'orders', x: '1' } });
  });

  it('forwards a POST body and content type', async () => {
    const res = await get('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ method: 'POST', body: { name: 'Ada' } });
    expect(body.headers['content-type']).toBe('application/json');
  });

  it('passes upstream error statuses through unchanged', async () => {
    const res = await get('/api/users/status/418');
    expect(res.status).toBe(418);
    expect(await json(res)).toEqual({ upstream: 'users', status: 418 });
  });

  it('adds X-Forwarded-* and X-Request-Id headers and rewrites Host', async () => {
    const res = await get('/api/users', { headers: { 'x-request-id': 'req-123', 'x-forwarded-for': '10.0.0.1' } });
    const { headers } = await json(res);
    expect(headers['x-request-id']).toBe('req-123');
    expect(headers['x-forwarded-for']).toMatch(/^10\.0\.0\.1, /);
    expect(headers['x-forwarded-proto']).toBe('http');
    expect(headers.host).toBe(new URL(users.url).host);
    expect(res.headers.get('x-request-id')).toBe('req-123');
  });

  it('generates a request id when the client sends none', async () => {
    const res = await get('/api/users');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('strips the route prefix when strip_prefix is true', async () => {
    expect((await json(await get('/api/products/123'))).path).toBe('/123');
    expect((await json(await get('/api/products'))).path).toBe('/');
  });

  it('routes to the most specific prefix and falls back to the catch-all', async () => {
    const res = await get('/api/usersettings');
    expect(res.headers.get('x-upstream')).toBe('catch-all');
  });
});

describe('unmatched routes and method filtering', () => {
  it('returns 404 when no route matches', async () => {
    const strict = await startTestGateway(`
routes:
  - path: "/api/users"
    methods: ["GET"]
    upstream: { url: "${users.url}" }
`);
    try {
      const res = await fetch(`${strict.url}/api/unknown`);
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({ error: 'not_found', message: 'no route matches /api/unknown' });
      expect((await fetch(`${strict.url}/api/usersX`)).status).toBe(404);
    } finally {
      await strict.close();
    }
  });

  it('returns 405 with an Allow header for a method the route does not accept', async () => {
    const before = products.requests.length;
    const res = await get('/api/products/1', { method: 'POST', body: '{}' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(await json(res)).toMatchObject({ error: 'method_not_allowed' });
    expect(products.requests.length).toBe(before); // never reached the upstream
  });
});

describe('upstream failures', () => {
  it('returns 502 when the upstream is unreachable', async () => {
    const res = await get('/api/down');
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error).toBe('bad_gateway');
    expect(body.message).toMatch(/is unavailable: .*ECONNREFUSED/);
  });

  it('returns 504 when the upstream exceeds the route timeout', async () => {
    const started = Date.now();
    const res = await get('/api/products/slow?ms=1000');
    expect(res.status).toBe(504);
    expect(await json(res)).toMatchObject({ error: 'gateway_timeout' });
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('keeps serving other requests after an upstream failure', async () => {
    await get('/api/down');
    expect((await get('/api/users')).status).toBe(200);
  });
});

describe('concurrency', () => {
  it('handles 50 simultaneous requests', async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => get(`/api/users/${i}`)));
    const bodies = await Promise.all(responses.map(json));
    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(new Set(bodies.map((b) => b.path)).size).toBe(50);
  });
});

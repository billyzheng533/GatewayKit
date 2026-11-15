import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config/load.js';
import { applyHeaderTransform, resolveValue } from '../src/features/transform/index.js';
import type { RouteConfig } from '../src/config/types.js';
import type { RunningGateway } from '../src/server.js';
import { closedPort, startTestGateway } from './helpers.js';

const ctx = { receivedAt: new Date('2026-01-02T03:04:05.000Z'), route: { path: '/api/legacy' } as RouteConfig };

describe('header transforms (unit)', () => {
  it('removes (case-insensitively), then adds, replacing existing values', () => {
    const headers = { 'x-debug': '1', 'x-internal': 'true', 'x-keep': 'yes', 'x-gateway': 'old' };
    applyHeaderTransform(headers, { remove: ['X-Debug', 'X-INTERNAL'], add: { 'X-Gateway': 'gatewaykit' } }, ctx);
    expect(headers).toEqual({ 'x-keep': 'yes', 'x-gateway': 'gatewaykit' });
  });

  it('resolves variables and $literal:', () => {
    const now = () => new Date('2026-01-02T03:04:06.500Z');
    expect(resolveValue('$request_time', ctx)).toBe('2026-01-02T03:04:05.000Z');
    expect(resolveValue('$response_time', ctx, now)).toBe('2026-01-02T03:04:06.500Z');
    expect(resolveValue('$route_path', ctx)).toBe('/api/legacy');
    expect(resolveValue('$literal:$request_time', ctx)).toBe('$request_time');
    expect(resolveValue('plain', ctx)).toBe('plain');
  });

  it.each<[string, string, string]>([
    ['an unknown variable (typo)', 'request_transform: { headers: { add: { X-T: "$requst_time" } } }', 'unknown variable "$requst_time"'],
    ['$response_time on a request', 'request_transform: { headers: { add: { X-T: "$response_time" } } }', 'unknown variable "$response_time"'],
    ['setting Host', 'request_transform: { headers: { add: { Host: "evil" } } }', 'request_transform.headers.add.Host: cannot be set by a transform'],
    ['setting Content-Length', 'response_transform: { headers: { add: { Content-Length: "1" } } }', 'cannot be set by a transform'],
  ])('rejects %s at startup', (_label, transform, expected) => {
    try {
      parseConfig(`routes: [{ path: "/a", methods: [GET], upstream: { url: "http://x" }, ${transform} }]`);
      throw new Error('expected a ConfigError');
    } catch (err) {
      expect((err as ConfigError).issues.join('\n')).toContain(expected);
    }
  });
});

let upstream: http.Server;
let gateway: RunningGateway;
let lastRequestHeaders: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    lastRequestHeaders = req.headers;
    res.writeHead(200, { server: 'Apache/2.4', 'x-powered-by': 'PHP/8', 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const deadPort = await closedPort();
  // The same transforms as gateway.yaml's /api/legacy route (header parts).
  const transforms = `
    request_transform:
      headers:
        add: { X-Gateway: "gatewaykit", X-Request-Start: "$request_time" }
        remove: ["X-Debug", "X-Internal"]
    response_transform:
      headers:
        add: { X-Served-By: "gatewaykit", X-Route: "$route_path" }
        remove: ["Server", "X-Powered-By"]`;
  gateway = await startTestGateway(`
routes:
  - path: "/api/legacy"
    methods: ["GET"]
    upstream: { url: "${upstreamUrl}" }${transforms}
  - path: "/api/legacy-down"
    methods: ["GET"]
    upstream: { url: "http://127.0.0.1:${deadPort}" }${transforms}
`);
});

afterAll(async () => {
  await gateway?.close();
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

describe('header transforms (integration)', () => {
  it('strips internal headers from the request and adds the configured ones', async () => {
    const before = Date.now();
    await fetch(`${gateway.url}/api/legacy/x`, { headers: { 'X-Internal': 'true', 'X-Debug': '1', 'X-Other': 'kept' } });
    expect(lastRequestHeaders['x-internal']).toBeUndefined();
    expect(lastRequestHeaders['x-debug']).toBeUndefined();
    expect(lastRequestHeaders['x-other']).toBe('kept');
    expect(lastRequestHeaders['x-gateway']).toBe('gatewaykit');
    const started = Date.parse(String(lastRequestHeaders['x-request-start']));
    expect(started).toBeGreaterThanOrEqual(before - 1_000);
    expect(String(lastRequestHeaders['x-request-start'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('strips backend details from the response and adds the configured headers', async () => {
    const res = await fetch(`${gateway.url}/api/legacy/x`);
    expect(res.headers.get('server')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-served-by')).toBe('gatewaykit');
    expect(res.headers.get('x-route')).toBe('/api/legacy');
    expect(await res.text()).toBe('ok'); // body untouched
  });

  it('applies the response headers to gateway errors too', async () => {
    const res = await fetch(`${gateway.url}/api/legacy-down/x`);
    expect(res.status).toBe(502);
    expect(res.headers.get('x-served-by')).toBe('gatewaykit');
  });
});

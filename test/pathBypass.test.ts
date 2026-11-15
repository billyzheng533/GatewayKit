import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config/load.js';
import { normalizePath } from '../src/path.js';
import { pathMatches } from '../src/router.js';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { startTestGateway } from './helpers.js';

/**
 * Reaching a protected route's upstream through a broader open route, by
 * writing the path in a form the router saw as different but the upstream
 * treats as the same: other letter case, percent-encoded letters, or ";"
 * path parameters. (Reported in review; reproduced before fixing.)
 */

describe('path normalization (unit)', () => {
  it.each([
    ['/api/%69nternal/secret', '/api/internal/secret'],
    ['/api/%49NTERNAL', '/api/INTERNAL'],
    ['/a/%7euser/%2D%2e%5f', '/a/~user/-._'],
    ['/a/%41%42%43%31%32%33', '/a/ABC123'],
    ['/a/%2e%2e/b', '/b'],
    ['/a%20b/c%3fd', '/a%20b/c%3Fd'], // not unreserved: stays encoded, hex upper-cased
  ])('decodes unreserved characters: %s -> %s', (raw, expected) => {
    expect(normalizePath(raw)).toBe(expected);
  });

  it.each(['/api/internal;x/secret', '/api/internal%3bx/secret', '/api/internal%3Bx', '/a;b'])('rejects ";" path parameters: %s', (raw) => {
    expect(() => normalizePath(raw)).toThrow('";" path parameters are not allowed');
  });
});

describe('route matching ignores case (unit)', () => {
  it('matches a prefix in any letter case, still on a segment boundary', () => {
    expect(pathMatches('/api/internal', '/api/Internal/secret')).toBe(true);
    expect(pathMatches('/api/internal', '/API/INTERNAL')).toBe(true);
    expect(pathMatches('/api/internal', '/api/Internalx')).toBe(false);
  });

  it('treats routes that differ only in case as duplicates in the config', () => {
    try {
      parseConfig('routes: [{ path: "/api", methods: [GET], upstream: { url: "http://x" } }, { path: "/API", methods: [GET], upstream: { url: "http://y" } }]');
      throw new Error('expected a ConfigError');
    } catch (err) {
      expect((err as ConfigError).issues).toEqual([
        'routes[1].path: duplicates routes[0].path "/api" (route paths match regardless of case)',
      ]);
    }
  });

  it('rejects a route path containing ";" or an encoded unreserved character', () => {
    const issues = (path: string) => {
      try {
        parseConfig(`routes: [{ path: "${path}", methods: [GET], upstream: { url: "http://x" } }]`);
        return [];
      } catch (err) {
        return (err as ConfigError).issues;
      }
    };
    expect(issues('/api;v=1')[0]).toMatch(/must not contain .*";"/);
    expect(issues('/api/%69nternal')[0]).toMatch(/must be written in normalized form \("\/api\/internal"\)/);
  });
});

let upstream: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  upstream = await startMockUpstream('shared');
  // The risky shape from the review: an open parent route and a protected child, same upstream.
  gateway = await startTestGateway(`
routes:
  - path: "/api"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
  - path: "/api/internal"
    methods: ["GET"]
    upstream: { url: "${upstream.url}" }
    auth: { type: "api_key", keys: ["k"] }
`);
});

afterAll(async () => {
  await gateway?.close();
  await upstream?.close();
});

function rawGet(path: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: gateway.port, path, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('bypassing a protected route through a broader one (integration)', () => {
  it.each([
    ['/api/internal/secret', 401],
    ['/api/Internal/secret', 401],
    ['/API/INTERNAL/secret', 401],
    ['/api/%69nternal/secret', 401],
    ['/api/%49nternal/secret', 401],
    ['/api/internal;x/secret', 400],
    ['/api/internal%3Bx/secret', 400],
  ])('%s without a key gets %i, and never reaches the upstream', async (path, status) => {
    const before = upstream.requests.length;
    expect((await rawGet(path)).status).toBe(status);
    expect(upstream.requests.length).toBe(before);
  });

  it('forwards the decoded path once authorized', async () => {
    const res = await rawGet('/api/%69nternal/secret', { 'x-api-key': 'k' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).path).toBe('/api/internal/secret');
  });

  it('forwards a differently-cased path as sent, through the matching route', async () => {
    const res = await rawGet('/api/Internal/secret', { 'x-api-key': 'k' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).path).toBe('/api/Internal/secret');
  });

  it('still serves the open parent route', async () => {
    expect((await rawGet('/api/public')).status).toBe(200);
  });
});

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  invalidTrustedProxy,
  normalizeIp,
  rateLimitKey,
  resolveClient,
  trustedProxyList,
} from '../src/clientIdentity.js';
import { ConfigError, parseConfig } from '../src/config/load.js';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { startTestGateway } from './helpers.js';

const lb = trustedProxyList(['10.0.0.0/8', '192.0.2.1']);

describe('resolveClient (unit)', () => {
  it('with no trusted proxies, uses the socket address and ignores what the client claims', () => {
    expect(resolveClient('::ffff:203.0.113.7', { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' }, null)).toEqual({
      clientIp: '203.0.113.7',
      forwardedFor: '203.0.113.7',
      forwardedProto: 'http',
    });
  });

  it('ignores forwarding headers from a client that is not a trusted proxy', () => {
    const identity = resolveClient('198.51.100.20', { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-host': 'evil.example' }, lb);
    expect(identity).toEqual({ clientIp: '198.51.100.20', forwardedFor: '198.51.100.20', forwardedProto: 'http' });
  });

  it('behind a trusted proxy, takes the client from the chain and keeps the chain', () => {
    const identity = resolveClient(
      '10.0.0.5',
      { 'x-forwarded-for': '198.51.100.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'shop.example' },
      lb,
    );
    expect(identity).toEqual({
      clientIp: '198.51.100.9',
      forwardedFor: '198.51.100.9, 10.0.0.5',
      forwardedProto: 'https',
      forwardedHost: 'shop.example',
    });
  });

  it('uses the rightmost untrusted address, not a spoofed leftmost one', () => {
    // The client sent "6.6.6.6"; our load balancer then appended the real client.
    const identity = resolveClient('10.0.0.5', { 'x-forwarded-for': '6.6.6.6, 198.51.100.9, 10.1.1.1' }, lb);
    expect(identity.clientIp).toBe('198.51.100.9');
  });

  it('falls back to the leftmost entry when every hop is a trusted proxy', () => {
    expect(resolveClient('10.0.0.5', { 'x-forwarded-for': '10.2.2.2, 10.1.1.1' }, lb).clientIp).toBe('10.2.2.2');
  });

  it('never turns garbage in the chain into the client identity', () => {
    expect(resolveClient('10.0.0.5', { 'x-forwarded-for': 'not-an-ip' }, lb).clientIp).toBe('10.0.0.5');
  });
});

describe('helpers (unit)', () => {
  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::1')).toBe('::1');
  });

  it.each([
    ['10.0.0.0/8', undefined],
    ['192.0.2.1', undefined],
    ['2001:db8::/32', undefined],
    ['10.0.0.0/33', '"10.0.0.0/33" has an invalid prefix length (0-32)'],
    ['load-balancer', '"load-balancer" is not an IP address or CIDR range'],
    ['10.0.0.0/8/1', '"10.0.0.0/8/1" is not an IP address or CIDR range'],
  ])('validates trusted proxy entry %s', (entry, problem) => {
    expect(invalidTrustedProxy(entry)).toBe(problem);
  });

  it('groups IPv6 clients by /64 for rate limiting, and leaves IPv4 alone', () => {
    expect(rateLimitKey('2001:db8:aaaa:bbbb:1:2:3:4')).toBe('2001:db8:aaaa:bbbb::/64');
    expect(rateLimitKey('2001:db8:aaaa:bbbb::99')).toBe('2001:db8:aaaa:bbbb::/64');
    expect(rateLimitKey('2001:0db8:00aa::1')).toBe('2001:db8:aa:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('rejects invalid trusted_proxies in the config', () => {
    try {
      parseConfig('gateway: { trusted_proxies: ["10.0.0.0/8", "lb.internal"] }');
      throw new Error('expected a ConfigError');
    } catch (err) {
      expect((err as ConfigError).issues).toEqual(['gateway.trusted_proxies[1]: "lb.internal" is not an IP address or CIDR range']);
    }
  });
});

let mock: MockUpstream;
let edge: RunningGateway;
let behindLb: RunningGateway;

beforeAll(async () => {
  mock = await startMockUpstream('svc');
  const route = `routes: [{ path: "/", methods: ["GET"], upstream: { url: "${mock.url}" }, rate_limit: { requests: 1, window: "1m", per: "ip" } }]`;
  edge = await startTestGateway(route);
  // Treat the test client (127.0.0.1) as our load balancer.
  behindLb = await startTestGateway(`gateway: { trusted_proxies: ["127.0.0.1"] }\n${route}`);
});

afterAll(async () => {
  await Promise.all([edge?.close(), behindLb?.close()]);
  await mock?.close();
});

async function upstreamSaw(gateway: RunningGateway, path: string, headers: Record<string, string>) {
  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: gateway.port, path, headers }, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
  return { status: res.status, headers: res.status === 200 ? (JSON.parse(res.body).headers as Record<string, string>) : {} };
}

describe('identity headers sent upstream (integration)', () => {
  it('as the edge: replaces spoofed identity headers with the real client address', async () => {
    const { headers } = await upstreamSaw(edge, '/a', {
      'x-forwarded-for': '6.6.6.6',
      'x-real-ip': '6.6.6.6',
      forwarded: 'for=6.6.6.6',
      'x-forwarded-host': 'evil.example',
      host: 'evil.example',
    });
    expect(headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(headers['x-real-ip']).toBe('127.0.0.1');
    expect(headers.forwarded).toBeUndefined();
    expect(headers['x-forwarded-host']).toBeUndefined();
  });

  it('behind a trusted proxy: keeps the chain and identifies the client from it', async () => {
    const { headers } = await upstreamSaw(behindLb, '/b', {
      'x-forwarded-for': '198.51.100.9',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'shop.example',
    });
    expect(headers['x-forwarded-for']).toBe('198.51.100.9, 127.0.0.1');
    expect(headers['x-real-ip']).toBe('198.51.100.9');
    expect(headers['x-forwarded-proto']).toBe('https');
    expect(headers['x-forwarded-host']).toBe('shop.example');
  });

  it('behind a trusted proxy: rate limits each real client separately', async () => {
    // Limit is 1 per minute per client. Two different clients via the same load balancer both get in.
    expect((await upstreamSaw(behindLb, '/c', { 'x-forwarded-for': '198.51.100.30' })).status).toBe(200);
    expect((await upstreamSaw(behindLb, '/c', { 'x-forwarded-for': '198.51.100.31' })).status).toBe(200);
    expect((await upstreamSaw(behindLb, '/c', { 'x-forwarded-for': '198.51.100.30' })).status).toBe(429);
  });

  it('as the edge: a spoofed X-Forwarded-For cannot dodge the rate limit', async () => {
    const fresh = await startTestGateway(
      `routes: [{ path: "/", methods: ["GET"], upstream: { url: "${mock.url}" }, rate_limit: { requests: 1, window: "1m", per: "ip" } }]`,
    );
    try {
      expect((await upstreamSaw(fresh, '/d', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
      expect((await upstreamSaw(fresh, '/d', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
    } finally {
      await fresh.close();
    }
  });
});

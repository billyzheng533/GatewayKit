import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digest, keyMatches } from '../src/features/auth/index.js';
import type { RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';
import { startTestGateway } from './helpers.js';

const KEY_A = 'sk_live_abc123';
const KEY_B = 'sk_live_def456';

let internal: MockUpstream;
let other: MockUpstream;
let gateway: RunningGateway;

beforeAll(async () => {
  [internal, other] = await Promise.all([startMockUpstream('internal'), startMockUpstream('other')]);
  gateway = await startTestGateway(`
routes:
  - path: "/api/internal"
    methods: ["GET", "POST"]
    upstream: { url: "${internal.url}" }
    auth: { type: "api_key", header: "X-API-Key", keys: ["${KEY_A}", "${KEY_B}"] }

  # A different header name, to show it comes from the config.
  - path: "/api/service"
    methods: ["GET"]
    upstream: { url: "${internal.url}" }
    auth: { type: "api_key", header: "X-Service-Token", keys: ["svc_token_1"] }

  # Auth on Authorization, a header Node normally de-duplicates by keeping only the first copy.
  - path: "/api/authz"
    methods: ["GET"]
    upstream: { url: "${internal.url}" }
    auth: { type: "api_key", header: "Authorization", keys: ["${KEY_A}"] }

  # Auth together with rate limiting and a circuit breaker.
  - path: "/api/guarded"
    methods: ["GET"]
    upstream: { url: "${internal.url}" }
    auth: { type: "api_key", header: "X-API-Key", keys: ["${KEY_A}"] }
    rate_limit: { requests: 3, window: "60s", per: "ip" }
    circuit_breaker: { threshold: 1, window: "60s", cooldown: "60s" }

  - path: "/api/open"
    methods: ["GET"]
    upstream: { url: "${other.url}" }
`);
});

afterAll(async () => {
  await gateway?.close();
  await Promise.all([internal, other].map((m) => m?.close()));
});

const send = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch(`${gateway.url}${path}`, { ...init, headers });
const internalHits = () => internal.requests.length;

/** Sends `name` twice over a raw socket, since HTTP clients may merge or reject duplicates. */
function rawTwice(path: string, name: string, values: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(gateway.port, '127.0.0.1', () => {
      const headerLines = values.map((value) => `${name}: ${value}\r\n`).join('');
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n${headerLines}Connection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(Number(data.split(' ')[1])));
    socket.on('error', reject);
  });
}

/** Raw request, for things fetch won't do: duplicate headers, un-normalized paths. */
function rawGet(path: string, headers: http.OutgoingHttpHeaders): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: gateway.port, path, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

describe('keyMatches', () => {
  const keys = [KEY_A, KEY_B].map(digest);

  it('accepts any configured key', () => {
    expect(keyMatches(KEY_A, keys)).toBe(true);
    expect(keyMatches(KEY_B, keys)).toBe(true);
  });

  it.each([
    ['a prefix of a key', 'sk_live_abc'],
    ['a key with extra characters', `${KEY_A}x`],
    ['a key in different case', KEY_A.toUpperCase()],
    ['an empty string', ''],
    ['an unrelated value', 'hunter2'],
  ])('rejects %s', (_label, candidate) => {
    expect(keyMatches(candidate, keys)).toBe(false);
  });
});

describe('API key auth', () => {
  it('forwards a request with a valid key, and accepts every configured key', async () => {
    expect((await send('/api/internal/a', { 'X-API-Key': KEY_A })).status).toBe(200);
    expect((await send('/api/internal/b', { 'X-API-Key': KEY_B })).status).toBe(200);
  });

  it('matches the header name case-insensitively', async () => {
    expect((await send('/api/internal/c', { 'x-api-key': KEY_A })).status).toBe(200);
  });

  it('removes the key before forwarding, so the upstream never sees it', async () => {
    const res = await send('/api/internal/echo', { 'X-API-Key': KEY_A, 'X-Other': 'kept' });
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers['x-api-key']).toBeUndefined();
    expect(body.headers['x-other']).toBe('kept');
  });

  it('uses the header named in the config', async () => {
    expect((await send('/api/service/x', { 'X-Service-Token': 'svc_token_1' })).status).toBe(200);
    expect((await send('/api/service/x', { 'X-API-Key': 'svc_token_1' })).status).toBe(401);
  });

  it('leaves routes without auth open', async () => {
    expect((await send('/api/open/x')).status).toBe(200);
  });
});

describe('API key auth failures', () => {
  it('returns 401 for a missing key without calling the upstream', async () => {
    const before = internalHits();
    const res = await send('/api/internal/secret');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('ApiKey header="X-API-Key"');
    expect(await res.json()).toEqual({
      error: 'unauthorized',
      message: 'missing API key: send it in the X-API-Key header',
    });
    expect(internalHits()).toBe(before);
  });

  it.each([
    ['a wrong key', 'sk_live_wrong'],
    ['a prefix of a valid key', 'sk_live_abc'],
    ['a valid key with extra characters', `${KEY_A}0`],
    ['a valid key in different case', KEY_A.toUpperCase()],
    ['a key for a different route', 'svc_token_1'],
  ])('returns 401 for %s without calling the upstream', async (_label, key) => {
    const before = internalHits();
    const res = await send('/api/internal/secret', { 'X-API-Key': key });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'invalid API key' });
    expect(internalHits()).toBe(before);
  });

  it('returns 401 for an empty key', async () => {
    expect(await rawGet('/api/internal/secret', { 'x-api-key': '' })).toBe(401);
  });

  it('returns 401 when the key header is sent twice, even if one copy is valid', async () => {
    expect(await rawGet('/api/internal/secret', { 'x-api-key': [KEY_A, 'sk_live_wrong'] })).toBe(401);
  });

  it('returns 401 when Authorization is sent twice, even though Node would keep only the first copy', async () => {
    const before = internalHits();
    expect(await rawGet('/api/authz/x', { authorization: KEY_A })).toBe(200);
    expect(await rawTwice('/api/authz/x', 'Authorization', [KEY_A, 'anything'])).toBe(401);
    expect(internalHits()).toBe(before + 1);
  });

  it('cannot be dodged with ".." through an open route', async () => {
    // Path normalization routes this to /api/internal, where auth applies.
    expect(await rawGet('/api/open/../internal/secret', {})).toBe(401);
    expect(await rawGet('/api/open/../internal/secret', { 'x-api-key': KEY_A })).toBe(200);
  });

  it('applies to every method on the route', async () => {
    const res = await send('/api/internal/x', { 'content-type': 'application/json' }, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('auth with other features', () => {
  it('counts failed attempts against the rate limit, so keys cannot be guessed at full speed', async () => {
    const results: number[] = [];
    for (const key of ['guess1', 'guess2', 'guess3']) results.push((await send('/api/guarded/x', { 'X-API-Key': key })).status);
    expect(results).toEqual([401, 401, 401]);
    // Budget of 3 is used up: even the right key now waits.
    expect((await send('/api/guarded/x', { 'X-API-Key': KEY_A })).status).toBe(429);
  });

  it('does not count 401s as upstream failures for the circuit breaker', async () => {
    const fresh = await startTestGateway(`
routes:
  - path: "/api/guarded"
    methods: ["GET"]
    upstream: { url: "${internal.url}" }
    auth: { type: "api_key", header: "X-API-Key", keys: ["${KEY_A}"] }
    circuit_breaker: { threshold: 1, window: "60s", cooldown: "60s" }
`);
    try {
      for (let i = 0; i < 3; i += 1) expect((await fetch(`${fresh.url}/api/guarded/x`)).status).toBe(401);
      const ok = await fetch(`${fresh.url}/api/guarded/x`, { headers: { 'X-API-Key': KEY_A } });
      expect(ok.status).toBe(200); // breaker (threshold 1) is still closed
    } finally {
      await fresh.close();
    }
  });
});

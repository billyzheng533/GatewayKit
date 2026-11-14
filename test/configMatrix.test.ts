import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfigFile, parseConfig } from '../src/config/load.js';
import { startGateway, type RunningGateway } from '../src/server.js';
import { startMockUpstream, type MockUpstream } from '../mock/upstream.js';

/**
 * "Your gateway must work with any valid config following this schema."
 *
 * Valid configs in many shapes must load AND serve traffic; invalid
 * combinations must be rejected with a clear error; legal-but-suspicious
 * combinations must load with a warning.
 */

let up: MockUpstream;
let up2: MockUpstream;

beforeAll(async () => {
  [up, up2] = await Promise.all([startMockUpstream('one'), startMockUpstream('two')]);
});

afterAll(async () => {
  await Promise.all([up, up2].map((m) => m?.close()));
});

/** Loads `yaml`, starts a gateway on a random port, runs `check`, and always shuts it down. */
async function withGateway(yaml: string, check: (gateway: RunningGateway) => Promise<void>): Promise<void> {
  const { config } = parseConfig(yaml);
  const gateway = await startGateway(config, { port: 0 });
  try {
    await check(gateway);
  } finally {
    await gateway.close();
  }
}

const status = async (gateway: RunningGateway, path: string, init?: RequestInit) =>
  (await fetch(`${gateway.url}${path}`, init)).status;

function issuesOf(yaml: string): string[] {
  try {
    parseConfig(yaml);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected the config to be rejected');
}

describe('valid configs load and serve traffic', () => {
  it('a config with only routes (no gateway section)', async () => {
    await withGateway(`routes: [{ path: "/svc", methods: ["GET"], upstream: { url: "${up.url}" } }]`, async (gw) => {
      expect(await status(gw, '/svc/x')).toBe(200);
      expect(await status(gw, '/health')).toBe(200);
    });
  });

  it('a config with no routes at all: /health works, everything else is 404', async () => {
    await withGateway('gateway: { port: 9999 }', async (gw) => {
      expect(await status(gw, '/health')).toBe(200);
      expect(await status(gw, '/anything')).toBe(404);
    });
  });

  it('a single catch-all "/" route', async () => {
    await withGateway(`routes: [{ path: "/", methods: ["GET", "POST"], upstream: { url: "${up.url}" } }]`, async (gw) => {
      expect(await status(gw, '/deeply/nested/path?q=1')).toBe(200);
      expect(await status(gw, '/x', { method: 'POST', body: '{}' })).toBe(200);
    });
  });

  it('nested prefixes with different settings, in any order', async () => {
    await withGateway(
      `
routes:
  - { path: "/v1", methods: ["GET"], upstream: { url: "${up.url}" } }
  - { path: "/v1/admin", methods: ["DELETE"], upstream: { url: "${up2.url}" }, strip_prefix: true }
`,
      async (gw) => {
        const res = await fetch(`${gw.url}/v1/admin/users/7`, { method: 'DELETE' });
        expect(res.headers.get('x-upstream')).toBe('two');
        expect(((await res.json()) as { path: string }).path).toBe('/users/7');
        expect(await status(gw, '/v1/admin/users/7')).toBe(405); // GET isn't allowed on the more specific route
        expect(await status(gw, '/v1/other')).toBe(200);
      },
    );
  });

  it('every feature on one route at once', async () => {
    await withGateway(
      `
gateway:
  port: 7070
  global_timeout: "5s"
  global_rate_limit: { requests: 1000, window: "1m", strategy: "sliding_window", per: "global" }
routes:
  - path: "/all"
    methods: ["get", "post"]
    strip_prefix: true
    upstream:
      targets: [{ url: "${up.url}", weight: 2 }, { url: "${up2.url}" }]
      balance: "weighted_round_robin"
      timeout: "2s"
    rate_limit: { requests: 50, window: "10s" }
    auth: { type: "api_key", header: "X-Token", keys: ["t1"] }
    retry: { attempts: 2, backoff: "exponential", initial_delay: "10ms", on: [502, 503] }
    circuit_breaker: { threshold: 3, window: "1m", cooldown: "5s" }
    health_check: { path: "/healthz", interval: "10s", unhealthy_threshold: 2 }
    request_transform:
      headers: { add: { X-From: "gateway", X-Version: 2 }, remove: ["X-Debug"] }
      body: { mapping: { user.id: "userId" } }
    response_transform:
      headers: { add: { X-Served-By: "gk" }, remove: ["Server"] }
      body: { envelope: { data: "$body" } }
`,
      async (gw) => {
        expect(await status(gw, '/all/x')).toBe(401);
        expect(await status(gw, '/all/x', { headers: { 'X-Token': 't1' } })).toBe(200);
      },
    );
  });

  it('a JSON config file (JSON is valid YAML)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gatewaykit-json-'));
    try {
      const file = join(dir, 'gateway.json');
      await writeFile(
        file,
        JSON.stringify({ gateway: { port: 8080 }, routes: [{ path: '/j', methods: ['GET'], upstream: { url: up.url } }] }),
      );
      const { config } = await loadConfigFile(file);
      const gateway = await startGateway(config, { port: 0 });
      try {
        expect(await status(gateway, '/j/x')).toBe(200);
      } finally {
        await gateway.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('YAML anchors and merge keys, with an "x-" key to hold them', async () => {
    const yaml = `
x-defaults: &defaults
  methods: ["GET"]
  upstream: { url: "${up.url}" }
  rate_limit: { requests: 5, window: "1s" }
routes:
  - <<: *defaults
    path: "/a"
  - <<: *defaults
    path: "/b"
    strip_prefix: true
`;
    expect(parseConfig(yaml).warnings).toEqual([]);
    await withGateway(yaml, async (gw) => {
      expect(await status(gw, '/a/x')).toBe(200);
      expect(await status(gw, '/b/x')).toBe(200);
    });
  });

  it('flexible value forms: lowercase methods, Go-style durations, numeric header values', () => {
    const { config } = parseConfig(`
gateway: { global_timeout: "1m30s" }
routes:
  - path: "/f/"
    methods: ["get", "Post"]
    upstream: { url: "${up.url}", timeout: "1.5s" }
    request_transform: { headers: { add: { X-Version: 2 } } }
`);
    const route = config.routes[0];
    expect(config.globalTimeoutMs).toBe(90_000);
    expect(route).toMatchObject({ path: '/f', methods: ['GET', 'POST'] });
    expect(route?.upstream.timeoutMs).toBe(1_500);
    expect(route?.requestTransform?.headers?.add).toEqual({ 'X-Version': '2' });
  });

  it('weights without an explicit balance use weighted round robin', async () => {
    const { config } = parseConfig(`
routes:
  - path: "/w"
    methods: ["GET"]
    upstream: { targets: [{ url: "${up.url}", weight: 3 }, { url: "${up2.url}" }] }
`);
    expect(config.routes[0]?.upstream.balance).toBe('weighted_round_robin');
  });
});

describe('combinations that are rejected', () => {
  const route = (fields: string) => `routes:\n  - path: "/a"\n    methods: ["GET"]\n${fields}`;
  const withUrl = (extra = '') => route(`    upstream: { url: "http://x"${extra} }\n`);

  it.each<[string, string, string]>([
    ['both url and targets', route('    upstream: { url: "http://x", targets: [{ url: "http://y" }] }\n'), 'set either "url" or "targets", not both'],
    ['neither url nor targets', route('    upstream: { timeout: "1s" }\n'), 'must set "url" or "targets"'],
    [
      'a route path with ".."',
      'routes: [{ path: "/a/../b", methods: [GET], upstream: { url: "http://x" } }]',
      'must be written in normalized form ("/b")',
    ],
    [
      'a route path with "//"',
      'routes: [{ path: "/a//b", methods: [GET], upstream: { url: "http://x" } }]',
      'must be written in normalized form ("/a/b")',
    ],
    [
      'a route path with an encoded slash',
      'routes: [{ path: "/a%2Fb", methods: [GET], upstream: { url: "http://x" } }]',
      'must not contain encoded slashes',
    ],
    [
      'a route path with a query string',
      'routes: [{ path: "/a?x=1", methods: [GET], upstream: { url: "http://x" } }]',
      'must be a path only, without "?" or "#"',
    ],
    [
      'two routes that are the same once a trailing slash is removed',
      'routes: [{ path: "/a", methods: [GET], upstream: { url: "http://x" } }, { path: "/a/", methods: [GET], upstream: { url: "http://y" } }]',
      'duplicates routes[0].path "/a"',
    ],
    ['an upstream URL with a query string', route('    upstream: { url: "http://x/?token=1" }\n'), 'must not include a query string'],
    ['an upstream URL with credentials', route('    upstream: { url: "http://user:pass@x" }\n'), 'must not include credentials'],
    ['a timeout longer than a Node timer allows', withUrl(', timeout: "720h"'), 'must be at most 24 days'],
    [
      'a global timeout longer than a Node timer allows',
      'gateway: { global_timeout: "25d" }',
      'gateway.global_timeout: invalid duration', // "d" isn't a unit; days are written in hours
    ],
    [
      'a global timeout of 600 hours',
      'gateway: { global_timeout: "600h" }',
      'gateway.global_timeout: must be at most 24 days',
    ],
    ['a retry delay longer than a Node timer allows', withUrl() + '    retry: { attempts: 2, initial_delay: "600h" }\n', 'must be at most 24 days'],
    [
      'a health check interval longer than a Node timer allows',
      withUrl() + '    health_check: { path: "/h", interval: "600h" }\n',
      'must be at most 24 days',
    ],
    ['retry with an empty "on" list', withUrl() + '    retry: { attempts: 3, on: [] }\n', 'nothing would ever be retried'],
    ['auth with a header name containing a space', withUrl() + '    auth: { type: "api_key", header: "X API Key", keys: ["k"] }\n', 'not a valid HTTP header name'],
    ['auth with an empty key list', withUrl() + '    auth: { type: "api_key", keys: [] }\n', 'must not be empty'],
    [
      'a header value with a line break (header injection)',
      withUrl() + '    request_transform: { headers: { add: { X-A: "a\\r\\nX-Evil: 1" } } }\n',
      'must not contain line breaks',
    ],
    [
      'a header to remove with an invalid name',
      withUrl() + '    response_transform: { headers: { remove: ["Bad Header"] } }\n',
      'not a valid HTTP header name',
    ],
    ['a circuit breaker missing its cooldown', withUrl() + '    circuit_breaker: { threshold: 3, window: "1m" }\n', 'circuit_breaker.cooldown: is required'],
    ['a rate limit missing its window', withUrl() + '    rate_limit: { requests: 3 }\n', 'rate_limit.window: is required'],
  ])('%s', (_label, yaml, expected) => {
    const issues = issuesOf(yaml);
    expect(issues.some((issue) => issue.includes(expected)), issues.join('\n')).toBe(true);
  });
});

describe('combinations that load with a warning', () => {
  it.each<[string, string, string]>([
    [
      'target weights with round_robin',
      'routes: [{ path: "/a", methods: [GET], upstream: { targets: [{ url: "http://x", weight: 3 }, { url: "http://y" }], balance: round_robin } }]',
      'target weights are ignored with balance "round_robin"',
    ],
    [
      'balance with a single url',
      'routes: [{ path: "/a", methods: [GET], upstream: { url: "http://x", balance: weighted_round_robin } }]',
      'has no effect with a single "url"',
    ],
    [
      'a route at /health',
      'routes: [{ path: "/health", methods: [GET], upstream: { url: "http://x" } }]',
      `built-in health endpoint`,
    ],
    ['port 0', 'gateway: { port: 0 }\nroutes: [{ path: "/a", methods: [GET], upstream: { url: "http://x" } }]', '0 means "any free port"'],
    [
      'an unknown key (probably a typo)',
      'routes: [{ path: "/a", methods: [GET], strip_prefx: true, upstream: { url: "http://x" } }]',
      'routes[0].strip_prefx: unknown key (ignored)',
    ],
  ])('%s', (_label, yaml, expected) => {
    const { warnings } = parseConfig(yaml);
    expect(warnings.some((w) => w.includes(expected)), warnings.join('\n')).toBe(true);
  });

  it('a route at /health only receives paths below /health', async () => {
    await withGateway(
      `routes: [{ path: "/health", methods: ["GET"], upstream: { url: "${up.url}" } }]`,
      async (gw) => {
        expect(await (await fetch(`${gw.url}/health`)).json()).toMatchObject({ status: 'healthy' }); // built-in
        expect((await fetch(`${gw.url}/health/deep`)).headers.get('x-upstream')).toBe('one'); // the route
      },
    );
  });
});

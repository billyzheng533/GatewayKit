import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfigFile, parseConfig } from '../src/config/load.js';

function issuesOf(yaml: string): string[] {
  try {
    parseConfig(yaml);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected config to be rejected');
}

describe('loading the example gateway.yaml', () => {
  it('parses and normalizes every route', async () => {
    const { config, warnings } = await loadConfigFile('gateway.yaml');

    expect(warnings).toEqual([]);
    expect(config.port).toBe(8080);
    expect(config.globalTimeoutMs).toBe(30_000);
    expect(config.routes.map((r) => r.path)).toEqual([
      '/api/users',
      '/api/orders',
      '/api/products',
      '/api/legacy',
      '/api/internal',
    ]);

    const [users, orders, products, legacy, internal] = config.routes;
    expect(users?.rateLimit).toEqual({ requests: 30, windowMs: 60_000, strategy: 'sliding_window', per: 'ip' });
    expect(users?.upstream.timeoutMs).toBe(30_000); // falls back to global_timeout

    expect(orders?.upstream.timeoutMs).toBe(5_000);
    expect(orders?.retry).toEqual({ attempts: 3, backoff: 'exponential', initialDelayMs: 1_000, onStatus: [502, 503, 504] });

    expect(products?.upstream.targets.map((t) => [t.url.href, t.weight])).toEqual([
      ['http://localhost:3003/', 3],
      ['http://localhost:3004/', 1],
    ]);
    expect(products?.upstream.balance).toBe('weighted_round_robin');
    // No route-level rate_limit: inherits global_rate_limit.
    expect(products?.rateLimit).toEqual({ requests: 100, windowMs: 60_000, strategy: 'fixed_window', per: 'ip' });

    expect(legacy?.requestTransform?.bodyMapping).toMatchObject({ 'user.id': 'userId', 'meta.source': '$literal:gateway' });
    expect(legacy?.responseTransform?.headers?.remove).toEqual(['Server', 'X-Powered-By']);

    expect(internal?.auth).toEqual({ type: 'api_key', header: 'X-API-Key', keys: ['sk_live_abc123', 'sk_live_def456'] });
    expect(internal?.circuitBreaker).toEqual({ threshold: 5, windowMs: 60_000, cooldownMs: 30_000 });
  });
});

describe('defaults', () => {
  it('applies defaults for optional fields', () => {
    const { config } = parseConfig(`
routes:
  - path: "/svc/"
    methods: ["get"]
    upstream:
      url: "http://localhost:9000"
`);
    expect(config.port).toBe(8080);
    expect(config.globalRateLimit).toBeNull();
    const route = config.routes[0];
    expect(route).toMatchObject({ path: '/svc', methods: ['GET'], stripPrefix: false, rateLimit: null });
    expect(route?.upstream).toMatchObject({ balance: 'round_robin', timeoutMs: 30_000 });
  });

  it('warns about unknown keys instead of failing', () => {
    const { warnings } = parseConfig(`
routes:
  - path: "/svc"
    methods: ["GET"]
    strip_prefx: true
    upstream: { url: "http://localhost:9000" }
`);
    expect(warnings).toEqual(['routes[0].strip_prefx: unknown key (ignored)']);
  });
});

describe('rejecting malformed config', () => {
  it('reports YAML syntax errors', () => {
    expect(issuesOf('routes: [unclosed')[0]).toMatch(/YAML syntax error/);
  });

  it('reports every problem at once, with its location', () => {
    const issues = issuesOf(`
gateway:
  port: "eighty"
  global_timeout: 30
routes:
  - path: "api/users"
    methods: []
    upstream:
      url: "ftp://files"
    rate_limit:
      requests: 0
      window: "1 minute"
      strategy: "token_bucket"
`);
    expect(issues).toEqual([
      'gateway.port: must be an integer between 0 and 65535',
      'gateway.global_timeout: must be a duration string such as "30s"',
      'routes[0].path: must start with "/"',
      'routes[0].methods: must not be empty',
      'routes[0].upstream.url: must be an http:// or https:// URL, got "ftp://files"',
      'routes[0].rate_limit.requests: must be an integer >= 1',
      expect.stringMatching(/^routes\[0\]\.rate_limit\.window: invalid duration "1 minute"/),
      'routes[0].rate_limit.strategy: must be one of "fixed_window", "sliding_window"',
    ]);
  });

  it('requires an upstream url or targets, but not both', () => {
    expect(issuesOf('routes: [{ path: "/a", methods: [GET], upstream: {} }]')).toEqual([
      'routes[0].upstream: must set "url" or "targets"',
    ]);
    expect(
      issuesOf('routes: [{ path: "/a", methods: [GET], upstream: { url: "http://x", targets: [{ url: "http://y" }] } }]'),
    ).toEqual(['routes[0].upstream: set either "url" or "targets", not both']);
  });

  it('rejects unknown HTTP methods and duplicate route paths', () => {
    const issues = issuesOf(`
routes:
  - { path: "/a", methods: ["GET", "FETCH"], upstream: { url: "http://x" } }
  - { path: "/a/", methods: ["GET"], upstream: { url: "http://y" } }
`);
    expect(issues).toEqual([
      'routes[0].methods[1]: unknown HTTP method "FETCH"',
      'routes[1].path: duplicates routes[0].path "/a"',
    ]);
  });

  it('reports a missing config file clearly', async () => {
    await expect(loadConfigFile('does-not-exist.yaml')).rejects.toThrow(/cannot read config file "does-not-exist.yaml"/);
  });
});

/** Builds a one-route config (YAML accepts JSON) with fields overridden or removed (undefined). */
const BASE_ROUTE = { path: '/a', methods: ['GET'], upstream: { url: 'http://localhost:9000' } };
const routeConfig = (overrides: Record<string, unknown>) => JSON.stringify({ routes: [{ ...BASE_ROUTE, ...overrides }] });

describe('rejecting each kind of invalid field', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['missing path', { path: undefined }, 'routes[0].path: is required'],
    ['empty path', { path: '' }, 'routes[0].path: must be a non-empty string'],
    ['methods not a list', { methods: 'GET' }, 'routes[0].methods: must be a list'],
    ['missing methods', { methods: undefined }, 'routes[0].methods: is required'],
    ['strip_prefix not a boolean', { strip_prefix: 'yes' }, 'routes[0].strip_prefix: must be true or false'],
    ['missing upstream', { upstream: undefined }, 'routes[0].upstream: is required'],
    ['empty upstream url', { upstream: { url: '' } }, 'routes[0].upstream.url: must be a non-empty string'],
    ['malformed upstream url', { upstream: { url: 'not a url' } }, 'routes[0].upstream.url: is not a valid URL: "not a url"'],
    ['empty targets list', { upstream: { targets: [] } }, 'routes[0].upstream.targets: must contain at least one target'],
    [
      'target weight below 1',
      { upstream: { targets: [{ url: 'http://x', weight: 0 }] } },
      'routes[0].upstream.targets[0].weight: must be an integer >= 1',
    ],
    [
      'unknown balance strategy',
      { upstream: { url: 'http://x', balance: 'random' } },
      'routes[0].upstream.balance: must be one of "round_robin", "weighted_round_robin"',
    ],
    ['zero timeout', { upstream: { url: 'http://x', timeout: '0s' } }, 'routes[0].upstream.timeout: must be greater than zero'],
    ['rate limit without requests', { rate_limit: { window: '1s' } }, 'routes[0].rate_limit.requests: is required'],
    ['rate limit without window', { rate_limit: { requests: 1 } }, 'routes[0].rate_limit.window: is required'],
    [
      'numeric window',
      { rate_limit: { requests: 1, window: 30 } },
      'routes[0].rate_limit.window: must be a duration string such as "30s"',
    ],
    [
      'unknown rate limit key',
      { rate_limit: { requests: 1, window: '1s', per: 'user' } },
      'routes[0].rate_limit.per: must be one of "ip", "global"',
    ],
    ['retry attempts below 1', { retry: { attempts: 0 } }, 'routes[0].retry.attempts: must be an integer >= 1'],
    ['unknown backoff', { retry: { attempts: 2, backoff: 'linear' } }, 'routes[0].retry.backoff: must be one of "fixed", "exponential"'],
    ['retry.on not a list', { retry: { attempts: 2, on: 503 } }, 'routes[0].retry.on: must be a list'],
    [
      'retry.on with a non-HTTP status',
      { retry: { attempts: 2, on: [700] } },
      'routes[0].retry.on[0]: must be an integer between 100 and 599',
    ],
    ['health check path without "/"', { health_check: { path: 'healthz' } }, 'routes[0].health_check.path: must start with "/"'],
    [
      'header value that is not a string',
      { request_transform: { headers: { add: { 'X-A': { nested: true } } } } },
      'routes[0].request_transform.headers.add.X-A: must be a string',
    ],
    [
      'body mapping source that is not a string',
      { request_transform: { body: { mapping: { 'user.id': 5 } } } },
      'routes[0].request_transform.body.mapping.user.id: must be a non-empty string',
    ],
    [
      'envelope that is not a mapping',
      { response_transform: { body: { envelope: 'data' } } },
      'routes[0].response_transform.body.envelope: must be a mapping',
    ],
    ['unknown auth type', { auth: { type: 'oauth', keys: ['k'] } }, 'routes[0].auth.type: must be one of "api_key"'],
    ['auth without keys', { auth: { type: 'api_key' } }, 'routes[0].auth.keys: is required'],
    ['auth with an empty key list', { auth: { type: 'api_key', keys: [] } }, 'routes[0].auth.keys: must not be empty'],
    ['circuit breaker without threshold', { circuit_breaker: { window: '1s', cooldown: '1s' } }, 'routes[0].circuit_breaker.threshold: is required'],
    [
      'circuit breaker with an invalid cooldown',
      { circuit_breaker: { threshold: 1, window: '1s', cooldown: 'forever' } },
      'routes[0].circuit_breaker.cooldown: invalid duration "forever"',
    ],
  ])('%s', (_label, overrides, expected) => {
    const issues = issuesOf(routeConfig(overrides));
    expect(issues.some((issue) => issue.startsWith(expected))).toBe(true);
  });

  it.each<[string, string, string]>([
    ['an empty file', '', 'config: must be a mapping'],
    ['a top-level list', '- a\n- b', 'config: must be a mapping'],
    ['gateway that is not a mapping', 'gateway: "fast"', 'gateway: must be a mapping'],
    ['routes that is not a list', 'routes: { path: "/a" }', 'routes: must be a list'],
    ['a route that is not a mapping', 'routes: ["/a"]', 'routes[0]: must be a mapping'],
  ])('rejects %s', (_label, yaml, expected) => {
    expect(issuesOf(yaml)).toContain(expected);
  });
});

describe('defaults for optional feature settings', () => {
  it('fills in retry, health check, auth, target weight and header value defaults', () => {
    const { config } = parseConfig(
      routeConfig({
        upstream: { targets: [{ url: 'http://a' }, { url: 'http://b', weight: 2 }] },
        retry: { attempts: 2 },
        health_check: { path: '/healthz' },
        auth: { type: 'api_key', keys: ['k'] },
        request_transform: { headers: { add: { 'X-Version': 2, 'X-Flag': true } } },
      }),
    );
    const route = config.routes[0];
    expect(route?.upstream.targets.map((t) => t.weight)).toEqual([1, 2]);
    expect(route?.retry).toEqual({ attempts: 2, backoff: 'fixed', initialDelayMs: 100, onStatus: [502, 503, 504] });
    expect(route?.healthCheck).toEqual({ path: '/healthz', intervalMs: 30_000, unhealthyThreshold: 3 });
    expect(route?.auth?.header).toBe('X-API-Key');
    expect(route?.requestTransform?.headers?.add).toEqual({ 'X-Version': '2', 'X-Flag': 'true' });
  });

  it('warns when there are no routes', () => {
    expect(parseConfig('gateway: { port: 8080 }').warnings).toEqual([
      'routes: no routes configured; every request except /health will return 404',
    ]);
  });
});

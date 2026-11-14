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

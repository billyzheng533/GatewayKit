import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { unenforcedFeatureWarnings } from '../src/features/index.js';

describe('unenforcedFeatureWarnings', () => {
  it('warns about each configured feature that is not built yet', async () => {
    const { config } = parseConfig(`
routes:
  - path: "/api/products"
    methods: ["GET"]
    upstream:
      targets: [{ url: "http://a" }, { url: "http://b" }]
    health_check: { path: "/healthz" }
  - path: "/api/legacy"
    methods: ["GET"]
    upstream: { url: "http://c" }
    request_transform: { headers: { add: { X-A: "1" } }, body: { mapping: { user.id: "userId" } } }
    response_transform: { headers: { remove: ["Server"] }, body: { envelope: { data: "$body" } } }
`);
    // Header transforms are implemented; only the body parts are reported.
    expect(unenforcedFeatureWarnings(config)).toEqual([
      'route /api/legacy: "request_transform.body" is configured but not implemented yet; it is ignored',
      'route /api/legacy: "response_transform.body" is configured but not implemented yet; it is ignored',
    ]);
  });

  it('says nothing about features that are implemented', () => {
    const { config } = parseConfig(`
gateway:
  global_rate_limit: { requests: 10, window: "1s" }
routes:
  - path: "/api/internal"
    methods: ["GET"]
    upstream: { url: "http://a" }
    auth: { type: "api_key", keys: ["k"] }
    retry: { attempts: 2 }
    circuit_breaker: { threshold: 1, window: "1s", cooldown: "1s" }
    request_transform: { headers: { remove: ["X-Debug"] } }
    response_transform: { headers: { add: { X-Served-By: "gk" } } }
`);
    expect(unenforcedFeatureWarnings(config)).toEqual([]);
  });
});

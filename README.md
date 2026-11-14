# GatewayKit

A lightweight, config-driven API gateway written in TypeScript on Node's built-in `http` module.
It reads a YAML config file (see [`gateway.yaml`](gateway.yaml)) and routes, filters and
proxies requests to upstream services accordingly.

The design and the reasoning behind it are in [DECISIONS.md](DECISIONS.md).

## Prerequisites

- **Node.js 20.3 or newer** (developed on Node 24). Check with `node --version`.
- npm (comes with Node).

Runtime dependency: [`yaml`](https://www.npmjs.com/package/yaml) for parsing the config. The proxy, routing
and HTTP handling use only Node's standard library. Dev dependencies: TypeScript, `tsx` (runs TypeScript
directly), Vitest (tests) and `@vitest/coverage-v8` (coverage reports).

## Setup

```bash
npm install
```

## Running the gateway

The config file path is passed as the first argument, or through the `GATEWAY_CONFIG` environment variable:

```bash
npm start -- gateway.yaml
```

```bash
GATEWAY_CONFIG=gateway.yaml npm start
```

The gateway listens on `gateway.port` from the config (8080 in the example). It logs JSON lines: one per
request to stdout, and warnings to stderr. Warnings at startup cover unknown config keys and configured
features that aren't implemented yet; at runtime they cover retries, circuit breaker changes, upstream
failures and rejected malformed requests. Bodies, headers and query strings are never logged.

If the config is malformed, the gateway refuses to start and lists every problem it found:

```text
Invalid gateway config:
  - routes[0].path: must start with "/"
  - routes[0].rate_limit.window: invalid duration "1 minute" (expected a number with a unit, e.g. "500ms", "30s", "5m", "1h")
```

### Trying it against mock upstreams

The example config points at `localhost:3001`–`3006`. Start mock services on those ports in one terminal:

```bash
npm run mock
```

Then start the gateway in another terminal and send it requests:

```bash
npm start -- gateway.yaml
```

```bash
curl -i "localhost:8080/health"
```

```bash
curl -i "localhost:8080/api/users/42?expand=orders"
```

```bash
curl -i "localhost:8080/api/products/123"
```

```bash
curl -i -X POST "localhost:8080/api/products"
```

The mock echoes each request back as JSON (method, path, query, headers, body), so you can see exactly what
the gateway forwarded. It also has endpoints for failure cases, under any path prefix:

| Endpoint | Behavior |
| --- | --- |
| `/status/<code>` | Responds with that HTTP status |
| `/slow?ms=<n>` | Waits `n` ms, then echoes |
| `/flaky?fail=<n>&key=<k>` | Returns 503 for the first `n` calls with that key (default `default`), then echoes |
| `/healthz` | Health check endpoint, returns 200 |
| `/reset` | Drops the connection without responding |
| `/truncate` | Sends headers and part of the body, then drops the connection |
| `/garbage` | Answers with bytes that aren't HTTP |

For example, this shows the 504 after the 30s global timeout:

```bash
curl -i "localhost:8080/api/users/slow?ms=40000"
```

URLs are quoted throughout: in zsh (the macOS default shell), an unquoted `?` is a filename wildcard and
the command fails with `no matches found`.

**Retry:** `/api/orders` retries 503s with exponential backoff (1s, then 2s). This fails twice, then
succeeds about 3 seconds later; the gateway's log shows each retry. The mock counts failures per `key`,
so change the key (or restart `npm run mock`) to see it again:

```bash
curl -i "localhost:8080/api/orders/flaky?fail=2&key=demo"
```

**Auth:** `/api/internal` needs one of the configured keys in `X-API-Key`. Without one you get 401:

```bash
curl -i "localhost:8080/api/internal/stats"
```

```bash
curl -i -H 'X-API-Key: sk_live_abc123' "localhost:8080/api/internal/stats"
```

**Circuit breaker:** `/api/internal` opens after 5 failures within 60s. Send 5 failing requests, and the
6th is rejected with 503 `{"error":"service_unavailable","retry_after":30}` without reaching the upstream.
The route also requires an API key, so the requests send one. After this, `/api/internal` answers 503 for
30 seconds, then lets a trial request through:

```bash
for i in 1 2 3 4 5 6; do curl -s -H 'X-API-Key: sk_live_abc123' "localhost:8080/api/internal/status/500"; echo; done
```

**Rate limiting:** `/api/orders` allows 10 requests per 10 seconds per client. The 11th and 12th get 429
with `{"error":"rate_limited",...,"retry_after":10}`, and every response carries `X-RateLimit-*` headers.
If you ran the retry example in the last 10 seconds, it used one of the 10, so the 10th gets 429 too:

```bash
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' "localhost:8080/api/orders/$i"; done; echo
```

## Running the tests

After `npm install`, the whole suite runs with one command:

```bash
npm test
```

**It's self-contained.** You don't need to start the mock servers or the gateway, and nothing needs to be
running on port 8080. Each integration test file starts its own mock upstream servers (`mock/upstream.ts`)
and its own gateway, both on random free ports, and shuts them down afterwards. The CLI tests start the
real gateway as a separate process. A full run takes about 2 seconds.

Type-check with `npm run typecheck`, re-run tests on every change with `npm run test:watch`, or see
which lines are covered with `npm run coverage`.

Every implemented feature has tests for both what should work and what should fail:

| Feature | Success cases | Failure cases | Test files |
| --- | --- | --- | --- |
| Config loading | Example config, defaults for every optional field | YAML syntax errors, ~35 kinds of invalid field, missing file; every error listed with its location; unknown keys warned | `config`, `duration` |
| Starting the gateway | Config from an argument or `GATEWAY_CONFIG`; exits 0 on SIGTERM | Invalid or missing config exits 1; no config exits 2 with usage | `cli` |
| `/health` | 200 with integer uptime; HEAD; wins over a catch-all `/` route | 405 for other methods | `gateway` |
| Routing and methods | Prefix match, most specific route wins, catch-all | 404 for no match or a partial prefix (`/api/usersX`); 405 with `Allow` | `router`, `gateway` |
| Path normalization | `.`, `..` and `%2e%2e` resolved; repeated slashes collapsed | 400 for climbing above `/`, `%2F`, `%5C`, `\`, `%00`; prefix-escape attempts | `path`, `pathSecurity` |
| Request limits | A long query string within 16 KB is forwarded unchanged | 431 for an oversized query string, header or set of headers; 400 for malformed HTTP; neither reaches the upstream | `requestLimits` |
| Proxying | Method, path, query, body and headers forwarded; `X-Forwarded-*`; request IDs; 50 concurrent requests | Hop-by-hop headers dropped; 413 for oversized bodies; upstream reset or non-HTTP reply gives 502; upstream dying mid-response; client disconnects; an internal bug gives 500 and the gateway keeps serving | `headers`, `gateway`, `failures` |
| `strip_prefix` | Nested paths, bare prefix, query kept, upstream base path, `false` keeps path | No stripping on a partial prefix | `stripPrefix` |
| Timeouts | Route and global timeouts | 504 for a slow or hanging upstream, without waiting for it | `gateway`, `failures` |
| Retry | Recovers after failures; fixed and exponential timing; PUT retried with its body | Gives up after `attempts`; statuses not in `on` not retried; POST not duplicated; stops when the client disconnects | `resilience`, `resilienceFailures` |
| Circuit breaker | Stays closed on success and 4xx; recovers through a half-open trial | Opens on 5xx, unreachable and timed-out upstreams; failed trial re-opens; 401s don't count | `circuitBreaker`, `resilience`, `resilienceFailures`, `failures`, `auth` |
| Rate limiting | Admits the limit; headers; windows reset; inherited global limit | 429 with `retry_after`; 50 simultaneous requests against a limit of 10; fake `X-Forwarded-For` ignored; per IP vs. global | `limiters`, `rateLimit` |
| Auth | Every configured key; custom header name; key not forwarded | Missing, wrong, empty, partial, wrong-case and duplicate keys; `..` bypass attempt; failed guesses rate limited | `auth` |
| Startup warnings | Silent for implemented features | Warns for each configured feature that isn't built yet | `features` |

Files are in `test/` and named `<name>.test.ts`. Unit tests use a fake clock where time matters, so
windows and cooldowns are tested without waiting. Integration tests talk to a real gateway over HTTP.

## Request limits

These protect the gateway's memory and match AWS API Gateway's defaults closely. They aren't
configurable, since the config schema has no field for them.

| Limit | Value | Over the limit |
| --- | --- | --- |
| Request body | 10 MB (same as AWS API Gateway) | 413 `{"error":"payload_too_large",...}` |
| Request line + headers, including the query string | 16 KB (AWS HTTP APIs: 10 KB) | 431 `{"error":"request_header_too_large",...}` |
| Malformed HTTP | | 400 `{"error":"bad_request",...}` |

None of these requests reach an upstream.

## Config feature checklist

| Feature | Status |
| --- | --- |
| Load config from CLI argument or `GATEWAY_CONFIG` | ✅ |
| Full schema validation with all errors reported; unknown keys warned | ✅ |
| `gateway.port` | ✅ |
| `GET /health` (always available, takes precedence over routes) | ✅ |
| Route matching by path prefix (segment boundary, most specific wins), 404 otherwise | ✅ |
| `methods` filtering, 405 with `Allow` header | ✅ |
| Path normalization: `..`/`%2e%2e` resolved before routing; encoded slashes, backslashes and climbing above `/` rejected (400) | ✅ |
| Proxying (method, path, query, headers, body; streamed responses) | ✅ |
| `strip_prefix` | ✅ |
| `global_timeout` / `upstream.timeout` (504 on timeout, 502 when unreachable) | ✅ |
| `global_rate_limit` / `rate_limit` (`fixed_window`, `sliding_window`, `per: ip / global`) | ✅ |
| `retry` (`fixed` / `exponential` backoff, `on` status codes; POST only retried if never sent) | ✅ |
| `auth` (`api_key`: constant-time key check, 401, key not forwarded upstream) | ✅ |
| `circuit_breaker` (`threshold` in `window`, `cooldown`, half-open trial, 503 with `retry_after`) | ✅ |
| `upstream.targets` load balancing (`round_robin`, `weighted_round_robin`) | ⏳ uses first target |
| `health_check` | ⏳ parsed, not enforced |
| `request_transform` (headers, body mapping) | ⏳ parsed, not enforced |
| `response_transform` (headers, body envelope) | ⏳ parsed, not enforced |

Features marked ⏳ are validated at startup, and the gateway logs a warning for each route that configures
one, so it never silently pretends to enforce something it doesn't.

## Project layout

```text
src/
  index.ts            CLI entry point: load config, start server, graceful shutdown
  server.ts           HTTP server: /health, routing, 404/405, body reading, writing responses
  router.ts           Prefix matching and strip_prefix path rewriting
  path.ts             Path normalization (resolving "..", rejecting ambiguous paths) before routing
  pipeline.ts         Request/response types and middleware composition
  errors.ts           GatewayError and the errors that map to 4xx/5xx responses
  logger.ts           JSON-lines logger
  config/             YAML loading, validation and normalized config types
  features/           Feature registry: where per-route middleware plugs in, in pipeline order:
    rateLimit/          Fixed and sliding window limiters
    auth/               API key check
    retry/              Retry with backoff
    circuitBreaker/     Breaker state machine and middleware
  proxy/              Upstream HTTP client, hop-by-hop header handling, terminal upstream handler
mock/                 Mock upstream server (used by tests and `npm run mock`)
test/                 Unit and integration tests
```

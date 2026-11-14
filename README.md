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
directly) and Vitest (tests).

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

The gateway listens on `gateway.port` from the config (8080 in the example). It logs one JSON line per
request to stdout, and warnings (unknown config keys, configured features that aren't implemented yet) to
stderr at startup.

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
curl -i localhost:8080/health
```

```bash
curl -i localhost:8080/api/users/42?expand=orders
```

```bash
curl -i localhost:8080/api/products/123
```

```bash
curl -i -X POST localhost:8080/api/products
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

For example, `curl -i localhost:8080/api/users/slow?ms=40000` shows the 504 after the 30s global timeout.

**Retry:** `/api/orders` retries 503s with exponential backoff (1s, then 2s). This fails twice, then
succeeds about 3 seconds later; the gateway's log shows each retry:

```bash
curl -i "localhost:8080/api/orders/flaky?fail=2&key=demo"
```

**Circuit breaker:** `/api/internal` opens after 5 failures within 60s. Send 5 failing requests, and the
6th is rejected with 503 `{"error":"service_unavailable","retry_after":30}` without reaching the upstream:

```bash
for i in 1 2 3 4 5 6; do curl -s localhost:8080/api/internal/status/500; echo; done
```

**Rate limiting:** `/api/orders` allows 10 requests per 10 seconds per client. The 11th and 12th get 429
with `{"error":"rate_limited",...,"retry_after":10}`, and every response carries `X-RateLimit-*` headers:

```bash
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' localhost:8080/api/orders/$i; done; echo
```

## Running the tests

After `npm install`, the whole suite runs with one command:

```bash
npm test
```

**It's self-contained.** You don't need to start the mock servers or the gateway, and nothing needs to be
running on port 8080. Each test file starts its own mock upstream servers (`mock/upstream.ts`) and its own
gateway, both on random free ports, and shuts them down afterwards. The CLI tests start the real gateway
as a separate process. A full run takes about 2 seconds.

Type-check with `npm run typecheck`, or re-run tests on every change with `npm run test:watch`.

| File | Kind | What it covers |
| --- | --- | --- |
| `test/config.test.ts` | Unit | Loading `gateway.yaml`, defaults, and rejecting malformed configs with every error listed |
| `test/duration.test.ts` | Unit | Duration strings (`"500ms"`, `"30s"`, ...) and invalid ones |
| `test/router.test.ts` | Unit | Prefix matching, most-specific-route wins, path rewriting |
| `test/circuitBreaker.test.ts` | Unit | Breaker state machine with a fake clock: opening, cooldown, half-open trial |
| `test/limiters.test.ts` | Unit | Fixed and sliding window algorithms with a fake clock |
| `test/gateway.test.ts` | Integration | `/health`, proxying, 404, 405, headers, 502, 504, 413, 50 concurrent requests |
| `test/stripPrefix.test.ts` | Integration | Exactly which path and query string the upstream receives |
| `test/resilience.test.ts` | Integration | Retry (recovery, giving up, backoff, no duplicate POSTs) and circuit breaker |
| `test/rateLimit.test.ts` | Integration | 429s and headers, 50 simultaneous requests, window resets, per IP vs. global, inherited limits |
| `test/failures.test.ts` | Integration | Upstreams that reset, send garbage, die mid-response, hang, or restart; clients that disconnect |
| `test/cli.test.ts` | Integration | Starting the real gateway: config from an argument or `GATEWAY_CONFIG`, bad config exits 1, SIGTERM exits 0 |

## Config feature checklist

| Feature | Status |
| --- | --- |
| Load config from CLI argument or `GATEWAY_CONFIG` | ✅ |
| Full schema validation with all errors reported; unknown keys warned | ✅ |
| `gateway.port` | ✅ |
| `GET /health` (always available, takes precedence over routes) | ✅ |
| Route matching by path prefix (segment boundary, most specific wins), 404 otherwise | ✅ |
| `methods` filtering, 405 with `Allow` header | ✅ |
| Proxying (method, path, query, headers, body; streamed responses) | ✅ |
| `strip_prefix` | ✅ |
| `global_timeout` / `upstream.timeout` (504 on timeout, 502 when unreachable) | ✅ |
| `global_rate_limit` / `rate_limit` (`fixed_window`, `sliding_window`, `per: ip / global`) | ✅ |
| `retry` (`fixed` / `exponential` backoff, `on` status codes; POST only retried if never sent) | ✅ |
| `auth` (`api_key`) | ⏳ parsed, not enforced |
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
  pipeline.ts         Request/response types and middleware composition
  errors.ts           GatewayError and the errors that map to 4xx/5xx responses
  logger.ts           JSON-lines logger
  config/             YAML loading, validation and normalized config types
  features/           Feature registry: where per-route middleware (rate limit, retry, ...) plugs in
  proxy/              Upstream HTTP client, hop-by-hop header handling, terminal upstream handler
mock/                 Mock upstream server (used by tests and `npm run mock`)
test/                 Unit and integration tests
```

# Decisions

This document explains what I built, in what order, and why. It's kept up to date as features land; the
commit history shows the same story step by step.

## Language: TypeScript on Node.js

- I'm strongest in TypeScript, and the brief says to use what you're strongest in.
- Node's standard library has everything a proxy needs: `http.createServer`, `http.request` with
  keep-alive agents, streams and `AbortSignal`. The constraint "no proxy frameworks" leaves no gap.
- The single-threaded event loop is an advantage for in-memory state. A rate-limit check-and-increment
  or a circuit-breaker state change runs to completion without being interleaved with another request,
  so 50 simultaneous requests can't race on a counter and no locks are needed. The trade-off is that the
  gateway uses one CPU core; scaling out means several instances, and then in-memory limits become
  per-instance (see "What I'd build next").
- Static types for the config: every feature works with a normalized, typed config object instead of
  raw YAML.

Dependencies are deliberately minimal: `yaml` at runtime; TypeScript, `tsx` and Vitest for development.

## How I prioritized

The evaluation runs the gateway against the example config and then against a different config with the
same schema. So the order is:

1. **Config loading and validation of the whole schema.** Every feature reads config, and "works with
   any valid config" plus "what happens when config is malformed?" both depend on this being solid.
   Validating the *whole* schema up front (even features not yet enforced) means a bad value anywhere
   fails fast with a clear message, and later features only consume already-normalized data.
2. **The non-negotiables:** listen on the configured port, `/health`, prefix routing with 404,
   method filtering with 405, proxying, plus `strip_prefix` and timeouts, which every real request
   depends on. A gateway that gets these wrong is unusable regardless of what else it does.
3. **An extensible pipeline**, so each later feature is a self-contained module rather than edits
   scattered across the server.
4. **Then features, ordered by production value per hour of work** (planned):
   1. Rate limiting: protects upstreams, is configured on almost every route (via
      `global_rate_limit`), and is where the "50 simultaneous requests" concurrency question lives.
   2. Retry and circuit breaker: the resilience story ("what happens when an upstream is down?").
   3. API key auth: small, and an unenforced auth setting is a security problem.
   4. Load balancing with health checks.
   5. Request/response transforms: the most surface area and the most ambiguity in the spec, and the
      least about the gateway's core behavior.

## Architecture

### Request flow

```text
client → server.ts
           ├─ GET /health                 → 200 (built in, before routing)
           ├─ router.match(path)          → 404 if no route
           ├─ method allowed?             → 405 + Allow header if not
           ├─ read body (10 MB cap)       → 413 if larger
           └─ route.handler(ctx)          ← composed once at startup:
                 [feature middleware...] → upstream handler → UpstreamClient → upstream
         ← response written once, by the server
```

### The pipeline (`src/pipeline.ts`, `src/features/index.ts`)

A route's handler is a chain of middleware ending in the upstream handler:

```ts
type Handler = (ctx: RequestContext) => Promise<GatewayResponse>;
type Middleware = (ctx: RequestContext, next: Handler) => Promise<GatewayResponse>;
```

Key choices:

- **Responses are values, not writes to the socket.** Middleware returns a `GatewayResponse`
  (`status`, `headers`, `body`) instead of writing to `res`. This is what lets features compose: a retry
  can call `next` again and discard a 503, a circuit breaker can count failures, a response transform
  can rewrite the body. Only the server writes to the client, once.
- **Pipelines are built once at startup, per route.** Each feature's `create(route)` returns a
  middleware or `null` if the route doesn't use it. Per-route state (counters, breaker state) lives in
  that closure, so there is no shared global state to coordinate and no per-request config lookups.
- **Adding a feature** = parse its config in `config/load.ts`, write one module exporting a
  `Feature`, add it to the `FEATURES` list. The order of that list is the order of the pipeline
  (cheap rejections like auth and rate limiting first).
- **Errors are typed.** Anything that should become a specific response throws a `GatewayError`
  (status + machine-readable code). Upstream failures are distinct types (`UpstreamUnavailableError`
  → 502, `UpstreamTimeoutError` → 504), which retry and the circuit breaker can tell apart. Any other
  exception becomes a logged 500, never a crash.

### Config (`src/config/`)

- The YAML is parsed and validated once into normalized types: durations in milliseconds, defaults
  applied, `url:` and `targets:` both normalized into a list of targets, and per-route fallbacks
  (route `timeout` → `global_timeout`, route `rate_limit` → `global_rate_limit`) resolved. Features
  never look at raw YAML or at gateway-level defaults.
- Validation collects **every** issue with its location (`routes[2].upstream.timeout: ...`) instead of
  stopping at the first, so a broken config can be fixed in one go. The gateway exits non-zero rather
  than starting with a guessed-at config.
- **Unknown keys are warnings, not errors**: a typo like `strip_prefx` is flagged, but a config written
  for a newer version still loads.
- **Configured-but-unimplemented features are logged at startup** for each route, so nobody assumes,
  say, auth is enforced when it isn't.

### Proxying (`src/proxy/`)

- Node's `http`/`https` client with keep-alive agents shared across routes (connection reuse).
- Hop-by-hop headers (`Connection`, `Transfer-Encoding`, ... and anything named in `Connection`) are
  dropped in both directions; `X-Forwarded-For/Host/Proto` are added; `Host` is set to the upstream.
- Every request gets an `X-Request-Id` (the client's, or a new UUID). It is forwarded upstream,
  returned to the client and included in log lines, so one request can be traced across services.
- **Request bodies are buffered** (capped at 10 MB → 413). That's needed to replay a body on retry and
  to rewrite it in `request_transform`. The trade-off is memory per in-flight request and no streaming
  uploads; a production version would buffer only on routes that need it and stream otherwise.
- **Response bodies stream** straight through to the client unless a feature needs to buffer them.
- **Client disconnects cancel the upstream request** via an `AbortSignal`, so abandoned requests don't
  keep upstream work going.
- **Graceful shutdown** on SIGINT/SIGTERM: stop accepting connections, let in-flight requests finish
  (10s grace), then close.

## Calls on ambiguities in the spec

The brief says ambiguities are intentional; these are the calls I made:

| Question | Decision |
| --- | --- |
| How do route paths match? | Prefix match on a path-segment boundary: `/api/users` matches `/api/users` and `/api/users/42`, not `/api/usersettings`. Most specific (longest) prefix wins, regardless of order in the file. Matching is case-sensitive. |
| What if a route is configured at `/health`? | The built-in `/health` always wins, as the spec says it's available "regardless of config". It answers GET and HEAD; other methods get 405. |
| `strip_prefix` on a request for exactly the prefix | `/api/products` forwards as `/`. |
| Upstream URL with a path, e.g. `http://svc/v2` | The forwarded path is appended to it: `/v2/123`. |
| Does `methods: ["GET"]` allow HEAD? | No. Only the listed methods are allowed; the 405 response lists them in `Allow`. |
| What does the timeout cover? | Time until the upstream sends response headers. After that the body streams until it finishes or the client disconnects. A slow body can't change the status code anyway, since headers are already sent. |
| Unreachable upstream vs. slow upstream | 502 `bad_gateway` vs. 504 `gateway_timeout`. Upstream 4xx/5xx responses pass through unchanged. |
| Error response shape | All gateway-generated errors are JSON `{ "error": "<code>", "message": "..." }`, matching the circuit breaker's `{ "error": "service_unavailable", ... }` in the spec. |
| Which client IP is used? | The socket's remote address. `X-Forwarded-For` from the client is passed along but **not** trusted for identifying the client, since a client could set it to dodge per-IP rate limits. Behind a trusted load balancer this would become a config option. |
| Is `gateway.port` used? | Yes; it defaults to 8080 if missing. |
| Unknown config keys | Warning, gateway still starts. Invalid values for known keys: startup fails. |

Planned calls for features not built yet (to be confirmed as they're implemented):

- `retry.attempts: 3` means 3 attempts in total (the first try plus 2 retries). Backoff for attempt
  *n* is `initial_delay` (fixed) or `initial_delay * 2^(n-1)` (exponential).
- `global_rate_limit` inherited by a route gets that route's own counters; it isn't one budget shared
  across all routes.
- Retries count against the route timeout per attempt, and only retry on the configured status codes
  plus connection errors/timeouts.

## Current state

### Build log

1. **Config validation first.** Before any proxying, I built loading and validation of the whole
   config file: every field's type and allowed values are checked, every problem is reported with its
   location, and the gateway refuses to start on an invalid file. Every later step relies on this.
2. **Basic routing, verified end to end against mock upstreams.** Then `/health`, prefix routing,
   404/405, proxying, `strip_prefix` and timeouts. Besides the automated tests, I ran the real gateway
   with the example `gateway.yaml` against the mock servers (`npm run mock`) and checked each behavior
   with `curl`.

**Done and tested:** config loading and validation of the full schema, `/health`, routing, 404, 405,
proxying (headers, body, query string, streaming), `strip_prefix`, per-route and global timeouts, 502/504
handling, request IDs, access logs, graceful shutdown.

**Parsed and validated but not enforced yet:** rate limiting, retry, auth, circuit breaker, load
balancing (all traffic goes to the first target), health checks, request/response transforms. The
gateway logs a startup warning for each.

## Testing approach

- **Unit tests** for pure logic: duration parsing, path matching and rewriting, config validation
  (including the exact error messages for malformed configs).
- **Integration tests** that start real mock upstreams and a real gateway on random ports and talk
  to them over HTTP. They cover the non-negotiables, header forwarding, 502/504, and 50 concurrent
  requests. They build configs through the same YAML loader as production and use different routes,
  ports and timeouts than `gateway.yaml`, which also exercises "works with any valid config".
- The mock upstream (`mock/upstream.ts`) echoes requests and has slow, flaky and fixed-status
  endpoints for failure cases. `npm run mock` starts it on the example config's ports.

## What I'd build next

In order: the remaining features in the priority list above, then:

- Distributed rate limiting (Redis or similar) for running several gateway instances.
- Trusted-proxy config for reading the client IP from `X-Forwarded-For`.
- Streaming request bodies on routes that need neither retry nor body transforms.
- Config hot reload (rebuild pipelines and swap the router atomically).
- Metrics (request counts, latency histograms per route and upstream) alongside the access log.

## How I used AI tools

I used Claude Code as a pair programmer: I shared the requirements and made decisions with Claude,
working out the priorities and the architecture (pipeline of middleware, responses as values, validate
everything up front), then had it draft code and tests in that order. I reviewed and ran everything it produced: type-checked,
ran the tests, and smoke-tested the real gateway against the mock upstreams with `curl` before each
commit.

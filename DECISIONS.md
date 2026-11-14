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
- **Paths are normalized before routing** (`src/path.ts`). Without this, `/api/products/../internal`
  matched the products route, was stripped to `/../internal`, and the products service resolved that to
  `/internal`: a client could reach any path on an upstream, not just the ones under its route. Now
  `.`, `..` and their encoded forms (`%2e%2e`) are resolved first, so that request is routed as
  `/api/internal` and gets that route's rules. Paths that climb above `/` are rejected with 400, as
  are encoded slashes (`%2F`), backslashes and null bytes: upstreams disagree on whether those
  separate path segments, which is the usual way routing gets bypassed. Logs record the path as the
  client sent it, so attempts are visible.
- Every request gets an `X-Request-Id` (the client's, or a new UUID). It is forwarded upstream,
  returned to the client and included in log lines, so one request can be traced across services.
- **Request bodies are buffered** (capped at 10 MB → 413). That's needed to replay a body on retry and
  to rewrite it in `request_transform`. The trade-off is memory per in-flight request and no streaming
  uploads; a production version would buffer only on routes that need it and stream otherwise.
- **Oversized bodies get a clean 413.** Stopping the read mid-upload resets the connection, and
  clients then report a broken pipe instead of the 413 (a test caught this). The gateway sends the 413
  and drains the rest of the body in the background, for at most 5 seconds.
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
| Error response shape | All gateway-generated errors are JSON `{ "error": "<code>", "message": "..." }`. The one exception is the open circuit breaker, which returns exactly the body the spec gives: `{ "error": "service_unavailable", "retry_after": <seconds> }`. |
| Which client IP is used? | The socket's remote address. `X-Forwarded-For` from the client is passed along but **not** trusted for identifying the client, since a client could set it to dodge per-IP rate limits. Behind a trusted load balancer this would become a config option. |
| A path with `..` in it | Resolved before routing, so it's routed to wherever it really points (`/api/products/../internal` → `/api/internal`). Climbing above `/` is a 400, not quietly clamped to `/`. |
| Encoded slashes (`%2F`) in a path | 400. Some upstreams decode them into real slashes and some don't, so allowing them means the gateway and the upstream can disagree about which path was requested. |
| Is `gateway.port` used? | Yes; it defaults to 8080 if missing. |
| Unknown config keys | Warning, gateway still starts. Invalid values for known keys: startup fails. |

### Retry and circuit breaker

| Question | Decision |
| --- | --- |
| What does `attempts: 3` mean? | 3 tries in total: the first request plus 2 retries. |
| How long between retries? | Before retry *n*: `initial_delay` (fixed) or `initial_delay * 2^(n-1)` (exponential). The example's `1s` exponential waits 1s, then 2s. |
| What triggers a retry? | An upstream status listed in `on`, or no response at all: unreachable counts as 502 and timed out as 504, so `on: [502, 503, 504]` covers both. Each attempt gets the route's full timeout. |
| Retry a POST? | Only if the request provably never reached the upstream (connection refused, DNS failure). A POST that got a 503 might already have created an order, and a retry could create a second one. GET, HEAD, OPTIONS, PUT and DELETE are idempotent and are always retried. |
| What counts as a breaker failure? | Unreachable, timed out, or any 5xx from the upstream. 4xx is the client's fault and counts as a success. |
| How is `window` counted? | A sliding window: the breaker opens when `threshold` failures happened within the last `window`. Successes don't reset the count. |
| What happens after `cooldown`? | Half-open: exactly one trial request goes through. Success closes the breaker; failure re-opens it for another full cooldown. Other requests are rejected while the trial is in flight. |
| `retry_after` value | Seconds left in the cooldown, rounded up (at least 1). Also sent as a `Retry-After` header. |
| Breaker per route or per target? | Per route, since that's where the config lives. With load balancing it should become per target, so one bad target doesn't block healthy ones. |
| Retry and breaker on the same route | Retry wraps the breaker. Each attempt counts as a separate breaker result, and once the breaker opens mid-retry, the remaining attempts stop instead of hammering a failing upstream. A breaker rejection is never retried. |

### Rate limiting

| Question | Decision |
| --- | --- |
| Does a route without `rate_limit` share one global budget with other routes? | No. It inherits `global_rate_limit`'s *settings* but gets its own counters, so a busy route can't use up another route's budget. |
| `fixed_window` | Each client's window starts at its first request and admits `requests` until it ends. O(1) memory per client. Known trade-off: up to 2x the limit in a burst straddling a window boundary (there's a test that pins this down). |
| `sliding_window` | A sliding log: the timestamps of admitted requests in the last `window`. Exact, with no boundary burst. Memory is at most `requests` timestamps per client, fine for the limits a gateway config uses; very large limits would call for a sliding window *counter* instead. |
| `per: "ip"` vs `"global"` | Per client socket address, or one budget shared by every client on that route. `X-Forwarded-For` is ignored for this, so a client can't dodge its limit by making up addresses. |
| Do rejected requests count? | No. Only admitted requests use up budget, so a client hammering away while blocked recovers on schedule. Requests refused with 404 or 405 don't count either; rate limiting runs after routing and method checks. |
| What does a client see? | 429 `{ "error": "rate_limited", "message": "...", "retry_after": <seconds> }` with a `Retry-After` header. Every response on a rate-limited route carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds until the budget is full again). |
| 50 simultaneous requests | Exactly `requests` get through. Each check-and-increment is synchronous on Node's single thread, so concurrent requests can't race on a counter. There's a test for exactly this. |
| Memory for many clients | Idle clients' counters are swept once per window, so memory tracks active clients rather than every client ever seen. |
| Where in the pipeline? | Outermost, before retry and the breaker: rejecting an over-limit client is the cheapest thing the gateway can do. Auth will go in front of it. |
| Running several gateway instances | Limits are per instance (in memory). A shared store like Redis would be needed for a cluster-wide limit. |

## Current state

### Build log

1. **Config validation first.** Before any proxying, I built loading and validation of the whole
   config file: every field's type and allowed values are checked, every problem is reported with its
   location, and the gateway refuses to start on an invalid file. Every later step relies on this.
2. **Basic routing, verified end to end against mock upstreams.** Then `/health`, prefix routing,
   404/405, proxying, `strip_prefix` and timeouts. Besides the automated tests, I ran the real gateway
   with the example `gateway.yaml` against the mock servers (`npm run mock`) and checked each behavior
   with `curl`.
3. **Retry and circuit breaker.** I drafted rate limiting next, then pulled the resilience features
   ahead of finishing it: "what happens when an upstream is down?" is the failure mode the gateway
   exists to handle. Verified against the mock's flaky, slow and failing endpoints, and with the example
   config (`/api/orders` retries after 1s and 2s; `/api/internal` opens after 5 failures).
4. **Failure-mode tests.** Before adding more features, I added tests for how things break: upstreams
   that reset, send non-HTTP bytes, die mid-response, hang or restart, and clients that disconnect.
   Writing them exposed a real bug (oversized uploads got a broken pipe instead of a 413), now fixed.
5. **Rate limiting finished.** Tests for both algorithms with a fake clock, then end to end, including
   50 simultaneous requests against a limit of 10. Checked with the example config: `/api/orders` lets
   exactly 10 requests through per 10 seconds.
6. **Path normalization (security fix).** While reviewing how the API could be abused, I found that
   `..` in a path escaped the route prefix (`/api/products/../internal/secret` reached
   `/internal/secret` on the products service). Fixed before adding more features, with tests that
   send raw paths, since `fetch` and `curl` tidy up `..` themselves and would hide the problem.

**Done and tested:** config loading and validation of the full schema, `/health`, routing, 404, 405,
proxying (headers, body, query string, streaming), `strip_prefix`, per-route and global timeouts, 502/504
handling, request IDs, access logs, graceful shutdown, retry with fixed/exponential backoff, circuit
breaker, rate limiting (fixed and sliding window, per IP or global).

**Parsed and validated but not enforced yet:** auth, load balancing (all traffic goes to the first
target), health checks, request/response transforms. The gateway logs a startup warning for each.

## Testing approach

- **Unit tests** for pure logic: duration parsing, path matching and rewriting, config validation
  (including the exact error messages for malformed configs), and the circuit breaker's state machine
  and both rate limiting algorithms with a fake clock, so cooldowns and windows are tested without
  waiting.
- **Rate limiting end to end** (`test/rateLimit.test.ts`): 429s, headers, 50 simultaneous requests,
  window resets, inherited global limits. To get two client IPs from one machine, the per-IP and
  global tests connect over both IPv4 (127.0.0.1) and IPv6 (::1).
- **Integration tests** that start real mock upstreams and a real gateway on random ports and talk
  to them over HTTP. They cover the non-negotiables, header forwarding, 502/504, 50 concurrent
  requests, retry (recovery, giving up, timeouts, backoff timing, no POST duplication) and the circuit
  breaker opening, rejecting without calling the upstream, and recovering. `strip_prefix` has its own
  file checking exactly what path and query string the upstream receives, including edge cases
  (trailing slash, encoded characters, an upstream URL with a base path).
- **Failure tests** (`test/failures.test.ts`) cover how the gateway behaves when things break: an
  upstream that resets the connection, answers with non-HTTP bytes, dies halfway through a response,
  never answers, or restarts on the same port; 50 requests at once to a dead upstream; a client that
  hangs up mid-request (the upstream request is cancelled) or mid-upload. Every test also checks the
  gateway keeps serving afterwards.
- **CLI tests** start the real `src/index.ts` as a separate process: config from an argument or
  `GATEWAY_CONFIG`, refusal to start on an invalid or missing config (exit 1), usage message (exit 2),
  and a clean exit 0 on SIGTERM. They build configs through the same YAML loader as production and use different routes,
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

# Decisions

This document explains what I built, in what order, and why. It's kept up to date as features land; the
commit history shows the same story step by step.

Where to find what:

| Topic | Section |
| --- | --- |
| How I prioritized which config features to implement | [How I prioritized](#how-i-prioritized) |
| Architectural choices and trade-offs | [Architecture choices and trade-offs](#architecture-choices-and-trade-offs), [Security](#security), and the per-feature decision tables |
| What I'd build next with more time | [What I'd build next](#what-id-build-next) |
| Features partially implemented, and their current state | [Current state](#current-state) |
| How I used AI tools | [How I used AI tools](#how-i-used-ai-tools) |

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

Dependencies are deliberately minimal: `yaml` at runtime; TypeScript, `tsx`, Vitest and its coverage
plugin for development.

## How I prioritized

Two things drove the order. First, the evaluation runs the gateway against the example config and then
against a different config with the same schema, so correctness for *any* config came before breadth.
Second, **security is a top concern**: a gateway is the front door to every service behind it, so a hole
in it is a hole in all of them. Whenever I found a security gap, fixing it jumped ahead of new features.

The order:

1. **Config loading and validation of the whole schema.** Every feature reads config, and "works with
   any valid config" plus "what happens when config is malformed?" both depend on this being solid.
   Validating the *whole* schema up front (even features not yet enforced) means a bad value anywhere
   fails fast with a clear message, and later features only consume already-normalized data.
2. **The non-negotiables:** listen on the configured port, `/health`, prefix routing with 404,
   method filtering with 405, proxying, plus `strip_prefix` and timeouts, which every real request
   depends on. A gateway that gets these wrong is unusable regardless of what else it does.
3. **An extensible pipeline**, so each later feature is a self-contained module rather than edits
   scattered across the server.
4. **Then features, ordered by production value per hour of work.** The plan was rate limiting, then
   retry and circuit breaker, auth, load balancing with health checks, and transforms last. What I
   actually did, and why it differed:
   1. **Retry and circuit breaker** first: "what happens when an upstream is down?" is the failure
      mode a gateway exists to handle, so I pulled it ahead of finishing rate limiting.
   2. **Failure-mode tests** before more features, which found a real bug.
   3. **Rate limiting**: configured on every route of the example (via `global_rate_limit`), and
      where the "50 simultaneous requests" concurrency question lives.
   4. **Path normalization**, a security fix found while reviewing how the API could be abused. It
      jumped the queue.
   5. **Auth**: an `auth` block the gateway ignored meant `/api/internal` was open to anyone, the most
      serious remaining gap.
   6. **Request limits** and a pass to make every feature's success and failure cases tested.
   7. **Load balancing**, then making sure **any valid config** works (which found config combinations
      that loaded but then misbehaved), then **health checks**.
   8. **Request/response transforms** last, and not done: they have the most surface area and the most
      ambiguity in the spec, they're used on one route, and they're the least about the gateway's core
      job of routing traffic safely and reliably.

## Architecture choices and trade-offs

### Request flow

```text
client → Node's HTTP parser               → 431 if request line + headers > 16 KB, 400 if malformed
       → server.ts
           ├─ normalizePath(path)         → 400 for ambiguous paths or ".." above "/"
           ├─ GET /health                 → 200 (built in, before routing)
           ├─ router.match(path)          → 404 if no route
           ├─ method allowed?             → 405 + Allow header if not
           ├─ read body (10 MB cap)       → 413 if larger
           └─ route.handler(ctx)          ← composed once at startup, per route:
                 rate_limit (429) → auth (401) → retry → circuit_breaker (503)
                   → upstream handler (load balancer picks a healthy target; 503 if none) → UpstreamClient
                   → upstream (502 unreachable, 504 timeout)
         ← response written once, by the server
```

Each feature only appears in a route's pipeline if that route configures it.

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
- **Errors are typed.** Anything that should become a specific response is a `GatewayError`
  (status + machine-readable code). Middleware that rejects a request outright (rate limiting, auth)
  returns it as a response; failures deeper in the pipeline throw it. Upstream failures are distinct
  types (`UpstreamUnavailableError` → 502, `UpstreamTimeoutError` → 504), which retry and the circuit
  breaker can tell apart. Any other exception becomes a logged 500, never a crash.

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
  say, response transforms are applied when they aren't.

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
- **Request bodies are buffered** (capped at 10 MB → 413). That's needed to replay a body on retry, and
  will be needed to rewrite it in `request_transform`. The trade-off is memory per in-flight request and
  no streaming uploads; a production version would buffer only on routes that need it and stream
  otherwise.
- **Request line and headers are capped at 16 KB** (431), which is where the query string lives. The
  limit is set explicitly on the server rather than inherited from Node's default, so it can't change
  underneath us. AWS API Gateway's HTTP APIs allow 10,240 bytes; 16 KB is a bit more generous for long
  query strings. Node rejects these requests (and malformed HTTP) before our handler runs, so the
  gateway hooks Node's `clientError` event to answer them in the same JSON error format as every
  other error, instead of Node's bare response.
- **Oversized bodies get a clean 413.** Stopping the read mid-upload resets the connection, and
  clients then report a broken pipe instead of the 413 (a test caught this). The gateway sends the 413
  and drains the rest of the body in the background, for at most 5 seconds.
- **Response bodies stream** straight through to the client; nothing buffers them yet (response
  transforms would).
- **Client disconnects cancel the upstream request** via an `AbortSignal`, so abandoned requests don't
  keep upstream work going.
- **Graceful shutdown** on SIGINT/SIGTERM: stop accepting connections, let in-flight requests finish
  (10s grace), then close.

## Security

Security is a top concern for a gateway: it sits in front of every service, so anything it lets through,
leaks or mishandles affects all of them. The approach is **fail closed** (refuse to start on a bad
config, reject ambiguous requests, answer 503 rather than guess when no healthy target exists), **trust
nothing from the client** that it could fake, and **never write secrets anywhere**.

| Threat | Protection |
| --- | --- |
| Calling a protected route without permission | API key auth on routes that configure it (401, upstream never called). |
| Guessing an API key | Constant-time comparison (no timing hints about the key or its length); auth runs after rate limiting, so every failed guess uses up the client's budget. |
| Leaking API keys | The key header is removed before forwarding, and keys never appear in logs. |
| Escaping a route's prefix with `..` (`/api/products/../internal`) | Paths are normalized before routing, so the request is routed (and authenticated) as what it really is. Climbing above `/` is a 400. |
| Encoded slashes, backslashes, null bytes in paths | 400. Upstreams disagree on how to read them, which is the classic way to get the gateway and the upstream to see different paths. |
| Faking a client IP to dodge rate limits | `X-Forwarded-For` from the client is passed along but never used to identify the client; the socket address is. |
| Exhausting gateway memory | 10 MB body limit (413), 16 KB limit on request line + headers (431), idle rate limit counters swept, oversized uploads drained for at most 5 seconds. |
| Malformed or hostile HTTP | Rejected by Node's parser with a JSON 400 before any gateway code runs; hop-by-hop headers are never forwarded. |
| Retries making things worse | POST/PATCH are only retried if the request provably never arrived (no duplicate orders); the circuit breaker stops retries against a failing upstream; exponential backoff is capped. |
| A slow or dead upstream tying up the gateway | Timeouts on every upstream call, circuit breakers, health checks, and cancelling upstream work when the client disconnects. |
| Personal data and secrets in logs | Access logs record method, path, route, status and timing only: never bodies, headers or query strings. |
| Config mistakes that weaken things silently | Rejected at startup: header values with line breaks (header injection), invalid header names (an auth header that could never match), upstream URLs with embedded credentials, route paths that could never match. |

Known gaps, in "What I'd build next": API keys sit in the config file in plain text (production would
read them from environment variables or a secret manager, and ideally store only hashes); there's no TLS
termination; rate limits are per instance; on a `per: "global"` route, unauthenticated requests can use up
the shared budget; and there's no cap on simultaneous connections or on clients that send very slowly.

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
| Settings that are valid alone but broken together | Rejected at startup, e.g. a route path like `/a/../b` that could never match a normalized request path, an upstream URL whose query string would be dropped, or `retry.on: []`. Settings that are legal but probably a mistake (weights with `round_robin`, `balance` with one `url`, a route at `/health`) only warn. |
| How long can a duration be? | Durations that become timers (timeouts, retry delays, health check intervals) are capped at 24 days, Node's timer limit. Past it, Node fires the timer after 1 ms, so `timeout: "720h"` would have made every request time out instantly; I found this by probing and confirmed it. Exponential backoff is capped the same way. |
| Duration formats | `"500ms"`, `"30s"`, `"1.5m"`, `"1h"`, and Go-style combinations like `"1m30s"`. A bare number is rejected rather than guessing the unit. |
| Weights without `balance` | Weighted round robin. With equal weights it behaves exactly like round robin, so this only changes anything when weights are actually given. |
| YAML features | Anchors with `<<:` merge keys are supported, since they're a common way to share route settings. Top-level keys starting with `x-` are allowed (no warning) as a place to define them. JSON files work too, since JSON is valid YAML. |

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
| Breaker per route or per target? | Per route, since that's where the config lives. Now that routes can have several targets, this has a cost: failures on one bad target count toward the route's breaker and can block the healthy targets too. Per-target breakers would fix that (see "What I'd build next"). |
| Retry and breaker on the same route | Retry wraps the breaker. Each attempt counts as a separate breaker result, and once the breaker opens mid-retry, the remaining attempts stop instead of hammering a failing upstream. A breaker rejection is never retried. |

### Auth

| Question | Decision |
| --- | --- |
| Missing key vs. wrong key | Both get 401 `{ "error": "unauthorized", "message": "..." }`, with different messages and a `WWW-Authenticate: ApiKey header="X-API-Key"` header. 403 would mean "we know who you are, but no", which doesn't apply to a bad key. |
| How are keys compared? | In constant time: both sides are hashed with SHA-256 and compared with `crypto.timingSafeEqual`, checking every configured key with no early exit. Response timing can't be used to guess a key character by character, or to learn its length. |
| Is the key forwarded to the upstream? | No. Authentication ends at the gateway, so the header is removed. The upstream and its logs never see the client's secret. |
| Is the key logged? | No. Access logs record method, path, route and status, never headers. |
| Header name case | Case-insensitive, like all HTTP headers: `X-API-Key` and `x-api-key` both work. Key values are case-sensitive. |
| The key header sent twice | 401, even if one copy is valid. Which copy the gateway checks shouldn't be up to the client. |
| Auth before or after rate limiting? | After. If auth ran first, rejected requests would never reach the rate limiter, and someone could try keys as fast as the network allows. Now every failed guess uses up that client's budget. The trade-off: on a route with `per: "global"`, unauthenticated requests use up the shared budget too, so an attacker could crowd out legitimate users. A production version would add a separate limit on failed auth attempts. |
| Do 401s count as circuit breaker failures? | No. Auth rejects before any upstream call, so the upstream's health isn't involved. |
| Bypass with `..` through an open route | Not possible: paths are normalized first, so `/api/open/../internal` is routed (and authenticated) as `/api/internal`. |

### Load balancing

| Question | Decision |
| --- | --- |
| `round_robin` | Each target in turn. Weights are ignored, as the name suggests. |
| `weighted_round_robin` | Smooth weighted round robin, the algorithm nginx uses. Each target gets exactly its share per cycle, spread out: weights 3:1 give A, A, B, A rather than A, A, A, B, so the lighter target is never idle for a long stretch and the heavier one never gets a burst. |
| A single `url` | Treated as one target; no balancing logic runs. |
| Concurrency | Picking a target is synchronous, so simultaneous requests can't race on the rotation: 40 requests at once at 3:1 split exactly 30/10. There's a test for this. |
| Retry with several targets | The target is picked per attempt, so a retry goes to the next target in the rotation rather than back to the one that just failed. A dead target plus `retry` still gives the client a 200. |
| A dead target, no retry | With `health_check`, it's taken out of the rotation once it fails `unhealthy_threshold` checks; until then (and on routes without health checks) its share of requests gets 502. |
| Balancer state | Per route, in memory. The rotation restarts when the gateway restarts. |

### Health checks

| Question | Decision |
| --- | --- |
| What counts as a passing check? | A 2xx response from `GET <target><path>`. Connection errors, timeouts and any other status fail. The check path is relative to the target, so a target URL with a base path (`http://svc/v2`) is checked at `/v2/healthz`. |
| When is a target unhealthy, and when does it recover? | Unhealthy after `unhealthy_threshold` failed checks in a row; one success in between resets the count. Healthy again after a single passing check. The spec only defines the unhealthy side; recovering on one success gets a target back into service as soon as it's up. |
| Check timeout | The route's upstream timeout or the check interval, whichever is shorter, so a hanging target can't stall its own checks. |
| At startup | Targets start healthy and the first round of checks runs immediately, so traffic flows from the start and a dead target is found within `unhealthy_threshold` intervals. |
| Every target unhealthy | 503 `{ "error": "no_healthy_upstream", ... }` right away, with no upstream call. Sending traffic to targets known to be down would only produce slow 502s. Some gateways "fail open" instead (send to all targets when none look healthy, in case the health endpoint itself is what's broken); that's a reasonable alternative I'd make configurable. |
| Overlapping checks | If a target's previous check is still running, the next one is skipped rather than piling up. |
| Shutdown | Checks start only once the gateway is listening, and stop (including checks in flight) when it shuts down. Their timers never keep the process alive. |
| Passive checks | Only active checks, as configured. Real request failures don't mark a target unhealthy (that's what the circuit breaker is for); see "What I'd build next". |

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
| Where in the pipeline? | Outermost, before auth, retry and the breaker: rejecting an over-limit client is the cheapest thing the gateway can do. Running before auth is deliberate; see the auth table. |
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
7. **Auth.** Until now, `/api/internal` accepted anyone, which was the most serious gap. API keys are
   checked in constant time, removed before forwarding, never logged, and checked after rate
   limiting so failed guesses are throttled. Checked with the example config, including the `..`
   path from step 6, which now gets a 401.
8. **Filling test gaps with a coverage report.** Rather than guessing what was untested, I ran a
   coverage report. It found about 20 untested validation branches, the startup warnings, and failure
   paths in retry and the circuit breaker. Every feature now has success and failure tests.
9. **Request limits.** Made the 16 KB request line + headers limit explicit (it had been Node's
   default) and gave rejected requests (431, malformed HTTP) the same JSON error format as everything
   else. I also ran every command in the README in zsh, which found unquoted URLs that zsh rejects and
   two examples that auth had broken.
10. **Load balancing.** `round_robin` and smooth `weighted_round_robin`, picked per attempt so retries
    move to the next target. Checked with the example config: `/api/products` answers from
    `products-a`, `products-a`, `products-b`, `products-a`, a 3:1 split.
11. **"Any valid config."** I probed the validator with config combinations rather than assuming it was
    complete. That found settings that loaded but then misbehaved (a 30-day timeout that fired after
    1 ms, route paths that could never match, upstream URLs whose query string was dropped), and valid
    configs that were wrongly rejected (`"1m30s"`, YAML merge keys). All fixed, with a test matrix of
    valid configs that must serve traffic, invalid combinations that must fail, and a second shipped
    config (`examples/alternate-gateway.yaml`) run end to end.
12. **Health checks.** Each target is checked on the configured path; the load balancer skips
    unhealthy ones, and a route with no healthy target answers 503 without calling anything. Checked
    with the example config (interval shortened to 1s, `products-b` stopped): after 3 failed checks,
    all `/api/products` traffic went to `products-a`. Also added a test for starting on a port
    that's already in use.

### Done and tested

Config loading and validation of the full schema, `/health`, routing, 404, 405, path normalization,
proxying (headers, body, query string, streaming), `strip_prefix`, per-route and global timeouts, 502/504
handling, request IDs, access logs, graceful shutdown, retry with fixed/exponential backoff, circuit
breaker, rate limiting (fixed and sliding window, per IP or global), API key auth, request size limits
(10 MB body, 16 KB request line + headers) with JSON errors, load balancing (round robin and weighted),
active health checks.

### Partially implemented

| Feature | Current state |
| --- | --- |
| `request_transform` (header add/remove, `$request_time`, body `mapping`, `$literal:`) | Parsed and validated, including header names and values (no line breaks), but **not applied**. Requests are forwarded unchanged, and the gateway logs a startup warning for each route that configures it. |
| `response_transform` (header add/remove, body `envelope`, `$body`, `$response_time`, `$route_path`) | Same: parsed and validated, **not applied**, with a startup warning. Responses stream through unchanged. |
| Health checks | Active checks only, as the config describes. Real request failures don't take a target out of rotation (passive checks). |
| Circuit breaker | Per route, as configured. With several targets, one failing target can open the breaker for the whole route. |
| Auth | Static API keys from the config only: no per-client identity, expiry or rotation without a restart. |
| Rate limiting | In memory, per gateway instance. Running several instances multiplies the effective limit. |

## Testing approach

Every implemented feature has tests for what should succeed and for what should fail; the README has
the full table. I used a coverage report (`npm run coverage`) to find gaps rather than guessing: it
turned up untested validation branches, the circuit breaker counting unreachable upstreams, and retry
stopping on client disconnect, all now covered. Line coverage is about 93%. The remainder is mostly
`src/index.ts` (tested by running it as a separate process, which coverage can't see) and timing races
that are hard to trigger on purpose.

- **Unit tests** for pure logic: duration parsing, config validation (including the exact error
  messages for malformed configs), path matching, rewriting and normalization, proxy header handling,
  API key comparison, startup warnings, and the circuit breaker's state machine and both rate limiting
  algorithms with a fake clock, so cooldowns and windows are tested without waiting.
- **Rate limiting end to end** (`test/rateLimit.test.ts`): 429s, headers, 50 simultaneous requests,
  window resets, inherited global limits. To get two client IPs from one machine, the per-IP and
  global tests connect over both IPv4 (127.0.0.1) and IPv6 (::1).
- **Integration tests** that start real mock upstreams and a real gateway on random ports and talk
  to them over HTTP. They build configs through the same YAML loader as production, with different
  routes, ports and timeouts than `gateway.yaml`, which also exercises "works with any valid config".
  They cover the non-negotiables, header forwarding, 502/504, 50 concurrent requests, retry (recovery,
  giving up, timeouts, backoff timing, no POST duplication, client disconnects), the circuit breaker
  (opening on 5xx, unreachable and timed-out upstreams; recovering), auth, and request size limits.
  `strip_prefix` has its own file checking exactly what path and query string the upstream receives,
  and `pathSecurity` sends raw `..` paths that try to escape a route.
- **Load balancing and health checks** (`balancer`, `loadBalancing`, `healthCheck`, `healthCheckRouting`):
  exact pick order, 40 simultaneous requests splitting exactly 30/10, retries moving to the next target,
  and unhealthy targets leaving and rejoining the rotation, with real checks every 50ms.
- **Failure tests** (`test/failures.test.ts`) cover how the gateway behaves when things break: an
  upstream that resets the connection, answers with non-HTTP bytes, dies halfway through a response,
  never answers, or restarts on the same port; 50 requests at once to a dead upstream; a client that
  hangs up mid-request (the upstream request is cancelled) or mid-upload. Every test also checks the
  gateway keeps serving afterwards.
- **Config combinations** (`test/configMatrix.test.ts`): differently shaped valid configs are loaded
  and actually serve traffic; invalid combinations must fail with a specific error; suspicious ones
  must warn. `test/alternateConfig.test.ts` runs a second shipped config end to end.
- **CLI tests** start the real `src/index.ts` as a separate process: config from an argument or
  `GATEWAY_CONFIG`, refusal to start on an invalid or missing config (exit 1), usage message (exit 2),
  a clean exit 0 on SIGTERM, and a clear exit 1 when the port is already in use.
- The mock upstream (`mock/upstream.ts`) echoes requests and has endpoints for failure cases: slow,
  flaky, fixed status, dropped connection, truncated body and non-HTTP replies. `npm run mock` starts it
  on the example config's ports. Its `/flaky` endpoint has its own tests (`test/mock.test.ts`), since
  the retry and circuit breaker tests depend on it counting exactly as documented.

## What I'd build next

In order:

- **Request and response transforms**, the last spec feature. The config is already validated; the
  work is applying it: header add/remove (with `$request_time`), dot-path body `mapping` with
  `$literal:` values, and the response `envelope`, which means buffering the response body instead of
  streaming it. Open questions to decide: what to do when a body isn't JSON (I'd forward it unchanged
  and log a warning), and the timestamp format (ISO 8601).
- **Security hardening:** read API keys from environment variables or a secret manager instead of
  the config file; a separate limit on failed auth attempts; caps on simultaneous connections and on
  clients that send very slowly; grouping IPv6 clients by /64 for rate limiting; TLS termination.
- Distributed rate limiting (Redis or similar) for running several gateway instances.
- Trusted-proxy config for reading the client IP from `X-Forwarded-For`.
- Streaming request bodies on routes that need neither retry nor body transforms.
- Config hot reload (rebuild pipelines and swap the router atomically).
- Metrics (request counts, latency histograms per route and upstream) alongside the access log.
- Passive health checks: take a target out of rotation when real requests to it keep failing, not
  only when its health endpoint does.
- Per-target circuit breakers, so one failing target doesn't trip the breaker for a route's healthy
  targets.
- Caps on risky config values (very large `retry.attempts`, or sliding-window `requests` that would
  use a lot of memory), and truncating very long paths in logs.
- An optional exact-match mode for routes (`match: "exact"`, defaulting to today's `"prefix"`). The
  schema only has prefix matching, which `strip_prefix` depends on, so I didn't add a field the spec
  doesn't define. But exposing only `/api/users` without everything under it currently isn't possible.
  It would be a small router change, and existing configs would behave the same.

## How I used AI tools

I used Claude Code as a pair programmer: I shared the requirements and made decisions with Claude,
working out the priorities and the architecture (pipeline of middleware, responses as values, validate
everything up front), then had it draft code and tests in that order. I reviewed and ran everything it
produced: type-checked, ran the tests, and smoke-tested the real gateway against the mock upstreams with
`curl` before each commit.

I also used it to look for problems, not just to write code: reviewing how the API could be abused
(which found the `..` path escape), running a coverage report to find untested code, probing the config
validator with unusual combinations (which found the 30-day timeout that fired after 1 ms), and running
every command in the README to check the docs matched reality.

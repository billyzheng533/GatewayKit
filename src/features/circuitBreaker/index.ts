import { CircuitOpenError, UpstreamError } from '../../errors.js';
import { secondsUntil } from '../../time.js';
import type { Feature } from '../index.js';
import { CircuitBreaker, type Outcome } from './breaker.js';

/**
 * Statuses that say the upstream itself is down or overloaded. A 500 is left
 * out on purpose: it usually means one request hit a bug, and if it counted, any
 * client that found an input causing a 500 could open the breaker and block the
 * route for everyone for the whole cooldown.
 */
const UPSTREAM_DOWN_STATUSES = new Set([502, 503, 504]);

/**
 * Enforces a route's `circuit_breaker`.
 *
 * A failure is an upstream that couldn't be reached or timed out, or that
 * answered 502, 503 or 504. Other statuses (4xx, and 500 from a single bad
 * request) count as successes: the upstream is up and answering.
 *
 * While open, requests are rejected with 503 before any upstream call:
 *   { "error": "service_unavailable", "retry_after": <seconds_remaining> }
 *
 * This middleware sits inside retry, so every attempt is counted, and a retry
 * stops as soon as the breaker opens (CircuitOpenError is never retried).
 */
export const circuitBreakerFeature: Feature = {
  name: 'circuit_breaker',
  create(route, { now, logger }) {
    const config = route.circuitBreaker;
    if (!config) return null;

    const breaker = new CircuitBreaker(config, (from, to) => {
      const log = to === 'closed' ? logger.info : logger.warn;
      log(`circuit breaker ${to}`, { route: route.path, from, to });
    });

    return async (ctx, next) => {
      const permit = breaker.tryAcquire(now());
      if (!permit.allowed) {
        // At least 1: while a half-open trial is in flight there's no fixed end, but "retry now" would be wrong.
        throw new CircuitOpenError(Math.max(1, secondsUntil(permit.retryAfterMs)));
      }

      let outcome: Outcome = 'neutral';
      try {
        const response = await next(ctx);
        outcome = UPSTREAM_DOWN_STATUSES.has(response.status) ? 'failure' : 'success';
        return response;
      } catch (err) {
        if (err instanceof UpstreamError && !ctx.signal.aborted) outcome = 'failure';
        throw err;
      } finally {
        breaker.record(permit, outcome, now());
      }
    };
  },
};

import { CircuitOpenError, UpstreamError } from '../../errors.js';
import type { Feature } from '../index.js';
import { CircuitBreaker, type Outcome } from './breaker.js';

/**
 * Enforces a route's `circuit_breaker`.
 *
 * A failure is an upstream that couldn't be reached, timed out (502/504), or
 * answered with a 5xx. 4xx responses are the client's problem, not the
 * upstream's, so they count as successes.
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
        throw new CircuitOpenError(Math.max(1, Math.ceil(permit.retryAfterMs / 1000)));
      }

      let outcome: Outcome = 'neutral';
      try {
        const response = await next(ctx);
        outcome = response.status >= 500 ? 'failure' : 'success';
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

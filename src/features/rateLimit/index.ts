import { GatewayError, errorResponse } from '../../errors.js';
import { rateLimitKey } from '../../clientIdentity.js';
import { secondsUntil } from '../../time.js';
import type { Feature } from '../index.js';
import { createLimiter, type RateLimitDecision } from './limiters.js';

const GLOBAL_KEY = '*';

/**
 * Enforces a route's `rate_limit` (or the inherited `global_rate_limit`).
 *
 * Each route gets its own limiter, so a route inheriting the global limit has
 * its own budget rather than sharing one with every other route.
 * Rejected requests get 429 and never reach the upstream. Every response on a
 * rate-limited route carries X-RateLimit-* headers so clients can pace themselves.
 */
export const rateLimitFeature: Feature = {
  name: 'rate_limit',
  create(route, { now }) {
    const config = route.rateLimit;
    if (!config) return null;
    const limiter = createLimiter(config);

    return async (ctx, next) => {
      const key = config.per === 'global' ? GLOBAL_KEY : rateLimitKey(ctx.request.clientIp);
      const decision = limiter.consume(key, now());
      const headers = rateLimitHeaders(decision);

      if (!decision.allowed) {
        const retryAfter = secondsUntil(decision.retryAfterMs);
        return errorResponse(
          new GatewayError(
            429,
            'rate_limited',
            `rate limit of ${config.requests} requests per ${config.windowMs / 1000}s exceeded`,
            { ...headers, 'retry-after': String(retryAfter) },
            { retry_after: retryAfter },
          ),
        );
      }

      try {
        const response = await next(ctx);
        return { ...response, headers: { ...response.headers, ...headers } };
      } catch (err) {
        // Errors become responses later (502, 504, ...); they should carry the budget too.
        if (err instanceof GatewayError) Object.assign(err.headers, headers);
        throw err;
      }
    };
  },
};

function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(decision.remaining),
    'x-ratelimit-reset': String(secondsUntil(decision.resetMs)),
  };
}



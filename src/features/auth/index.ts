import { createHash, timingSafeEqual } from 'node:crypto';
import { GatewayError, errorResponse } from '../../errors.js';
import { rateLimitKey } from '../../clientIdentity.js';
import { secondsUntil } from '../../time.js';
import type { Feature } from '../index.js';
import { FixedWindowLimiter } from '../rateLimit/limiters.js';

/**
 * Enforces a route's `auth` (type "api_key").
 *
 * - The key is read from the configured header (header names are
 *   case-insensitive, so "X-API-Key" matches "x-api-key").
 * - Missing or wrong key: 401 `{ "error": "unauthorized", ... }`, and the
 *   upstream is never called.
 * - Keys are compared in constant time, so response timing can't be used to
 *   guess a key one character at a time.
 * - The key header is removed before forwarding: authentication ends at the
 *   gateway, and the upstream (and its logs) never see the client's secret.
 * - Keys are never logged.
 */
/** Failed key attempts allowed per client per window, before every attempt is refused. */
export const MAX_FAILED_ATTEMPTS = 10;
export const FAILED_ATTEMPT_WINDOW_MS = 60_000;

export const authFeature: Feature = {
  name: 'auth',
  create(route, { now }) {
    const config = route.auth;
    if (!config) return null;
    // Separate from rate_limit: a route's general limit (100/min in the example) is far
    // too generous for key guessing. Counts failures only, per client (IPv6 by /64).
    const failures = new FixedWindowLimiter(MAX_FAILED_ATTEMPTS, FAILED_ATTEMPT_WINDOW_MS);

    const headerName = config.header.toLowerCase();
    const keyDigests = config.keys.map(digest);
    const challenge = { 'www-authenticate': `ApiKey header="${config.header}"` };

    return async (ctx, next) => {
      const client = rateLimitKey(ctx.request.clientIp);
      // While locked out, refuse every attempt, even one with a valid key: otherwise a
      // correct guess during the lockout would still be told apart by its 200.
      const lockout = failures.peek(client, now());
      if (!lockout.allowed) {
        const retryAfter = Math.max(1, secondsUntil(lockout.retryAfterMs));
        return errorResponse(
          new GatewayError(
            429,
            'too_many_failed_attempts',
            'too many failed API key attempts; try again later',
            { 'retry-after': String(retryAfter) },
            { retry_after: retryAfter },
          ),
        );
      }
      const reject = (message: string) => {
        failures.consume(client, now());
        return errorResponse(new GatewayError(401, 'unauthorized', message, challenge));
      };

      // headersDistinct, not headers: Node silently keeps only the first copy of some
      // headers (Authorization among them), which would hide a duplicate.
      const values = ctx.request.headersDistinct[headerName] ?? [];
      const provided = values[0];

      if (provided === undefined || provided === '') {
        return reject(`missing API key: send it in the ${config.header} header`);
      }
      // A key header sent more than once is rejected, even if one copy is valid:
      // which copy counts shouldn't be up to the client.
      if (values.length > 1 || !keyMatches(provided, keyDigests)) {
        return reject('invalid API key');
      }

      const headers = { ...ctx.request.headers };
      delete headers[headerName];
      return next({ ...ctx, request: { ...ctx.request, headers } });
    };
  },
};

/**
 * Hashing first gives equal-length inputs for timingSafeEqual (which throws on
 * a length mismatch, and checking lengths first would leak the key length).
 * Every configured key is compared, with no early exit on a match.
 */
export function keyMatches(candidate: string, keyDigests: readonly Buffer[]): boolean {
  const candidateDigest = digest(candidate);
  let matched = false;
  for (const keyDigest of keyDigests) {
    if (timingSafeEqual(candidateDigest, keyDigest)) matched = true;
  }
  return matched;
}

export function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

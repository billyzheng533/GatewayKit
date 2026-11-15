import { createHash, timingSafeEqual } from 'node:crypto';
import { GatewayError, errorResponse } from '../../errors.js';
import type { Feature } from '../index.js';

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
export const authFeature: Feature = {
  name: 'auth',
  create(route) {
    const config = route.auth;
    if (!config) return null;

    const headerName = config.header.toLowerCase();
    const keyDigests = config.keys.map(digest);
    const challenge = { 'www-authenticate': `ApiKey header="${config.header}"` };

    return async (ctx, next) => {
      // headersDistinct, not headers: Node silently keeps only the first copy of some
      // headers (Authorization among them), which would hide a duplicate.
      const values = ctx.request.headersDistinct[headerName] ?? [];
      const provided = values[0];

      if (provided === undefined || provided === '') {
        return errorResponse(
          new GatewayError(401, 'unauthorized', `missing API key: send it in the ${config.header} header`, challenge),
        );
      }
      // A key header sent more than once is rejected, even if one copy is valid:
      // which copy counts shouldn't be up to the client.
      if (values.length > 1 || !keyMatches(provided, keyDigests)) {
        return errorResponse(new GatewayError(401, 'unauthorized', 'invalid API key', challenge));
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

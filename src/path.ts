import { GatewayError } from './errors.js';

/**
 * Request path normalization, applied before routing.
 *
 * Without it, "/api/products/../internal" matches the /api/products route, is
 * stripped to "/../internal", and the upstream resolves that to "/internal":
 * a client escapes the route's prefix and reaches paths the route never
 * exposed. Routing and forwarding must both see the same, resolved path.
 *
 *   - "." and ".." segments are resolved (RFC 3986 §5.2.4), including
 *     percent-encoded forms like "%2e%2e".
 *   - ".." that would climb above "/" is rejected rather than clamped.
 *   - Repeated slashes collapse: "//api//users" is "/api/users".
 *   - Encoded slashes and backslashes (%2F, %5C), raw backslashes and encoded
 *     null bytes are rejected: upstreams disagree on whether they separate
 *     path segments, which is how routing gets bypassed.
 *   - Anything else, such as %20, is passed through untouched.
 */

export class InvalidPathError extends GatewayError {
  constructor(reason: string) {
    super(400, 'bad_request', `invalid request path: ${reason}`);
  }
}

const AMBIGUOUS = /%2f|%5c|%00|\\/i;

export function normalizePath(raw: string): string {
  if (!raw.startsWith('/')) throw new InvalidPathError('must start with "/"');
  if (AMBIGUOUS.test(raw)) {
    throw new InvalidPathError('encoded slashes, backslashes and null bytes are not allowed');
  }

  const resolved: string[] = [];
  const segments = raw.split('/').slice(1);
  let trailingSlash = false;

  for (const segment of segments) {
    const decoded = segment.replace(/%2e/gi, '.');
    trailingSlash = false;
    if (segment === '') {
      trailingSlash = true; // repeated slash: collapse, but remember a trailing one
    } else if (decoded === '.') {
      trailingSlash = true;
    } else if (decoded === '..') {
      if (resolved.length === 0) throw new InvalidPathError('".." climbs above the root');
      resolved.pop();
      trailingSlash = true;
    } else {
      resolved.push(segment);
    }
  }

  if (resolved.length === 0) return '/';
  return `/${resolved.join('/')}${trailingSlash ? '/' : ''}`;
}

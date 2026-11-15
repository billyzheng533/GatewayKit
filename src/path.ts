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
 *   - Percent-encoded letters, digits and "-._~" are decoded ("%69" is "i"):
 *     RFC 3986 says they're equivalent, and upstreams do decode them, so routing
 *     on the encoded form would let "/api/%69nternal" dodge a "/api/internal"
 *     route's auth. The decoded path is what gets forwarded.
 *   - ";" (path parameters, raw or as %3B) is rejected: Java servers such as
 *     Tomcat strip ";x" from segments, so "/api/internal;x/secret" would be
 *     "/api/internal/secret" to them but not to the router.
 *   - Other encodings, such as %20, are passed through (hex in upper case).
 *
 * Route matching is case-insensitive (see router.ts) for the same reason:
 * many frameworks ignore case, so "/api/Internal" must hit the same route.
 */

export class InvalidPathError extends GatewayError {
  constructor(reason: string) {
    super(400, 'bad_request', `invalid request path: ${reason}`);
  }
}

const AMBIGUOUS = /%2f|%5c|%00|\\/i;
const PATH_PARAMETERS = /;|%3b/i;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** "%69" -> "i", "%7e" -> "~"; anything else stays encoded (upper-case hex). */
function decodeUnreserved(segment: string): string {
  return segment.replace(/%([0-9a-f]{2})/gi, (encoded, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : encoded.toUpperCase();
  });
}

export function normalizePath(raw: string): string {
  if (!raw.startsWith('/')) throw new InvalidPathError('must start with "/"');
  if (AMBIGUOUS.test(raw)) {
    throw new InvalidPathError('encoded slashes, backslashes and null bytes are not allowed');
  }
  if (PATH_PARAMETERS.test(raw)) {
    throw new InvalidPathError('";" path parameters are not allowed');
  }

  const resolved: string[] = [];
  const segments = raw.split('/').slice(1);
  let trailingSlash = false;

  for (const rawSegment of segments) {
    const segment = decodeUnreserved(rawSegment); // also turns "%2e%2e" into ".."
    trailingSlash = false;
    if (segment === '') {
      trailingSlash = true; // repeated slash: collapse, but remember a trailing one
    } else if (segment === '.') {
      trailingSlash = true;
    } else if (segment === '..') {
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

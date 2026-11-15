/**
 * Prefix router. A route path matches the exact path and anything below it on a
 * segment boundary: "/api/users" matches "/api/users" and "/api/users/42" but
 * not "/api/usersettings". When several routes match, the longest (most
 * specific) prefix wins, regardless of order in the config file.
 *
 * Matching ignores case. Many upstream frameworks (Express by default) treat
 * "/api/Internal" and "/api/internal" as the same, so case-sensitive matching
 * would let "/api/Internal/..." fall through to a broader route and skip the
 * "/api/internal" route's auth. The path is still forwarded as sent.
 */
export class Router<T extends { path: string }> {
  private readonly routes: T[];

  constructor(routes: readonly T[]) {
    this.routes = [...routes].sort((a, b) => b.path.length - a.path.length);
  }

  match(pathname: string): T | undefined {
    return this.routes.find((route) => pathMatches(route.path, pathname));
  }
}

export function pathMatches(prefix: string, pathname: string): boolean {
  if (prefix === '/') return true;
  const p = prefix.toLowerCase();
  const path = pathname.toLowerCase();
  return path === p || path.startsWith(`${p}/`);
}

/** Path to send upstream: with strip_prefix, "/api/products/123" -> "/123" and "/api/products" -> "/". */
export function upstreamPath(route: { path: string; stripPrefix: boolean }, pathname: string): string {
  if (!route.stripPrefix || route.path === '/') return pathname;
  const rest = pathname.slice(route.path.length);
  return rest === '' ? '/' : rest;
}

import { describe, expect, it } from 'vitest';
import { Router, pathMatches, upstreamPath } from '../src/router.js';

describe('pathMatches', () => {
  it('matches the exact path and sub-paths on a segment boundary', () => {
    expect(pathMatches('/api/users', '/api/users')).toBe(true);
    expect(pathMatches('/api/users', '/api/users/')).toBe(true);
    expect(pathMatches('/api/users', '/api/users/42')).toBe(true);
  });

  it('does not match a path that only shares a string prefix', () => {
    expect(pathMatches('/api/users', '/api/usersettings')).toBe(false);
    expect(pathMatches('/api/users', '/api')).toBe(false);
  });

  it('treats "/" as a catch-all', () => {
    expect(pathMatches('/', '/anything/at/all')).toBe(true);
  });
});

describe('Router', () => {
  const router = new Router([{ path: '/' }, { path: '/api' }, { path: '/api/users' }]);

  it('prefers the most specific route regardless of config order', () => {
    expect(router.match('/api/users/1')?.path).toBe('/api/users');
    expect(router.match('/api/orders')?.path).toBe('/api');
    expect(router.match('/other')?.path).toBe('/');
  });

  it('returns undefined when nothing matches', () => {
    expect(new Router([{ path: '/api' }]).match('/web')).toBeUndefined();
  });
});

describe('upstreamPath', () => {
  const strip = { path: '/api/products', stripPrefix: true };
  const keep = { path: '/api/products', stripPrefix: false };

  it('strips the route prefix when strip_prefix is true', () => {
    expect(upstreamPath(strip, '/api/products/123')).toBe('/123');
    expect(upstreamPath(strip, '/api/products/a/b')).toBe('/a/b');
  });

  it('forwards "/" when the request is exactly the stripped prefix', () => {
    expect(upstreamPath(strip, '/api/products')).toBe('/');
  });

  it('leaves the path alone when strip_prefix is false', () => {
    expect(upstreamPath(keep, '/api/products/123')).toBe('/api/products/123');
  });
});

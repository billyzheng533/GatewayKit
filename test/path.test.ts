import { describe, expect, it } from 'vitest';
import { InvalidPathError, normalizePath } from '../src/path.js';

describe('normalizePath', () => {
  it.each([
    ['/', '/'],
    ['/api/users', '/api/users'],
    ['/api/users/', '/api/users/'],
    ['/api/./users', '/api/users'],
    ['/api/products/../internal', '/api/internal'],
    ['/api/products/a/b/../../c', '/api/products/c'],
    ['/api/products/%2e%2e/internal', '/api/internal'],
    ['/api/products/%2E%2e/internal', '/api/internal'],
    ['/api/products/.%2e/internal', '/api/internal'],
    ['/api/products/..', '/api/'],
    ['/api/products/.', '/api/products/'],
    ['//api//users///1', '/api/users/1'],
    ['/a%20b/c', '/a%20b/c'], // other encodings pass through untouched
    ['/files/archive.tar.gz', '/files/archive.tar.gz'], // dots inside a segment are not dot-segments
    ['/a/...', '/a/...'], // three dots is an ordinary name
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizePath(raw)).toBe(expected);
  });

  it.each([
    ['/..', 'climbs above the root'],
    ['/api/../../etc/passwd', 'climbs above the root'],
    ['/%2e%2e/secret', 'climbs above the root'],
    ['/api/products/..%2Finternal', 'encoded slashes'],
    ['/api/products/..%2finternal', 'encoded slashes'],
    ['/api/products/..%5Cinternal', 'encoded slashes'],
    ['/api/products/..\\internal', 'encoded slashes'],
    ['/api/users%00.json', 'encoded slashes'],
    ['*', 'must start with "/"'],
    ['http://evil.example/api/users', 'must start with "/"'],
  ])('rejects %j', (raw, reason) => {
    expect(() => normalizePath(raw)).toThrow(InvalidPathError);
    expect(() => normalizePath(raw)).toThrow(reason);
  });
});

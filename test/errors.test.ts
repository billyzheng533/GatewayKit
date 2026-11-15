import { describe, expect, it } from 'vitest';
import {
  CircuitOpenError,
  ClientClosedError,
  GatewayError,
  PayloadTooLargeError,
  UpstreamError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
  errorResponse,
} from '../src/errors.js';
import { describeConnectError, joinTargetPath } from '../src/proxy/client.js';

describe('gateway error responses', () => {
  it('use the shape { error, message, ...extra }', () => {
    const err = new GatewayError(429, 'rate_limited', 'slow down', { 'retry-after': '5' }, { retry_after: 5 });
    expect(err.toBody()).toEqual({ error: 'rate_limited', message: 'slow down', retry_after: 5 });
  });

  it('become a JSON response value with the error\'s headers', () => {
    const response = errorResponse(new GatewayError(401, 'unauthorized', 'no key', { 'www-authenticate': 'ApiKey' }));
    expect(response.status).toBe(401);
    expect(response.headers).toEqual({ 'www-authenticate': 'ApiKey', 'content-type': 'application/json' });
    expect(JSON.parse((response.body as Buffer).toString())).toEqual({ error: 'unauthorized', message: 'no key' });
  });

  it('for an open circuit breaker, match the spec exactly, with Retry-After', () => {
    const err = new CircuitOpenError(12);
    expect(err.status).toBe(503);
    expect(err.toBody()).toEqual({ error: 'service_unavailable', retry_after: 12 });
    expect(err.headers).toEqual({ 'retry-after': '12' });
  });

  it('map upstream failures to 502 and 504, as UpstreamErrors', () => {
    const unavailable = new UpstreamUnavailableError('http://svc', new Error('boom'));
    const timeout = new UpstreamTimeoutError('http://svc', 250);
    expect([unavailable.status, unavailable.code]).toEqual([502, 'bad_gateway']);
    expect([timeout.status, timeout.code]).toEqual([504, 'gateway_timeout']);
    expect(timeout.message).toBe('upstream http://svc did not respond within 250ms');
    expect(unavailable).toBeInstanceOf(UpstreamError);
    expect(timeout).toBeInstanceOf(UpstreamError);
  });

  it('use 413 without Connection: close for oversized bodies, and 499 for clients that left', () => {
    const tooLarge = new PayloadTooLargeError(10);
    expect([tooLarge.status, tooLarge.headers]).toEqual([413, {}]);
    expect(new ClientClosedError().status).toBe(499);
  });
});

describe('UpstreamUnavailableError.requestNotSent', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'is true for %s: the request never reached the upstream',
    (code) => {
      expect(new UpstreamUnavailableError('http://svc', new Error(code), code).requestNotSent).toBe(true);
    },
  );

  it.each(['ECONNRESET', 'EPIPE', undefined])('is false for %s: the request may have arrived', (code) => {
    expect(new UpstreamUnavailableError('http://svc', new Error('x'), code).requestNotSent).toBe(false);
  });
});

describe('describeConnectError', () => {
  const withCode = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

  it('keeps a message that already names the code', () => {
    const { error, code } = describeConnectError(withCode('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED'));
    expect([error.message, code]).toEqual(['connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED']);
  });

  it('adds the code when the message lacks it', () => {
    expect(describeConnectError(withCode('socket hang up', 'ECONNRESET')).error.message).toBe('ECONNRESET: socket hang up');
  });

  it('fills in the empty message Node gives when "localhost" fails on both IPv6 and IPv4', () => {
    const aggregate = new AggregateError([withCode('connect ECONNREFUSED ::1:3001', 'ECONNREFUSED')], '');
    const { error, code } = describeConnectError(aggregate);
    expect(code).toBe('ECONNREFUSED');
    expect(error.message).toBe('connect ECONNREFUSED ::1:3001');
  });

  it('copes with an error that has neither code nor message', () => {
    expect(describeConnectError(new Error('')).error.message).toBe('connection failed');
  });
});

describe('joinTargetPath', () => {
  it.each([
    ['http://svc', '/items', '/items'],
    ['http://svc/', '/items', '/items'],
    ['http://svc/v2', '/items', '/v2/items'],
    ['http://svc/v2/', '/', '/v2/'],
  ])('%s + %s = %s', (target, path, expected) => {
    expect(joinTargetPath(new URL(target), path)).toBe(expected);
  });
});

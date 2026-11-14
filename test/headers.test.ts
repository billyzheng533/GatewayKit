import { describe, expect, it } from 'vitest';
import { upstreamRequestHeaders, withoutHopByHop } from '../src/proxy/headers.js';

const info = { clientIp: '203.0.113.7', requestId: 'req-1', upstreamHost: 'users.internal:3001', bodyLength: 0 };

describe('withoutHopByHop', () => {
  it('drops standard hop-by-hop headers and keeps end-to-end ones', () => {
    expect(
      withoutHopByHop({
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        te: 'trailers',
        'proxy-authorization': 'Basic xyz',
        'content-type': 'application/json',
        'x-custom': 'yes',
      }),
    ).toEqual({ 'content-type': 'application/json', 'x-custom': 'yes' });
  });

  it('also drops headers that the Connection header names', () => {
    expect(withoutHopByHop({ connection: 'close, X-Secret', 'x-secret': '1', 'x-other': '2' })).toEqual({ 'x-other': '2' });
  });

  it('keeps every value of a multi-value header', () => {
    expect(withoutHopByHop({ 'set-cookie': ['a=1', 'b=2'] })).toEqual({ 'set-cookie': ['a=1', 'b=2'] });
  });
});

describe('upstreamRequestHeaders', () => {
  it('adds forwarding headers and points Host at the upstream', () => {
    const headers = upstreamRequestHeaders({ host: 'gateway.example:8080', accept: '*/*' }, info);
    expect(headers).toEqual({
      accept: '*/*',
      host: 'users.internal:3001',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-host': 'gateway.example:8080',
      'x-forwarded-proto': 'http',
      'x-request-id': 'req-1',
    });
  });

  it('appends to an existing X-Forwarded-For chain', () => {
    const headers = upstreamRequestHeaders({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }, info);
    expect(headers['x-forwarded-for']).toBe('10.0.0.1, 10.0.0.2, 203.0.113.7');
  });

  it('replaces chunked framing with an exact Content-Length for the buffered body', () => {
    const headers = upstreamRequestHeaders({ 'transfer-encoding': 'chunked' }, { ...info, bodyLength: 42 });
    expect(headers['content-length']).toBe('42');
    expect(headers['transfer-encoding']).toBeUndefined();
  });

  it('corrects a Content-Length that disagrees with the body', () => {
    expect(upstreamRequestHeaders({ 'content-length': '999' }, { ...info, bodyLength: 3 })['content-length']).toBe('3');
  });

  it('sends no Content-Length for a bodiless request that had none', () => {
    expect(upstreamRequestHeaders({}, info)['content-length']).toBeUndefined();
  });
});

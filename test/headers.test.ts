import { describe, expect, it } from 'vitest';
import { upstreamRequestHeaders, withoutHopByHop } from '../src/proxy/headers.js';

const info = {
  clientIp: '203.0.113.7',
  forwardedFor: '203.0.113.7',
  forwardedProto: 'http' as const,
  requestId: 'req-1',
  upstreamHost: 'users.internal:3001',
  bodyLength: 0,
};

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
  it('sets the gateway\'s own forwarding headers and points Host at the upstream', () => {
    const headers = upstreamRequestHeaders({ host: 'gateway.example:8080', accept: '*/*' }, info);
    expect(headers).toEqual({
      accept: '*/*',
      host: 'users.internal:3001',
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
      'x-forwarded-proto': 'http',
      'x-request-id': 'req-1',
    });
  });

  it('drops every client-supplied identity header and replaces them with its own', () => {
    const headers = upstreamRequestHeaders(
      {
        'x-forwarded-for': '6.6.6.6',
        'x-real-ip': '6.6.6.6',
        forwarded: 'for=6.6.6.6',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-client-ip': '6.6.6.6',
        'true-client-ip': '6.6.6.6',
      },
      info,
    );
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers['x-real-ip']).toBe('203.0.113.7');
    expect(headers['x-forwarded-proto']).toBe('http');
    for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-port', 'x-client-ip', 'true-client-ip']) {
      expect(headers[name]).toBeUndefined();
    }
  });

  it('never derives X-Forwarded-Host from the client\'s Host header', () => {
    expect(upstreamRequestHeaders({ host: 'evil.example' }, info)['x-forwarded-host']).toBeUndefined();
  });

  it('passes on the chain, protocol and host it was given for a trusted proxy', () => {
    const headers = upstreamRequestHeaders(
      {},
      { ...info, forwardedFor: '198.51.100.9, 10.0.0.5', forwardedProto: 'https', forwardedHost: 'shop.example' },
    );
    expect(headers['x-forwarded-for']).toBe('198.51.100.9, 10.0.0.5');
    expect(headers['x-forwarded-proto']).toBe('https');
    expect(headers['x-forwarded-host']).toBe('shop.example');
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

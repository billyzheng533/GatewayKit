import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

/** Hop-by-hop headers (RFC 9110 §7.6.1) describe a single connection and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Copies headers, dropping hop-by-hop headers and any listed in the Connection header. */
export function withoutHopByHop(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue;
    result[name] = value;
  }
  return result;
}

export interface ForwardingInfo {
  clientIp: string;
  forwardedFor: string;
  forwardedProto: 'http' | 'https';
  forwardedHost?: string;
  requestId: string;
  upstreamHost: string;
  bodyLength: number;
}

/**
 * Headers that claim something about the client's identity or the original
 * request. Upstreams commonly trust them, so whatever the client sent is
 * dropped and the gateway sets its own (see clientIdentity.ts).
 */
const CLIENT_IDENTITY = new Set(['forwarded', 'x-real-ip', 'x-client-ip', 'true-client-ip']);
const isIdentityHeader = (name: string) => CLIENT_IDENTITY.has(name) || name.startsWith('x-forwarded-');

/** Headers sent to the upstream: the client's end-to-end headers plus the gateway's own proxy headers. */
export function upstreamRequestHeaders(clientHeaders: IncomingHttpHeaders, info: ForwardingInfo): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = withoutHopByHop(clientHeaders);
  for (const name of Object.keys(headers)) if (isIdentityHeader(name)) delete headers[name];

  headers['x-forwarded-for'] = info.forwardedFor;
  headers['x-real-ip'] = info.clientIp;
  headers['x-forwarded-proto'] = info.forwardedProto;
  if (info.forwardedHost) headers['x-forwarded-host'] = info.forwardedHost;
  headers['x-request-id'] = info.requestId;
  headers.host = info.upstreamHost;

  // The body is fully buffered, so always send an exact length instead of
  // relaying the client's framing (which may have been chunked).
  delete headers['content-length'];
  if (info.bodyLength > 0 || clientHeaders['content-length'] !== undefined || clientHeaders['transfer-encoding']) {
    headers['content-length'] = String(info.bodyLength);
  }
  return headers;
}

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
  requestId: string;
  upstreamHost: string;
  bodyLength: number;
}

/** Headers sent to the upstream: the client's end-to-end headers plus standard proxy headers. */
export function upstreamRequestHeaders(clientHeaders: IncomingHttpHeaders, info: ForwardingInfo): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = withoutHopByHop(clientHeaders);

  const priorForwardedFor = clientHeaders['x-forwarded-for'];
  headers['x-forwarded-for'] = priorForwardedFor ? `${priorForwardedFor}, ${info.clientIp}` : info.clientIp;
  if (clientHeaders.host) headers['x-forwarded-host'] = clientHeaders.host;
  headers['x-forwarded-proto'] = 'http';
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

import { BlockList, isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Who the client is, and what the gateway tells upstreams about it.
 *
 * The gateway is the edge: by default nothing a client says about its own
 * identity is believed or passed on. X-Forwarded-For becomes the socket
 * address alone, and inbound Forwarded / X-Real-IP / X-Forwarded-* headers are
 * dropped (see upstreamRequestHeaders), so a client can't put "6.6.6.6" into an
 * upstream's IP allowlist, audit log or per-IP limit, or plant a fake host for
 * an upstream that builds links from X-Forwarded-Host.
 *
 * Behind a load balancer, list it in `gateway.trusted_proxies`. Requests from a
 * trusted proxy keep its X-Forwarded-For chain (with the proxy appended), and the
 * client is the rightmost address in that chain that isn't itself a trusted
 * proxy: the leftmost entries are whatever the original client claimed.
 */

export interface ClientIdentity {
  /** The address used to identify the client (rate limiting, logs). */
  clientIp: string;
  /** X-Forwarded-For to send upstream. */
  forwardedFor: string;
  /** X-Forwarded-Proto to send upstream. */
  forwardedProto: 'http' | 'https';
  /** X-Forwarded-Host to send upstream; only ever set from a trusted proxy. */
  forwardedHost?: string;
}

/** "::ffff:10.0.0.1" (an IPv4 client on a dual-stack socket) -> "10.0.0.1". */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? (mapped[1] as string) : ip;
}

/** Builds a matcher from addresses and CIDR ranges ("10.0.0.0/8", "::1"). Entries must be pre-validated. */
export function trustedProxyList(entries: readonly string[]): BlockList | null {
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/** Returns an error message if `entry` isn't an IP address or CIDR range, otherwise undefined. */
export function invalidTrustedProxy(entry: string): string | undefined {
  const [address = '', prefix, extra] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || extra !== undefined) return `"${entry}" is not an IP address or CIDR range`;
  if (prefix === undefined) return undefined;
  const bits = Number(prefix);
  const max = family === 4 ? 32 : 128;
  if (!/^\d+$/.test(prefix) || bits > max) return `"${entry}" has an invalid prefix length (0-${max})`;
  return undefined;
}

function isTrusted(list: BlockList, ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function resolveClient(
  socketAddress: string | undefined,
  headers: IncomingHttpHeaders,
  trusted: BlockList | null,
): ClientIdentity {
  const socketIp = normalizeIp(socketAddress ?? 'unknown');
  if (!trusted || !isTrusted(trusted, socketIp)) {
    return { clientIp: socketIp, forwardedFor: socketIp, forwardedProto: 'http' };
  }

  const claimed = String(headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((entry) => normalizeIp(entry.trim()))
    .filter(Boolean);
  const chain = [...claimed, socketIp];

  // Walk back from the gateway: skip our own trusted proxies; the first address
  // that isn't one is the client. Anything further left was supplied by the client.
  let clientIp = chain[0] as string;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const ip = chain[i] as string;
    if (!isTrusted(trusted, ip)) {
      clientIp = isIP(ip) ? ip : socketIp; // garbage in the chain never becomes the client's identity
      break;
    }
  }

  const proto = firstValue(headers['x-forwarded-proto'])?.split(',')[0]?.trim().toLowerCase();
  const host = firstValue(headers['x-forwarded-host'])?.split(',')[0]?.trim();
  return {
    clientIp,
    forwardedFor: chain.join(', '),
    forwardedProto: proto === 'https' ? 'https' : 'http',
    ...(host ? { forwardedHost: host } : {}),
  };
}

/**
 * The key a client is rate limited by. IPv6 clients are grouped by /64: one
 * subscriber usually gets a whole /64 (2^64 addresses), so per-address limits
 * could be dodged by rotating addresses, and every address would add an entry
 * to the limiter's memory.
 */
export function rateLimitKey(clientIp: string): string {
  if (isIP(clientIp) !== 6) return clientIp;
  return `${expandIpv6(clientIp).slice(0, 4).join(':')}::/64`;
}

/** "2001:db8::1" -> ["2001", "db8", "0", "0", "0", "0", "0", "1"]. */
function expandIpv6(ip: string): string[] {
  const [head = '', tail] = ip.toLowerCase().split('::');
  const toGroups = (part: string) => (part === '' ? [] : part.split(':').flatMap(ipv4ToGroups));
  const left = toGroups(head);
  const right = tail === undefined ? [] : toGroups(tail);
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...(tail === undefined ? [] : zeros), ...right].map((g) => g.replace(/^0+(?=.)/, ''));
}

/** An embedded IPv4 tail ("::ffff:1.2.3.4" style) as two hex groups. */
function ipv4ToGroups(group: string): string[] {
  if (!group.includes('.')) return [group];
  const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

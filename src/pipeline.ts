import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import type { RouteConfig } from './config/types.js';

/**
 * The proxy pipeline.
 *
 * Each matched request flows through a chain of middleware and ends at the
 * upstream handler, which forwards it. Middleware are plain async functions
 * that receive the request context and a `next` handler and return a
 * response, so a feature can:
 *   - short-circuit (auth, rate limiting): return a response without calling next
 *   - wrap the call (retry, circuit breaker): call next zero or more times
 *   - rewrite (transforms): call next with a changed request, or change the response
 *
 * Responses are values rather than writes to the socket, which is what lets
 * the outer layers inspect, retry or rewrite them. Only the server writes to
 * the client, once, at the very end.
 */

export interface GatewayRequest {
  method: string;
  /** Path as received from the client (no query string). */
  path: string;
  /** Raw query string including the leading "?", or "" when absent. */
  query: string;
  /** Lower-cased header names, as Node provides them. */
  headers: IncomingHttpHeaders;
  /** Fully buffered so it can be replayed on retry and rewritten by transforms. */
  body: Buffer;
  clientIp: string;
}

export interface GatewayResponse {
  status: number;
  headers: OutgoingHttpHeaders;
  /** Upstream bodies stream through untouched unless a feature needs to buffer them. */
  body: Buffer | Readable;
}

export interface RequestContext {
  readonly route: RouteConfig;
  readonly request: GatewayRequest;
  readonly requestId: string;
  readonly receivedAt: Date;
  /** Aborted when the client goes away, so upstream work can be cancelled. */
  readonly signal: AbortSignal;
}

export type Handler = (ctx: RequestContext) => Promise<GatewayResponse>;
export type Middleware = (ctx: RequestContext, next: Handler) => Promise<GatewayResponse>;

/** Builds one handler from middleware (outermost first) and the terminal handler. */
export function compose(middleware: readonly Middleware[], terminal: Handler): Handler {
  return middleware.reduceRight<Handler>((next, mw) => (ctx) => mw(ctx, next), terminal);
}

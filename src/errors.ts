import type { OutgoingHttpHeaders } from 'node:http';
import type { GatewayResponse } from './pipeline.js';

/**
 * An error that maps to a specific HTTP response. Anything thrown inside the
 * pipeline that is not a GatewayError becomes a 500 and is logged.
 *
 * Every gateway-generated error body has the same shape:
 *   { "error": "<machine_code>", "message": "<human text>", ...extra }
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: OutgoingHttpHeaders = {},
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

/**
 * A GatewayError as a response value, for middleware that short-circuits the
 * pipeline (rate limiting, auth) instead of throwing.
 */
export function errorResponse(err: GatewayError): GatewayResponse {
  return {
    status: err.status,
    headers: { ...err.headers, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(err.toBody())),
  };
}

/**
 * Connection error codes that mean the request never reached the upstream, so
 * resending it can't cause a duplicate side effect, even for a POST.
 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Base class for failures to get a response from the upstream (as opposed to
 * the upstream answering with an error status). Retry and the circuit breaker
 * treat these as upstream failures; client-side errors (401, 429, ...) never are.
 */
export abstract class UpstreamError extends GatewayError {}

/** The upstream could not be reached or broke the connection: 502. */
export class UpstreamUnavailableError extends UpstreamError {
  /** True when the request is known not to have reached the upstream (e.g. connection refused). */
  readonly requestNotSent: boolean;

  constructor(target: string, cause: Error, code?: string) {
    super(502, 'bad_gateway', `upstream ${target} is unavailable: ${cause.message}`);
    this.requestNotSent = code !== undefined && NOT_SENT_CODES.has(code);
  }
}

/** The upstream did not send response headers within the route's timeout: 504. */
export class UpstreamTimeoutError extends UpstreamError {
  constructor(target: string, timeoutMs: number) {
    super(504, 'gateway_timeout', `upstream ${target} did not respond within ${timeoutMs}ms`);
  }
}

/**
 * The route's circuit breaker is open: 503 with exactly the body the spec asks
 * for, `{ "error": "service_unavailable", "retry_after": <seconds> }`, plus a
 * Retry-After header.
 */
export class CircuitOpenError extends GatewayError {
  constructor(readonly retryAfterSeconds: number) {
    super(503, 'service_unavailable', 'circuit breaker is open', { 'retry-after': String(retryAfterSeconds) });
  }

  override toBody(): Record<string, unknown> {
    return { error: this.code, retry_after: this.retryAfterSeconds };
  }
}

export class PayloadTooLargeError extends GatewayError {
  constructor(limitBytes: number) {
    super(413, 'payload_too_large', `request body exceeds ${limitBytes} bytes`, { connection: 'close' });
  }
}

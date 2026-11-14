import type { OutgoingHttpHeaders } from 'node:http';

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

/** The upstream could not be reached or broke the connection: 502. */
export class UpstreamUnavailableError extends GatewayError {
  constructor(target: string, cause: Error) {
    super(502, 'bad_gateway', `upstream ${target} is unavailable: ${cause.message}`);
  }
}

/** The upstream did not send response headers within the route's timeout: 504. */
export class UpstreamTimeoutError extends GatewayError {
  constructor(target: string, timeoutMs: number) {
    super(504, 'gateway_timeout', `upstream ${target} did not respond within ${timeoutMs}ms`);
  }
}

export class PayloadTooLargeError extends GatewayError {
  constructor(limitBytes: number) {
    super(413, 'payload_too_large', `request body exceeds ${limitBytes} bytes`, { connection: 'close' });
  }
}

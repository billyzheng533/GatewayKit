import { Readable } from 'node:stream';
import { MAX_TIMER_MS } from '../../config/duration.js';
import type { RetryConfig } from '../../config/types.js';
import { UpstreamError, UpstreamUnavailableError } from '../../errors.js';
import type { GatewayResponse, RequestContext } from '../../pipeline.js';
import type { Feature } from '../index.js';

/** Methods that are safe to send twice (RFC 9110 §9.2.2). */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * Enforces a route's `retry`.
 *
 * - `attempts` is the total number of tries, including the first.
 * - A retry happens when the upstream answers with a status in `on`, or fails
 *   to answer at all: unreachable counts as 502 and timed out as 504, so
 *   `on: [502, 503, 504]` covers both.
 * - Delay before retry n: `initial_delay` (fixed) or `initial_delay * 2^(n-1)`
 *   (exponential). Each attempt gets the route's full timeout.
 * - Only idempotent methods are retried after the upstream may have seen the
 *   request. POST/PATCH are retried only when the connection was refused (or
 *   similar), i.e. the request provably never arrived, so a retry can't
 *   create a duplicate order.
 * - Gateway decisions (an open circuit breaker, rate limiting, auth) are never retried.
 * - If the client disconnects, waiting stops and no further attempts are made.
 */
export const retryFeature: Feature = {
  name: 'retry',
  create(route, { logger }) {
    const config = route.retry;
    if (!config) return null;

    return async (ctx, next) => {
      for (let attempt = 1; ; attempt += 1) {
        const isLastAttempt = attempt >= config.attempts;
        let reason: string;

        try {
          const response = await next(ctx);
          if (isLastAttempt || !shouldRetryStatus(config, ctx, response.status)) return response;
          discardBody(response);
          reason = `status ${response.status}`;
        } catch (err) {
          if (isLastAttempt || !shouldRetryError(config, ctx, err)) throw err;
          reason = (err as Error).message;
        }

        const delayMs = backoffDelay(config, attempt);
        logger.warn('retrying upstream request', {
          request_id: ctx.requestId,
          route: route.path,
          attempt,
          max_attempts: config.attempts,
          delay_ms: delayMs,
          reason,
        });
        await sleep(delayMs, ctx.signal);
      }
    };
  },
};

function shouldRetryStatus(config: RetryConfig, ctx: RequestContext, status: number): boolean {
  return config.onStatus.includes(status) && IDEMPOTENT_METHODS.has(ctx.request.method);
}

function shouldRetryError(config: RetryConfig, ctx: RequestContext, err: unknown): boolean {
  if (!(err instanceof UpstreamError) || ctx.signal.aborted) return false;
  if (!config.onStatus.includes(err.status)) return false;
  if (IDEMPOTENT_METHODS.has(ctx.request.method)) return true;
  return err instanceof UpstreamUnavailableError && err.requestNotSent;
}

/** Delay before the retry that follows failed attempt number `attempt` (1-based). */
export function backoffDelay(config: RetryConfig, attempt: number): number {
  const delay = config.backoff === 'exponential' ? config.initialDelayMs * 2 ** (attempt - 1) : config.initialDelayMs;
  // Exponential growth can pass Node's timer limit, which would fire after 1 ms instead of waiting.
  return Math.min(delay, MAX_TIMER_MS);
}

/** Drop a response we're not going to use, so its connection can be reused or closed. */
function discardBody(response: GatewayResponse): void {
  if (response.body instanceof Readable) response.body.resume();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

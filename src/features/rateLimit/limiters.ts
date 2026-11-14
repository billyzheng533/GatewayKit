import type { RateLimitConfig } from '../../config/types.js';

/**
 * In-memory rate limiters, keyed by client (IP) or a single global key.
 *
 * `consume` is synchronous and Node runs one callback at a time, so a check
 * and its increment can never be interleaved with another request: 50
 * simultaneous requests against a limit of 10 admit exactly 10, without locks.
 *
 * Only admitted requests count. A client that keeps retrying while blocked is
 * not pushed further into the future; its window frees up on schedule.
 */

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window after this one. */
  remaining: number;
  /** Milliseconds until a request from this key would be admitted again (0 when allowed). */
  retryAfterMs: number;
  /** Milliseconds until the window fully resets (for the X-RateLimit-Reset header). */
  resetMs: number;
}

export interface RateLimiter {
  consume(key: string, now: number): RateLimitDecision;
  /** Number of keys currently tracked (exposed for tests and memory monitoring). */
  readonly size: number;
}

export function createLimiter(config: RateLimitConfig): RateLimiter {
  return config.strategy === 'sliding_window'
    ? new SlidingWindowLimiter(config.requests, config.windowMs)
    : new FixedWindowLimiter(config.requests, config.windowMs);
}

/**
 * Fixed window: time is cut into windows of `windowMs` per key, starting at the
 * key's first request; each window admits `limit` requests. O(1) memory per
 * key. Known trade-off: a client can get up to 2x the limit in a short burst
 * straddling a window boundary.
 */
export class FixedWindowLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  get size(): number {
    return this.windows.size;
  }

  consume(key: string, now: number): RateLimitDecision {
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }

    const resetMs = window.start + this.windowMs - now;
    if (window.count >= this.limit) {
      return { allowed: false, limit: this.limit, remaining: 0, retryAfterMs: resetMs, resetMs };
    }
    window.count += 1;
    return { allowed: true, limit: this.limit, remaining: this.limit - window.count, retryAfterMs: 0, resetMs };
  }

  /** Drops expired windows at most once per window length, so idle clients don't leak memory. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

/**
 * Sliding window (log): keeps the timestamps of admitted requests in the last
 * `windowMs` and admits a request only if fewer than `limit` remain. Exact, with
 * no boundary burst. Memory is bounded at `limit` timestamps per key, which is
 * fine for the limits a gateway config uses; for very large limits a sliding
 * window *counter* (two fixed windows, weighted) would be the O(1) alternative.
 */
export class SlidingWindowLimiter implements RateLimiter {
  private readonly logs = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  get size(): number {
    return this.logs.size;
  }

  consume(key: string, now: number): RateLimitDecision {
    this.sweep(now);
    const log = this.prune(this.logs.get(key) ?? [], now);
    this.logs.set(key, log);

    if (log.length >= this.limit) {
      // The oldest admitted request leaving the window frees the next slot.
      const retryAfterMs = (log[0] as number) + this.windowMs - now;
      return { allowed: false, limit: this.limit, remaining: 0, retryAfterMs, resetMs: this.resetMs(log, now) };
    }
    log.push(now);
    return { allowed: true, limit: this.limit, remaining: this.limit - log.length, retryAfterMs: 0, resetMs: this.resetMs(log, now) };
  }

  /** Timestamps are appended in order, so expired ones are always at the front. */
  private prune(log: number[], now: number): number[] {
    let expired = 0;
    while (expired < log.length && (log[expired] as number) <= now - this.windowMs) expired += 1;
    return expired === 0 ? log : log.slice(expired);
  }

  /** When the newest request leaves the window, the key is back to a full budget. */
  private resetMs(log: number[], now: number): number {
    const newest = log.at(-1);
    return newest === undefined ? 0 : newest + this.windowMs - now;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, log] of this.logs) {
      const newest = log.at(-1);
      if (newest === undefined || newest <= now - this.windowMs) this.logs.delete(key);
    }
  }
}

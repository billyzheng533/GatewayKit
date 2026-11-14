import type { CircuitBreakerConfig } from '../../config/types.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

export type Permit =
  | { allowed: true; /** This request is the single half-open probe. */ trial: boolean }
  | { allowed: false; retryAfterMs: number };

export type Outcome = 'success' | 'failure' | 'neutral';

/**
 * Circuit breaker state machine, independent of HTTP so it can be tested with
 * a fake clock.
 *
 *   closed     Requests flow. Failures are timestamped; when `threshold` of
 *              them fall within the last `window`, the breaker opens.
 *   open       Requests are rejected immediately (no upstream call) until
 *              `cooldown` has passed since opening.
 *   half_open  After the cooldown, exactly one trial request is let through.
 *              Success closes the breaker; failure re-opens it for another
 *              full cooldown. Other requests are rejected while the trial runs.
 *
 * All methods are synchronous, so state changes can't interleave between
 * concurrent requests on Node's single thread.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures: number[] = [];
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly onStateChange: (from: BreakerState, to: BreakerState) => void = () => {},
  ) {}

  /** Current state, advancing open -> half_open if the cooldown has passed. */
  getState(now: number): BreakerState {
    if (this.state === 'open' && now - this.openedAt >= this.config.cooldownMs) this.transition('half_open');
    return this.state;
  }

  tryAcquire(now: number): Permit {
    const state = this.getState(now);
    if (state === 'closed') return { allowed: true, trial: false };
    if (state === 'open') return { allowed: false, retryAfterMs: this.openedAt + this.config.cooldownMs - now };
    if (this.trialInFlight) return { allowed: false, retryAfterMs: 0 };
    this.trialInFlight = true;
    return { allowed: true, trial: true };
  }

  /**
   * Records how a permitted request went. `neutral` (e.g. the client hung up)
   * says nothing about the upstream; it only frees the trial slot.
   */
  record(permit: Extract<Permit, { allowed: true }>, outcome: Outcome, now: number): void {
    if (permit.trial) {
      this.trialInFlight = false;
      if (outcome === 'success') {
        this.failures = [];
        this.transition('closed');
      } else if (outcome === 'failure') {
        this.open(now);
      }
      return;
    }
    // Results of requests that started before the breaker opened don't change an open breaker.
    if (this.state !== 'closed' || outcome !== 'failure') return;

    this.failures.push(now);
    const windowStart = now - this.config.windowMs;
    this.failures = this.failures.filter((t) => t > windowStart);
    if (this.failures.length >= this.config.threshold) this.open(now);
  }

  private open(now: number): void {
    this.openedAt = now;
    this.failures = [];
    this.transition('open');
  }

  private transition(to: BreakerState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onStateChange(from, to);
  }
}

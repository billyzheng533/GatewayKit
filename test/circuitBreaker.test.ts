import { describe, expect, it } from 'vitest';
import { CircuitBreaker, type BreakerState } from '../src/features/circuitBreaker/breaker.js';

const config = { threshold: 3, windowMs: 1_000, cooldownMs: 500 };

function breakerWithLog() {
  const transitions: string[] = [];
  const breaker = new CircuitBreaker(config, (from: BreakerState, to: BreakerState) => transitions.push(`${from}->${to}`));
  return { breaker, transitions };
}

/** Acquires a permit at `now` and records the outcome, as one request would. */
function request(breaker: CircuitBreaker, now: number, outcome: 'success' | 'failure' | 'neutral') {
  const permit = breaker.tryAcquire(now);
  if (permit.allowed) breaker.record(permit, outcome, now);
  return permit;
}

describe('CircuitBreaker', () => {
  it('stays closed below the threshold and opens on the threshold-th failure within the window', () => {
    const { breaker, transitions } = breakerWithLog();
    request(breaker, 0, 'failure');
    request(breaker, 100, 'failure');
    expect(breaker.getState(100)).toBe('closed');
    request(breaker, 200, 'failure');
    expect(breaker.getState(200)).toBe('open');
    expect(transitions).toEqual(['closed->open']);
  });

  it('only counts failures inside the window', () => {
    const { breaker } = breakerWithLog();
    request(breaker, 0, 'failure');
    request(breaker, 600, 'failure');
    request(breaker, 1_100, 'failure'); // the failure at t=0 has left the 1s window
    expect(breaker.getState(1_100)).toBe('closed');
    request(breaker, 1_200, 'failure');
    expect(breaker.getState(1_200)).toBe('open');
  });

  it('rejects requests while open and reports the remaining cooldown', () => {
    const { breaker } = breakerWithLog();
    for (const t of [0, 1, 2]) request(breaker, t, 'failure'); // opens at t=2
    expect(breaker.tryAcquire(102)).toEqual({ allowed: false, retryAfterMs: 400 });
  });

  it('lets exactly one trial request through after the cooldown', () => {
    const { breaker } = breakerWithLog();
    for (const t of [0, 1, 2]) request(breaker, t, 'failure');
    expect(breaker.tryAcquire(502)).toEqual({ allowed: true, trial: true });
    expect(breaker.tryAcquire(503)).toEqual({ allowed: false, retryAfterMs: 0 });
  });

  it('closes when the trial succeeds', () => {
    const { breaker, transitions } = breakerWithLog();
    for (const t of [0, 1, 2]) request(breaker, t, 'failure');
    request(breaker, 600, 'success');
    expect(breaker.getState(600)).toBe('closed');
    expect(transitions).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
    // Starts from a clean slate: one new failure doesn't re-open it.
    request(breaker, 700, 'failure');
    expect(breaker.getState(700)).toBe('closed');
  });

  it('re-opens for a full cooldown when the trial fails', () => {
    const { breaker } = breakerWithLog();
    for (const t of [0, 1, 2]) request(breaker, t, 'failure');
    request(breaker, 600, 'failure');
    expect(breaker.getState(600)).toBe('open');
    expect(breaker.tryAcquire(1_000)).toEqual({ allowed: false, retryAfterMs: 100 });
    expect(breaker.tryAcquire(1_100)).toEqual({ allowed: true, trial: true });
  });

  it('frees the trial slot when the trial ends without a verdict (client hung up)', () => {
    const { breaker } = breakerWithLog();
    for (const t of [0, 1, 2]) request(breaker, t, 'failure');
    request(breaker, 600, 'neutral');
    expect(breaker.getState(600)).toBe('half_open');
    expect(breaker.tryAcquire(601)).toEqual({ allowed: true, trial: true });
  });

  it('ignores a late success from a request that started before the breaker opened', () => {
    const { breaker } = breakerWithLog();
    const slow = breaker.tryAcquire(0);
    for (const t of [1, 2, 3]) request(breaker, t, 'failure');
    if (slow.allowed) breaker.record(slow, 'success', 4);
    expect(breaker.getState(4)).toBe('open');
  });
});

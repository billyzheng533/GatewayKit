import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter, SlidingWindowLimiter, createLimiter } from '../src/features/rateLimit/limiters.js';

/** Rate limiter algorithms with a fake clock: no real waiting. */

describe('FixedWindowLimiter (3 per 1000ms)', () => {
  const make = () => new FixedWindowLimiter(3, 1_000);

  it('admits up to the limit, then rejects until the window resets', () => {
    const limiter = make();
    expect([0, 10, 20].map((t) => limiter.consume('a', t).allowed)).toEqual([true, true, true]);
    expect(limiter.consume('a', 30)).toEqual({ allowed: false, limit: 3, remaining: 0, retryAfterMs: 970, resetMs: 970 });
    expect(limiter.consume('a', 999).allowed).toBe(false);
    expect(limiter.consume('a', 1_000).allowed).toBe(true); // new window
  });

  it('counts down `remaining`', () => {
    const limiter = make();
    expect([0, 1, 2].map((t) => limiter.consume('a', t).remaining)).toEqual([2, 1, 0]);
  });

  it('does not count rejected requests', () => {
    const limiter = make();
    for (let t = 0; t < 10; t += 1) limiter.consume('a', t); // 3 admitted, 7 rejected
    expect(limiter.consume('a', 1_000)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('keeps separate budgets per key', () => {
    const limiter = make();
    for (const t of [0, 1, 2]) limiter.consume('a', t);
    expect(limiter.consume('a', 3).allowed).toBe(false);
    expect(limiter.consume('b', 3).allowed).toBe(true);
  });

  it('allows a burst of up to 2x the limit across a window boundary (the known trade-off)', () => {
    const limiter = make();
    limiter.consume('a', 0); // window starts at t=0
    const late = [997, 998, 999].map((t) => limiter.consume('a', t).allowed);
    const early = [1_000, 1_001, 1_002].map((t) => limiter.consume('a', t).allowed);
    expect([...late, ...early]).toEqual([true, true, false, true, true, true]);
  });

  it('forgets idle keys once their window has passed', () => {
    const limiter = make();
    limiter.consume('a', 0);
    limiter.consume('b', 0);
    expect(limiter.size).toBe(2);
    limiter.consume('c', 5_000);
    expect(limiter.size).toBe(1);
  });
});

describe('SlidingWindowLimiter (3 per 1000ms)', () => {
  const make = () => new SlidingWindowLimiter(3, 1_000);

  it('admits up to the limit within any rolling window', () => {
    const limiter = make();
    expect([0, 100, 200].map((t) => limiter.consume('a', t).allowed)).toEqual([true, true, true]);
    expect(limiter.consume('a', 300).allowed).toBe(false);
  });

  it('frees one slot as each admitted request ages out, and says when', () => {
    const limiter = make();
    for (const t of [0, 100, 200]) limiter.consume('a', t);
    expect(limiter.consume('a', 500)).toMatchObject({ allowed: false, retryAfterMs: 500 });
    expect(limiter.consume('a', 1_000)).toMatchObject({ allowed: true, remaining: 0 }); // t=0 left the window
    expect(limiter.consume('a', 1_050).allowed).toBe(false); // t=100 hasn't yet
    expect(limiter.consume('a', 1_100).allowed).toBe(true);
  });

  it('has no boundary burst: at most 3 in any 1000ms', () => {
    const limiter = make();
    limiter.consume('a', 0);
    const results = [997, 998, 999, 1_000, 1_001, 1_002].map((t) => limiter.consume('a', t).allowed);
    expect(results).toEqual([true, true, false, true, false, false]);
  });

  it('does not count rejected requests', () => {
    const limiter = make();
    for (let t = 0; t < 10; t += 1) limiter.consume('a', t);
    expect(limiter.consume('a', 1_000).allowed).toBe(true);
  });

  it('keeps separate budgets per key and forgets idle keys', () => {
    const limiter = make();
    for (const t of [0, 1, 2]) limiter.consume('a', t);
    expect(limiter.consume('b', 3).allowed).toBe(true);
    expect(limiter.size).toBe(2);
    limiter.consume('c', 5_000);
    expect(limiter.size).toBe(1);
  });
});

describe('createLimiter', () => {
  it('picks the algorithm from the config strategy', () => {
    const base = { requests: 1, windowMs: 1_000, per: 'ip' as const };
    expect(createLimiter({ ...base, strategy: 'fixed_window' })).toBeInstanceOf(FixedWindowLimiter);
    expect(createLimiter({ ...base, strategy: 'sliding_window' })).toBeInstanceOf(SlidingWindowLimiter);
  });
});

describe('cleanup of idle clients', () => {
  it('checks only a small batch per request, and clears every idle client over a few requests', () => {
    const limiter = new FixedWindowLimiter(5, 1_000);
    for (let i = 0; i < 500; i += 1) limiter.consume(`idle-${i}`, 0);
    expect(limiter.size).toBe(500);

    limiter.consume('active', 2_000); // all 500 have expired; one request removes only a batch
    expect(limiter.size).toBeGreaterThan(400);

    for (let i = 0; i < 20; i += 1) limiter.consume('active', 2_000);
    expect(limiter.size).toBe(1);
  });

  it('works the same for the sliding window', () => {
    const limiter = new SlidingWindowLimiter(5, 1_000);
    for (let i = 0; i < 500; i += 1) limiter.consume(`idle-${i}`, 0);
    limiter.consume('active', 2_000);
    expect(limiter.size).toBeGreaterThan(400);
    for (let i = 0; i < 20; i += 1) limiter.consume('active', 2_000);
    expect(limiter.size).toBe(1);
  });
});

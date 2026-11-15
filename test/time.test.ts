import { describe, expect, it } from 'vitest';
import { secondsUntil } from '../src/time.js';

describe('secondsUntil', () => {
  it.each([
    [-500, 0],
    [0, 0],
    [1, 1],
    [999, 1],
    [1_000, 1],
    [1_001, 2],
    [30_000, 30],
  ])('%i ms rounds up to %i s', (ms, seconds) => {
    expect(secondsUntil(ms)).toBe(seconds);
  });
});

import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/config/duration.js';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['1.5s', 1_500],
    ['5m', 300_000],
    ['1h', 3_600_000],
    [' 10s ', 10_000],
    ['1m30s', 90_000],
    ['1h30m', 5_400_000],
    ['1h0m30s', 3_630_000],
    ['2s500ms', 2_500],
  ])('parses %j as %i ms', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['30', 's', '-5s', '10 s', '1d', '', '1m 30s', '1m30', 'm30s'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(/invalid duration/);
  });
});

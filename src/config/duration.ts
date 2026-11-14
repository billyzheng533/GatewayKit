const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/**
 * Parses a duration string such as "500ms", "30s", "1.5m" or "1h" into milliseconds.
 * Throws on anything else, including bare numbers: the unit is never guessed.
 */
export function parseDuration(input: string): number {
  const match = DURATION_RE.exec(input.trim());
  if (!match) {
    throw new Error(`invalid duration "${input}" (expected a number with a unit, e.g. "500ms", "30s", "5m", "1h")`);
  }
  const [, amount, unit] = match as unknown as [string, string, keyof typeof UNIT_MS];
  return Math.round(Number(amount) * UNIT_MS[unit]);
}

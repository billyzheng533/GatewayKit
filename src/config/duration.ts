const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const PART = '(\\d+(?:\\.\\d+)?)(ms|s|m|h)';
const DURATION_RE = new RegExp(`^(?:${PART})+$`);
const PART_RE = new RegExp(PART, 'g');

/**
 * The longest delay a Node timer supports (2^31 - 1 ms, about 24.8 days).
 * Longer timers don't wait longer: Node fires them after 1 ms. So any duration
 * that becomes a timer (timeouts, retry delays, health check intervals) must
 * be at most this.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Parses a duration string into milliseconds: "500ms", "30s", "1.5m", "1h",
 * or Go-style combinations such as "1m30s" and "1h30m".
 * Throws on anything else, including bare numbers: the unit is never guessed.
 */
export function parseDuration(input: string): number {
  const text = input.trim();
  if (!DURATION_RE.test(text)) {
    throw new Error(
      `invalid duration "${input}" (expected a number with a unit, e.g. "500ms", "30s", "5m", "1h", "1m30s")`,
    );
  }
  let total = 0;
  for (const [, amount, unit] of text.matchAll(PART_RE)) {
    total += Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
  }
  return Math.round(total);
}

/**
 * Whole seconds until something happens, for headers like Retry-After: rounded
 * up so a client never retries too early, and 0 only when it's already time.
 */
export function secondsUntil(ms: number): number {
  return ms <= 0 ? 0 : Math.ceil(ms / 1000);
}

import cronstrue from 'cronstrue';

export function getCronDescription(expression: string): string {
  try {
    return cronstrue.toString(expression);
  } catch {
    return 'Invalid expression';
  }
}

/**
 * Reject cron expressions with a leading seconds field (6 or more fields). The
 * scheduler is minute-granular, so the seconds field could never be honored.
 * Nicknames like `@daily` (one token) pass. Returns an error message or null
 * when the field count is acceptable.
 */
export function getCronFieldError(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed && trimmed.split(/\s+/).length >= 6) {
    return 'Use 5 fields (minute hour day month weekday). The seconds field is not supported.';
  }
  return null;
}

export function formatTimestamp(ts: number | null): string {
  if (ts == null) return '-';
  return new Date(ts).toLocaleString();
}

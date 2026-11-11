/**
 * Safely extract a message from an unknown caught value.
 *
 * Replaces the repeated `error instanceof Error ? error.message : '...'`
 * pattern throughout the codebase.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * True when a Docker inspect failure means the resource does not exist.
 *
 * A structured status is authoritative: when the error carries a numeric
 * `statusCode`, only 404 is not-found and every other status is a real
 * failure. Message matching is a fallback for errors that carry no status at
 * all, and it needs a standalone `404` token or Docker's own "no such ..."
 * wording, so a message that merely embeds the digits cannot turn a server
 * error into a missing resource.
 */
export function isDockerNotFoundError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number') return statusCode === 404;
  if (!(error instanceof Error)) return false;
  return /\b404\b/.test(error.message) || /no such (?:network|image)\b/i.test(error.message);
}

/** True when `error` is a better-sqlite3 unique-constraint violation. */
export function isSqliteUniqueViolation(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

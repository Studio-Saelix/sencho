/** Shown when the opened compose filename is no longer the file on disk. */
export const COMPOSE_SOURCE_CHANGED_PROMPT =
  'The compose file that was open is no longer the file on disk. Reload the current file and discard your edits?';

/**
 * True when the operator chooses to discard the local draft and load the file
 * that is on disk. False keeps the draft. A source change is never overwritten.
 */
export function confirmComposeSourceReload(confirm: (message: string) => boolean): boolean {
  return confirm(COMPOSE_SOURCE_CHANGED_PROMPT);
}

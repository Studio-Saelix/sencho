/**
 * Provenance reader for the quick-links hook. Kept as a separate module so the
 * sync layer can read pin provenance without importing the React hook.
 */

export type QuickLinksProvenance =
  | { status: 'valid' }
  | { status: 'unset' };

/** Read the raw provenance of the quick-links cache: 'unset' means no valid
 *  list has ever been persisted (missing key, malformed JSON, non-array JSON);
 *  'valid' includes a deliberately saved empty list. */
export function readQuickLinksProvenance(): QuickLinksProvenance {
  if (typeof window === 'undefined') return { status: 'unset' };
  try {
    const raw = window.localStorage.getItem('sencho.appearance.topNavQuickLinks');
    if (raw === null) return { status: 'unset' };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { status: 'unset' };
    return { status: 'valid' };
  } catch {
    return { status: 'unset' };
  }
}

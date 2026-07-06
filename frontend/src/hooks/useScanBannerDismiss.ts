import { useCallback, useEffect, useMemo, useState } from 'react';

// Bumped when a dismiss is written so sibling consumers re-read localStorage
// and agree, without a full page reload.
const DISMISS_EVENT = 'sencho:scan-banner-dismiss-changed';

const keyFor = (stackName: string, nodeId: number | undefined) =>
  `sencho.scanBannerDismissed.${stackName}.${nodeId ?? 'local'}`;

/** Fingerprint encodes the scan outcome: any new scan run (different attemptedAt)
 *  or status change produces a new fingerprint, re-surfacing the banner. */
function fingerprint(status: string | null, attemptedAt: number | undefined): string {
  if (!status) return '';
  return `${status}:${attemptedAt ?? 0}`;
}

/**
 * Per-stack dismiss for the post-deploy scan warning banner, persisted in
 * localStorage and keyed to a fingerprint of the scan run. Dismissal sticks
 * across reloads for the same scan outcome, and clears automatically once a
 * new scan runs (different attemptedAt) or the status changes.
 */
export function useScanBannerDismiss(
  stackName: string,
  nodeId: number | undefined,
  scanStatus: { status: string | null; attemptedAt?: number } | null,
) {
  const fp = useMemo(
    () => fingerprint(scanStatus?.status ?? null, scanStatus?.attemptedAt),
    [scanStatus?.status, scanStatus?.attemptedAt],
  );
  const storageKey = keyFor(stackName, nodeId);

  const read = useCallback(() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  }, [storageKey]);

  const [storedFp, setStoredFp] = useState<string | null>(() => read());

  useEffect(() => {
    setStoredFp(read());
    const handler = () => setStoredFp(read());
    window.addEventListener(DISMISS_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(DISMISS_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, [read]);

  const dismissed = fp !== '' && storedFp === fp;

  const dismiss = useCallback(() => {
    try { localStorage.setItem(storageKey, fp); } catch { /* ignore */ }
    setStoredFp(fp);
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }, [storageKey, fp]);

  return { dismissed, dismiss };
}

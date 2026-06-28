import { useCallback, useEffect, useMemo, useState } from 'react';

/** Minimal shape of a preflight finding needed to fingerprint a result set. */
interface FindingLike {
  ruleId: string;
  severity: string;
  service?: string;
}

// Bumped when a dismiss is written so sibling consumers (the Doctor tab dot and
// the banner) re-read localStorage and agree, without a full page reload.
const DISMISS_EVENT = 'sencho:preflight-dismiss-changed';

const keyFor = (stackName: string, nodeId: number | undefined) =>
  `sencho.doctorDismissed.${stackName}.${nodeId ?? 'local'}`;

/** Stable, content-based fingerprint of the findings. Order-independent so a
 *  reordered-but-identical result still counts as dismissed; any added, removed,
 *  or re-severitied finding changes it, which re-surfaces the banner. */
function fingerprint(findings: FindingLike[] | undefined): string {
  if (!findings || findings.length === 0) return '';
  return findings
    .map((f) => `${f.ruleId}:${f.severity}:${f.service ?? ''}`)
    .sort()
    .join('|');
}

/**
 * Per-stack dismiss for the Compose Doctor high-risk banner, persisted in
 * localStorage and keyed to a fingerprint of the findings: the dismissal sticks
 * across reloads and re-runs that produce identical findings, and clears
 * automatically once the findings change. Used by both the banner (to hide
 * itself) and the Doctor tab dot (to clear), kept in sync via a window event.
 */
export function usePreflightDismiss(
  stackName: string,
  nodeId: number | undefined,
  findings: FindingLike[] | undefined,
) {
  const fp = useMemo(() => fingerprint(findings), [findings]);
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

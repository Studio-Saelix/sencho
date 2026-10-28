import { useCallback, useEffect, useState } from 'react';

/**
 * Per-stack "hide this until it changes" for a banner, kept in this browser.
 * The storage keys and event names are what existing dismissals were written
 * under, so they must not change.
 */
const CHANNELS = {
  // The Compose Doctor high-risk banner and the Doctor tab dot.
  doctor: { keyPrefix: 'sencho.doctorDismissed.', event: 'sencho:preflight-dismiss-changed' },
  // The post-deploy scan warning banner.
  scanBanner: { keyPrefix: 'sencho.scanBannerDismissed.', event: 'sencho:scan-banner-dismiss-changed' },
} as const;

export type DismissChannel = keyof typeof CHANNELS;

/** Minimal shape of a preflight finding needed to fingerprint a result set. */
interface FindingLike {
  ruleId: string;
  severity: string;
  service?: string;
}

/** Stable, content-based fingerprint of the findings. Order-independent so a
 *  reordered-but-identical result still counts as dismissed; any added, removed,
 *  or re-severitied finding changes it, which re-surfaces the banner. An empty
 *  list has nothing to dismiss, so its fingerprint is empty. */
export function preflightFingerprint(findings: FindingLike[] | undefined): string {
  if (!findings || findings.length === 0) return '';
  return findings
    .map((f) => `${f.ruleId}:${f.severity}:${f.service ?? ''}`)
    .sort()
    .join('|');
}

/** Encodes the scan outcome: any new scan run (different attemptedAt) or status
 *  change produces a new fingerprint, re-surfacing the banner. No status means
 *  no scan to dismiss, so the fingerprint is empty. */
export function scanBannerFingerprint(status: string | null | undefined, attemptedAt: number | undefined): string {
  if (!status) return '';
  return `${status}:${attemptedAt ?? 0}`;
}

/**
 * Dismiss state for one stack on one node, persisted in localStorage against a
 * fingerprint of what was shown: the dismissal sticks across reloads while the
 * fingerprint is unchanged and lifts on its own once it changes. Consumers of
 * the same channel (a banner and its tab dot) stay in sync through a window
 * event, without a reload. An empty fingerprint is never dismissed, and a
 * storage that cannot be read or written leaves the banner showing.
 */
export function useStackDismiss(
  channel: DismissChannel,
  stackName: string,
  nodeId: number | undefined,
  fingerprint: string,
) {
  const { keyPrefix, event } = CHANNELS[channel];
  const storageKey = `${keyPrefix}${stackName}.${nodeId ?? 'local'}`;

  const read = useCallback(() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  }, [storageKey]);

  const [storedFp, setStoredFp] = useState<string | null>(() => read());

  useEffect(() => {
    setStoredFp(read());
    const handler = () => setStoredFp(read());
    window.addEventListener(event, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(event, handler);
      window.removeEventListener('storage', handler);
    };
  }, [read, event]);

  const dismissed = fingerprint !== '' && storedFp === fingerprint;

  const dismiss = useCallback(() => {
    if (fingerprint === '') return;
    try { localStorage.setItem(storageKey, fingerprint); } catch { /* storage unavailable: the dismissal cannot persist, so the banner stays visible */ }
    setStoredFp(fingerprint);
    window.dispatchEvent(new Event(event));
  }, [storageKey, fingerprint, event]);

  return { dismissed, dismiss };
}

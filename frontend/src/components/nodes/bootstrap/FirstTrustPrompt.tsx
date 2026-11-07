import { HostKeyCompare } from './HostKeyCompare';

/**
 * The consent for a host that has no stored pin. When the live key differs from
 * the one the operator reviewed, both identities are shown and the wording says
 * the new key will be pinned, because no pin exists to replace. A live change
 * discards the inspection, so only the dialog's no-result view passes a
 * reviewed key; the inspection view always shows the key that was reviewed.
 */
export function FirstTrustPrompt({
  algorithm,
  fingerprint,
  knownHostsLine,
  supersededFingerprint,
  trusted,
  onTrustedChange,
}: {
  algorithm: string;
  fingerprint: string;
  knownHostsLine: string;
  supersededFingerprint: string | null;
  trusted: boolean;
  onTrustedChange: (trusted: boolean) => void;
}) {
  const changedSinceReview = supersededFingerprint !== null;
  return (
    <>
      {changedSinceReview && (
        <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5" data-testid="host-key-changed-since-review">
          <p className="text-xs text-destructive">
            The host presented a different key than the one you reviewed. No key is pinned for this host yet.
            Trust the new key only if you know why it changed.
          </p>
          <p className="mt-1 break-all font-mono text-[10px] text-stat-subtitle">Reviewed: {supersededFingerprint}</p>
          <p className="mt-1 break-all font-mono text-[10px] text-stat-subtitle">Observed now: {fingerprint}</p>
        </div>
      )}
      <HostKeyCompare algorithm={algorithm} knownHostsLine={knownHostsLine} />
      <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={trusted}
          onChange={(event) => onTrustedChange(event.target.checked)}
        />
        {changedSinceReview ? 'I trust the new host key and want it pinned for this host.' : 'I trust this host key.'}
      </label>
    </>
  );
}

/**
 * Evidence availability: what the deploy gate may do when it cannot prove a
 * target is safe.
 *
 * Sits on the Security Policies tab beside the honor-suppressions toggle,
 * because it configures the same gate from the other side: that toggle says what
 * counts as a finding, this one says what to do when there is no finding to
 * count. The active default is stated on every row rather than left implicit,
 * so "why was this allowed" is answerable from the screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control';

type Outcome = 'allow' | 'warn' | 'block';

interface EvidencePolicy {
  scannerUnavailable: Outcome;
  scanFailure: Outcome;
  candidateUnproven: Outcome;
  isDefault: boolean;
}

/**
 * The subset the PUT accepts, and only partially: `isDefault` is server-computed
 * and read-only, so it must not be sendable, while any single field may be saved
 * on its own.
 */
type WritableEvidencePolicy = Partial<Omit<EvidencePolicy, 'isDefault'>>;

interface EvidencePolicyResponse {
  policy: EvidencePolicy;
  defaults: EvidencePolicy;
  outcomes: Outcome[];
}

const OUTCOME_OPTIONS: SegmentedControlOption<Outcome>[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'warn', label: 'Warn' },
  { value: 'block', label: 'Block' },
];

const VALID_OUTCOMES: readonly string[] = ['allow', 'warn', 'block'];

const isOutcome = (v: unknown): v is Outcome => typeof v === 'string' && VALID_OUTCOMES.includes(v);

function parsePolicy(value: unknown): EvidencePolicy | null {
  if (!value || typeof value !== 'object') return null;
  const q = value as Partial<EvidencePolicy>;
  if (
    !isOutcome(q.scannerUnavailable) ||
    !isOutcome(q.scanFailure) ||
    !isOutcome(q.candidateUnproven) ||
    typeof q.isDefault !== 'boolean'
  ) {
    return null;
  }
  return q as EvidencePolicy;
}

/**
 * Validate the read at the network boundary. This panel is rendered inside the
 * Policies tab, so a throw here takes the whole tab down; and a node behind the
 * proxy can legitimately answer with a shape this build does not know. Both are
 * "could not read", which the caller already knows how to say.
 *
 * The read carries the shipped defaults alongside the active values on purpose:
 * the UI has to state the default, so it cannot render without them.
 */
function parseEvidencePolicyResponse(body: unknown): EvidencePolicyResponse | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Partial<EvidencePolicyResponse>;
  const policy = parsePolicy(raw.policy);
  const defaults = parsePolicy(raw.defaults);
  if (!policy || !defaults) return null;
  return {
    policy,
    defaults,
    outcomes: [...VALID_OUTCOMES] as Outcome[],
  };
}

/** One row: what it decides, and what the shipped default does. */
function PolicyRow({
  label,
  help,
  value,
  defaultValue,
  disabled,
  busy,
  onChange,
}: {
  label: string;
  help: string;
  value: Outcome;
  defaultValue: Outcome;
  disabled: boolean;
  busy: boolean;
  onChange: (next: Outcome) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-sm">{label}</Label>
        <SegmentedControl
          value={value}
          options={OUTCOME_OPTIONS}
          onChange={onChange}
          disabled={disabled || busy}
          ariaLabel={label}
        />
      </div>
      <p className="text-xs text-muted-foreground mt-1">{help}</p>
      {value !== defaultValue && (
        <p className="text-xs text-muted-foreground mt-0.5">
          Changed from the default ({defaultValue}).
        </p>
      )}
    </div>
  );
}

export function EvidencePolicyPanel() {
  const { isAdmin } = useAuth();
  const [state, setState] = useState<EvidencePolicyResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * `isCancelled` lets the mount effect ignore a response that arrives after the
   * panel has gone: switching to a remote node unmounts it, and a late reply
   * would otherwise set state on a component that is no longer there. The retry
   * button passes nothing, because it only runs while mounted.
   *
   * Deliberately uncovered by a test. React 18 dropped the setState-after-unmount
   * warning, so the guard has no observable effect through the UI and any test
   * asserting one could not fail. It is kept as conformance with the pattern the
   * sibling panel in this tab already uses.
   */
  const load = useCallback(async (isCancelled?: () => boolean) => {
    try {
      const res = await apiFetch('/security/evidence-policy');
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = parseEvidencePolicyResponse(await res.json());
      if (isCancelled?.()) return;
      if (!data) throw new Error('unreadable policy payload');
      setState(data);
      setLoadFailed(false);
    } catch {
      if (isCancelled?.()) return;
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    const guard = { cancelled: false };
    void load(() => guard.cancelled);
    return () => {
      guard.cancelled = true;
    };
  }, [load]);

  const save = useCallback(
    // Only the writable fields. `EvidencePolicy` also carries `isDefault`, which
    // the server's unknown-field check rejects, so it must not be sendable here.
    async (patch: WritableEvidencePolicy) => {
      setBusy(true);
      try {
        const res = await apiFetch('/security/evidence-policy', {
          method: 'PUT',
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error || 'Failed to update the evidence policy');
        }
        // The write answers with the resolved policy alone, not the whole read
        // envelope, so it is parsed on its own terms.
        const policy = parsePolicy(await res.json().then((b) => (b as { policy?: unknown })?.policy));
        if (!policy) throw new Error('unreadable policy payload');
        setState((prev) => (prev ? { ...prev, policy } : prev));
        toast.success('Evidence policy updated');
      } catch (err) {
        toast.error((err as Error)?.message || 'Failed to update the evidence policy');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (loadFailed) {
    return (
      <div className="rounded-lg border border-card-border bg-card px-4 py-3">
        <Label className="text-sm">Evidence availability</Label>
        <p className="text-xs text-muted-foreground mt-1">
          The policy could not be read, so what this node currently enforces is unknown here. Deploys
          continue; a read failure falls back to the shipped defaults, which allow a deploy when the
          scanner is missing and block one whose scan failed. Reload to see the active values.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 text-xs underline underline-offset-2"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!state) {
    // Layout-matched placeholder rather than a blank pane, so the panel does not
    // pop into existence or shift the tab when the policy arrives. Sized to the
    // loaded card: a title block, three label/control rows, and the helper line.
    return (
      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel px-4 py-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-72 mt-2" />
        <div className="mt-4 space-y-4">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex flex-wrap items-center justify-between gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-7 w-40 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const { policy, defaults } = state;
  const disabled = !isAdmin;

  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel px-4 py-3 space-y-4">
      <div>
        <Label className="text-sm">Evidence availability</Label>
        <p className="text-xs text-muted-foreground mt-0.5">
          What a deploy gate may do when it cannot prove the images are safe. Each row shows the
          active setting and the shipped default.
        </p>
      </div>

      <PolicyRow
        label="Scanner unavailable"
        help={`When the vulnerability scanner is not installed or not responding on this node. Default: ${defaults.scannerUnavailable}.`}
        value={policy.scannerUnavailable}
        defaultValue={defaults.scannerUnavailable}
        disabled={disabled}
        busy={busy}
        onChange={(next) => void save({ scannerUnavailable: next })}
      />

      <PolicyRow
        label="Scan failed"
        help="When a scan was started for an image and did not finish. Default: block."
        value={policy.scanFailure}
        defaultValue={defaults.scanFailure}
        disabled={disabled}
        busy={busy}
        onChange={(next) => void save({ scanFailure: next })}
      />

      <PolicyRow
        label="Candidate not evaluated"
        help="When an image a Git-managed source is about to accept cannot be evaluated. This path has no person in the loop, so it is held by default even if you allow a failed scan above. Default: block."
        value={policy.candidateUnproven}
        defaultValue={defaults.candidateUnproven}
        disabled={disabled}
        busy={busy}
        onChange={(next) => void save({ candidateUnproven: next })}
      />

      {!isAdmin && (
        <p className="text-xs text-muted-foreground">
          These settings are read-only for your role.
        </p>
      )}
    </div>
  );
}

export default EvidencePolicyPanel;

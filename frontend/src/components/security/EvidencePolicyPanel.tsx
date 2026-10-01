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
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control';
import { Input } from '@/components/ui/input';

type Outcome = 'allow' | 'warn' | 'block';

interface EvidencePolicy {
  scannerUnavailable: Outcome;
  scanFailure: Outcome;
  staleScan: Outcome;
  maxScanAgeDays: number;
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
  maxScanAgeDaysCeiling: number;
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
    !isOutcome(q.staleScan) ||
    typeof q.maxScanAgeDays !== 'number' ||
    !Number.isFinite(q.maxScanAgeDays) ||
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
  const ceiling =
    typeof raw.maxScanAgeDaysCeiling === 'number' && raw.maxScanAgeDaysCeiling > 0
      ? raw.maxScanAgeDaysCeiling
      : 365;
  return {
    policy,
    defaults,
    outcomes: [...VALID_OUTCOMES] as Outcome[],
    maxScanAgeDaysCeiling: ceiling,
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
  const [daysDraft, setDaysDraft] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/security/evidence-policy');
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = parseEvidencePolicyResponse(await res.json());
      if (!data) throw new Error('unreadable policy payload');
      setState(data);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
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
        setDaysDraft(null);
        toast.success('Evidence policy updated');
      } catch (err) {
        toast.error((err as Error)?.message || 'Failed to update the evidence policy');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const commitDays = useCallback(() => {
    if (!state) return;
    const raw = daysDraft;
    if (raw === null) return;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > state.maxScanAgeDaysCeiling) {
      toast.error(`Enter a whole number of days between 0 and ${state.maxScanAgeDaysCeiling}`);
      setDaysDraft(null);
      return;
    }
    if (parsed === state.policy.maxScanAgeDays) {
      setDaysDraft(null);
      return;
    }
    void save({ maxScanAgeDays: parsed });
  }, [daysDraft, save, state]);

  if (loadFailed) {
    return (
      <div className="rounded-lg border border-card-border bg-card px-4 py-3">
        <Label className="text-sm">Evidence availability</Label>
        <p className="text-xs text-muted-foreground mt-1">
          The evidence policy could not be read, so deploys are using the shipped defaults: a missing
          scanner still allows the deploy, a failed scan blocks it, and scan age is not limited.
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

  if (!state) return null;

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
        label="Scan too old"
        help="When a scan finished but is older than the freshness limit below. A stale scan still reports its findings and still blocks on them; this row only decides whether its age stops the deploy. Default: allow."
        value={policy.staleScan}
        defaultValue={defaults.staleScan}
        disabled={disabled}
        busy={busy}
        onChange={(next) => void save({ staleScan: next })}
      />

      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="evidence-max-scan-age" className="text-sm">
            Freshness limit (days)
          </Label>
          <Input
            id="evidence-max-scan-age"
            type="number"
            min={0}
            max={state.maxScanAgeDaysCeiling}
            step={1}
            disabled={disabled || busy}
            value={daysDraft ?? String(policy.maxScanAgeDays)}
            onChange={(e) => setDaysDraft(e.target.value)}
            onBlur={commitDays}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDays();
            }}
            className="w-28"
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          How old a completed scan may be before it counts as stale. 0 (the default) sets no limit,
          so no scan is ever stale.
        </p>
      </div>

      {!isAdmin && (
        <p className="text-xs text-muted-foreground">
          These settings are read-only for your role.
        </p>
      )}
    </div>
  );
}

export default EvidencePolicyPanel;

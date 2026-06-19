import { useEffect, useState } from 'react';
import {
  Check, CircleHelp, Info, ShieldAlert, TriangleAlert, Camera, type LucideIcon,
} from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useAuth } from '@/context/AuthContext';

// Mirrors the backend payload shape (the frontend never imports backend).
type ReadinessVerdict = 'ready' | 'ready_with_warnings' | 'review_required' | 'blocked' | 'unknown';
type SignalStatus = 'ok' | 'warning' | 'attention' | 'blocked' | 'unknown';

interface ReadinessSignal {
  id: string;
  status: SignalStatus;
  title: string;
  detail: string;
  affectsVerdict: boolean;
}

interface UpdateReadinessReport {
  stack: string;
  computedAt: number;
  verdict: ReadinessVerdict;
  signals: ReadinessSignal[];
}

const FETCH_TIMEOUT_MS = 4_000;

const VERDICT_META: Record<ReadinessVerdict, { label: string; icon: LucideIcon; tone: string; line: string }> = {
  ready: {
    label: 'ready',
    icon: Check,
    tone: 'border-success/40 bg-success/[0.06] text-success',
    line: 'Nothing stands out; the update can proceed.',
  },
  ready_with_warnings: {
    label: 'ready with warnings',
    icon: Info,
    tone: 'border-info/40 bg-info/[0.06] text-info',
    line: 'The update can proceed; review the warnings below first.',
  },
  review_required: {
    label: 'review required',
    icon: TriangleAlert,
    tone: 'border-warning/40 bg-warning/[0.06] text-warning',
    line: 'Something needs a look before this update.',
  },
  blocked: {
    label: 'blocked',
    icon: ShieldAlert,
    tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
    line: 'A blocker was found. Proceeding is likely to fail or be stopped by policy.',
  },
  unknown: {
    label: 'unknown',
    icon: CircleHelp,
    tone: 'border-muted bg-card/40 text-stat-subtitle',
    line: 'Readiness could not be fully verified; proceed with care.',
  },
};

// The `?? unknown` fallbacks at the lookup sites are forward-compat guards: a
// newer backend may send statuses this build does not know.
const SIGNAL_META: Record<SignalStatus, { icon: LucideIcon; tone: string }> = {
  ok: { icon: Check, tone: 'text-success' },
  warning: { icon: Info, tone: 'text-info' },
  attention: { icon: TriangleAlert, tone: 'text-warning' },
  blocked: { icon: ShieldAlert, tone: 'text-destructive' },
  unknown: { icon: CircleHelp, tone: 'text-stat-subtitle' },
};

const UNKNOWN_FALLBACK = (detail: string): UpdateReadinessReport => ({
  stack: '',
  computedAt: Date.now(),
  verdict: 'unknown',
  signals: [{
    id: 'readiness',
    status: 'unknown',
    title: 'Readiness check',
    detail,
    affectsVerdict: true,
  }],
});

interface UpdateReadinessDialogProps {
  open: boolean;
  stackName: string;
  /**
   * Node captured when the dialog opened. The readiness fetch and snapshot
   * coverage run against this node, not the live active node, so a node switch
   * while the dialog is open cannot mismatch the readiness from the update.
   */
  nodeId: number | null;
  onCancel: () => void;
  /** Caller closes the dialog and starts the update. */
  onProceed: () => void;
}

/**
 * Pre-update readiness check. Advisory only: every verdict, including
 * blocked and unknown, keeps Proceed enabled; the scan-policy gate remains
 * the single hard block. A slow or failed readiness fetch degrades to an
 * unknown verdict so this dialog can never strand the update path.
 */
export function UpdateReadinessDialog({ open, stackName, nodeId, onCancel, onProceed }: UpdateReadinessDialogProps) {
  const { isAdmin } = useAuth();

  const [report, setReport] = useState<UpdateReadinessReport | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [snapshotKnown, setSnapshotKnown] = useState(false);
  const [snapshotFirst, setSnapshotFirst] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) {
      setReport(null);
      setSnapshotAt(null);
      setSnapshotKnown(false);
      setSnapshotFirst(false);
      setWorking(false);
      return;
    }
    setReport(null);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    const load = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/update-readiness`, { nodeId, signal: controller.signal });
        if (!res.ok) {
          const unreachable = res.status === 502 || res.status === 503 || res.status === 504;
          setReport(UNKNOWN_FALLBACK(unreachable
            ? 'The node may be unreachable; readiness could not be verified.'
            : 'The readiness check failed; readiness could not be verified.'));
          return;
        }
        setReport(await res.json() as UpdateReadinessReport);
      } catch {
        // The cleanup abort (dialog closed) must not write a stale fake
        // verdict; only the 4s timer earns the timed-out wording.
        if (controller.signal.aborted && !timedOut) return;
        setReport(UNKNOWN_FALLBACK(timedOut
          ? 'The readiness check did not respond in time.'
          : 'The readiness check could not be reached.'));
      }
    };
    void load();

    // Snapshot coverage lives only in the hub database; merged client-side.
    const loadCoverage = async () => {
      if (!isAdmin || nodeId === null) return;
      try {
        const res = await apiFetch(
          `/fleet/snapshots/coverage?nodeId=${nodeId}&stackName=${encodeURIComponent(stackName)}`,
          { localOnly: true, signal: controller.signal },
        );
        if (!res.ok) {
          console.warn('[UpdateReadiness] snapshot coverage unavailable:', res.status);
          return;
        }
        const body = await res.json() as { latestAt: number | null };
        setSnapshotAt(body.latestAt);
        setSnapshotKnown(true);
      } catch (e) {
        // Coverage is supplemental; the dialog renders without the row.
        if (!controller.signal.aborted) {
          console.warn('[UpdateReadiness] snapshot coverage unavailable:', e);
        }
      }
    };
    void loadCoverage();

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, stackName, nodeId, isAdmin]);

  const proceed = async () => {
    if (snapshotFirst) {
      setWorking(true);
      try {
        const res = await apiFetch('/fleet/snapshots', {
          method: 'POST',
          localOnly: true,
          body: JSON.stringify({ description: `Pre-update snapshot: ${stackName}` }),
        });
        if (!res.ok) {
          let serverError = '';
          try {
            serverError = ((await res.json()) as { error?: string }).error ?? '';
          } catch { /* non-JSON body */ }
          toast.error(`The pre-update snapshot failed; the update was not started.${serverError ? ` ${serverError}` : ''}`);
          return;
        }
        toast.success('Fleet snapshot created.');
      } catch (e) {
        console.error('[UpdateReadiness] pre-update snapshot failed:', e);
        toast.error('The pre-update snapshot failed; the update was not started.');
        return;
      } finally {
        setWorking(false);
      }
    }
    onProceed();
  };

  const verdict = report ? VERDICT_META[report.verdict] ?? VERDICT_META.unknown : null;
  const VerdictIcon = verdict?.icon;

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next && !working) onCancel(); }} size="lg">
      <ModalHeader
        kicker={`${stackName.toUpperCase()} · UPDATE READINESS`}
        title="Ready to update?"
        description="A pre-update check of this stack's preflight, drift, containers, backup, and pending image change."
      />
      <ModalBody>
        {!report || !verdict || !VerdictIcon ? (
          <div className="py-4 font-mono text-[11px] text-stat-subtitle">Checking readiness…</div>
        ) : (
          <>
            <div data-testid="readiness-verdict" data-verdict={report.verdict} className={cn('rounded-lg border px-3 py-2.5', verdict.tone)}>
              <div className="flex items-center gap-2">
                <VerdictIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[11px] uppercase tracking-wide">{verdict.label}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{verdict.line}</div>
            </div>

            <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
              {report.signals.map(signal => {
                const meta = SIGNAL_META[signal.status] ?? SIGNAL_META.unknown;
                const SignalIcon = meta.icon;
                return (
                  <div key={signal.id} className="border-t border-muted py-2 first:border-t-0">
                    <div className="flex items-center gap-2">
                      <SignalIcon className={cn('h-3.5 w-3.5 shrink-0', meta.tone)} strokeWidth={1.5} />
                      <span className="text-[12px] font-medium text-foreground/90">{signal.title}</span>
                    </div>
                    <div className="mt-0.5 pl-5 text-[12px] leading-relaxed text-foreground/80">{signal.detail}</div>
                  </div>
                );
              })}
              {snapshotKnown && (
                <div className="border-t border-muted py-2">
                  <div className="flex items-center gap-2">
                    <Camera className="h-3.5 w-3.5 shrink-0 text-stat-subtitle" strokeWidth={1.5} />
                    <span className="text-[12px] font-medium text-foreground/90">Fleet snapshot</span>
                  </div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-foreground/80">
                    {snapshotAt
                      ? `The most recent fleet snapshot covering this stack was taken ${formatTimeAgo(snapshotAt)}.`
                      : 'No fleet snapshot covers this stack yet.'}
                  </div>
                </div>
              )}
            </div>

            {isAdmin && (
              <label className="flex items-center gap-2 text-[12px] text-foreground/80">
                <Checkbox
                  checked={snapshotFirst}
                  onCheckedChange={(checked) => setSnapshotFirst(checked === true)}
                  aria-label="Create a fleet snapshot before updating"
                />
                Create a fleet snapshot before updating
              </label>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter
        secondary={
          <Button variant="outline" size="sm" onClick={onCancel} disabled={working}>
            Cancel
          </Button>
        }
        primary={
          <Button
            size="sm"
            autoFocus
            disabled={working}
            data-testid="readiness-proceed"
            onClick={(e) => {
              e.preventDefault();
              void proceed();
            }}
          >
            {working ? 'Creating snapshot…' : 'Update now'}
          </Button>
        }
      />
    </Modal>
  );
}

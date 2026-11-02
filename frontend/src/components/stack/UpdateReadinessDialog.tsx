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
import { useNodes } from '@/context/NodeContext';
import { SENCHO_LABEL_POLICY_CAPABILITY } from '@/lib/capabilities';
import { POLICY_LABEL_NOT_EVALUATED_COPY, inventoryDeclaresLabel } from '@/lib/labelInventory';
import { SENCHO_UPDATE_LABEL } from '@/lib/senchoLabels';
import { openStackEditor } from '@/lib/updatePolicyRefusal';
import { verdictMeta } from './stackReadinessMeta';
import type { ReadinessVerdict } from '@/types/readiness';

// Mirrors the backend payload shape (the frontend never imports backend).
type SignalStatus = 'ok' | 'warning' | 'attention' | 'blocked' | 'unknown';

interface ReadinessSignal {
  id: string;
  status: SignalStatus;
  title: string;
  detail: string;
  affectsVerdict: boolean;
}

interface UpdatePolicyService {
  service: string;
  policy: string;
  eligible: boolean;
  reason?: string;
}

/** Mirrors `updateGuard/types.ts` `UpdatePolicyReadiness`; absent on an older node and on the Fleet rollup. */
interface UpdatePolicyReadiness {
  evaluation: 'evaluated' | 'unrenderable';
  services: UpdatePolicyService[];
  manualDecision: 'allow' | 'block';
  unattendedDecision: 'allow' | 'skip';
  reason: string | null;
}

interface UpdateReadinessReport {
  stack: string;
  computedAt: number;
  verdict: ReadinessVerdict;
  signals: ReadinessSignal[];
  updatePolicy?: UpdatePolicyReadiness;
}

const FETCH_TIMEOUT_MS = 4_000;

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
  /** Set only for a service-scoped update; absent means the full stack. */
  serviceName?: string;
  /** Update vs rebuild copy for a service-scoped update. Ignored for the full stack. */
  mode?: 'update' | 'rebuild';
  onCancel: () => void;
  /** Caller closes the dialog and starts the update. */
  onProceed: () => void;
  /**
   * Opens the Compose file in place. Absent in a context with no editor, where
   * the blocked policy offers "Open stack editor" instead.
   */
  onOpenComposeFile?: () => void;
  /**
   * Closes this dialog and opens the named service's readiness. Absent outside
   * the editor, where no service-scoped handler is mounted.
   */
  onProceedService?: (serviceName: string) => void;
}

/**
 * Pre-update readiness check. Advisory only: every verdict, including
 * blocked and unknown, keeps Proceed enabled; the scan-policy gate remains
 * the single hard block. A slow or failed readiness fetch degrades to an
 * unknown verdict so this dialog can never strand the update path.
 */
export function UpdateReadinessDialog({ open, stackName, nodeId, serviceName, mode = 'update', onCancel, onProceed, onOpenComposeFile, onProceedService }: UpdateReadinessDialogProps) {
  const { isAdmin } = useAuth();
  const { nodeMeta } = useNodes();
  // The capability is per node, and this dialog can be opened for a node that
  // is not the active one. Unknown meta is treated as capable, matching the
  // context's optimistic default, so no note is claimed from a failed fetch.
  const policyMeta = nodeId === null ? undefined : nodeMeta.get(nodeId);
  const nodeEvaluatesPolicy = policyMeta === undefined
    || policyMeta.version === null
    || policyMeta.capabilities.includes(SENCHO_LABEL_POLICY_CAPABILITY);

  const [report, setReport] = useState<UpdateReadinessReport | null>(null);
  const [declaresUpdateLabel, setDeclaresUpdateLabel] = useState(false);
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [snapshotKnown, setSnapshotKnown] = useState(false);
  const [snapshotFirst, setSnapshotFirst] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) {
      setReport(null);
      setDeclaresUpdateLabel(false);
      setSnapshotAt(null);
      setSnapshotKnown(false);
      setSnapshotFirst(false);
      setWorking(false);
      return;
    }
    setReport(null);
    setDeclaresUpdateLabel(false);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    const load = async () => {
      try {
        const path = serviceName
          ? `/stacks/${stackName}/update-readiness?service=${encodeURIComponent(serviceName)}`
          : `/stacks/${stackName}/update-readiness`;
        const res = await apiFetch(path, { nodeId, signal: controller.signal });
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

    // An older node does not report the update policy at all. The note that
    // says so is only true for a stack that declares the label, so read the
    // declared entries on that node only; a current node already answered.
    const loadDeclaredPolicyLabel = async () => {
      if (nodeEvaluatesPolicy) return;
      try {
        const res = await apiFetch(
          `/stacks/${encodeURIComponent(stackName)}/label-inventory`,
          { nodeId, signal: controller.signal },
        );
        if (!res.ok) return;
        const body: unknown = await res.json();
        setDeclaresUpdateLabel(inventoryDeclaresLabel(body, SENCHO_UPDATE_LABEL));
      } catch {
        // Supplemental: without the inventory the note is omitted, never invented.
        if (!controller.signal.aborted) {
          console.warn('[UpdateReadiness] label inventory unavailable for the policy note');
        }
      }
    };
    void loadDeclaredPolicyLabel();

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, stackName, nodeId, isAdmin, serviceName, nodeEvaluatesPolicy]);

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

  const verdict = report ? verdictMeta(report.verdict) : null;
  const VerdictIcon = verdict?.icon;

  const policy = report?.updatePolicy;
  const policyBlocked = policy?.manualDecision === 'block';
  const policyReason = policy?.reason ?? null;
  const eligibleServices = policyBlocked
    ? (policy?.services ?? []).filter(service => service.eligible)
    : [];
  const openComposeFile = () => {
    if (onOpenComposeFile) onOpenComposeFile();
    else openStackEditor(nodeId, stackName);
    onCancel();
  };

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next && !working) onCancel(); }} size="lg">
      <ModalHeader
        kicker={serviceName ? `${stackName.toUpperCase()} / ${serviceName.toUpperCase()} · ${mode === 'rebuild' ? 'REBUILD' : 'UPDATE'} READINESS` : `${stackName.toUpperCase()} · UPDATE READINESS`}
        title={serviceName ? (mode === 'rebuild' ? 'Ready to rebuild?' : 'Ready to update?') : 'Ready to update?'}
        description={serviceName
          ? `A pre-${mode} check of this stack's preflight, drift, containers, backup, and pending image change. This service is checked in the context of the whole stack.`
          : "A pre-update check of this stack's preflight, drift, containers, backup, and pending image change."}
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

            {policyBlocked && (
              <div
                className="rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-2.5 text-xs text-warning"
                data-testid="update-policy-blocked"
              >
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                  <span className="font-medium">Update policy blocks this update</span>
                </div>
                <p className="mt-1 leading-relaxed">
                  {policyReason ?? `${SENCHO_UPDATE_LABEL} does not allow this update.`}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs max-md:min-h-11"
                    onClick={openComposeFile}
                    data-testid="update-policy-open-compose"
                  >
                    {onOpenComposeFile ? 'Open Compose file' : 'Open stack editor'}
                  </Button>
                  {onProceedService && eligibleServices.map(service => (
                    <Button
                      key={service.service}
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs max-md:min-h-11"
                      onClick={() => onProceedService(service.service)}
                      data-testid={`update-policy-service-${service.service}`}
                    >
                      Update {service.service}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {!nodeEvaluatesPolicy && declaresUpdateLabel && (
              <div
                className="rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-2 text-xs text-warning"
                data-testid="update-policy-unsupported"
              >
                {POLICY_LABEL_NOT_EVALUATED_COPY}
              </div>
            )}

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
            disabled={working || policyBlocked}
            title={policyBlocked
              ? (policyReason ?? `${SENCHO_UPDATE_LABEL} does not allow this update.`)
              : undefined}
            data-testid="readiness-proceed"
            onClick={(e) => {
              e.preventDefault();
              void proceed();
            }}
          >
            {working ? 'Creating snapshot…' : (mode === 'rebuild' ? 'Rebuild now' : 'Update now')}
          </Button>
        }
      />
    </Modal>
  );
}

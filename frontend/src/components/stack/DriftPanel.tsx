import { useEffect, useMemo, useState } from 'react';
import {
  Check, TriangleAlert, CircleSlash, WifiOff, RefreshCw,
  FileClock, FileCheck2, FileQuestion, type LucideIcon,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { startService } from '@/lib/stackLifecycleApi';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { DismissedSection } from '@/components/ui/dismissed-section';
import { useFindingDismissal } from '@/hooks/useFindingDismissal';
import { DRIFT_SEVERITY_SCALE, partitionFindings } from '@/lib/findingDismissals';
import { describeDismissal } from '@/components/fleet/readiness/describeDismissal';
import { useNow } from '@/components/fleet/readiness/useNow';
import type { FindingDismissal } from '@/types/findingDismissal';
import {
  isDismissableDriftFinding,
  type DriftLedgerEntry, type DriftTemporal,
  type StackDriftFinding, type StackDriftStatus,
} from '@/types/drift';
import { DriftFindingRow, type DriftRowControls } from './DriftFindingRow';
import { DRIFT_FINDING_LABEL } from './driftLabels';
import { resolveDriftFinding, type DriftVerb } from './driftVerbs';
import GitOpsDriftRow from '@/components/gitops/GitOpsDriftRow';
import { GitOpsStatus } from '@/components/gitops/GitOpsStatus';
import { buildGitOpsStatus } from '@/lib/gitopsStatus';
import { useGitOpsApplicationPosture, type GitOpsApplicationPosture } from '@/components/gitops/useGitOpsApplicationPosture';
import type { GitOpsRevisionProjection } from '@/types/gitops';
import type { GitOpsPortfolioTargetSummary } from '@/types/gitopsPortfolio';

interface StackDriftReport {
  stack: string;
  status: StackDriftStatus;
  hasComposeFile: boolean;
  hasContainers: boolean;
  findings: StackDriftFinding[];
  parseError?: string;
  // Optional so a report from an older remote node (no ledger layer) still renders.
  temporal?: DriftTemporal;
  ledger?: DriftLedgerEntry[];
  // When the ledger was last reconciled (re-check, deploy, or background scan); null
  // if never. The history is "as of" this time, not the live status above it.
  lastCheckedAt?: number | null;
  // Optional for the same reason as temporal and ledger above: a report proxied
  // from an older remote node predates the revision model and omits it. That is
  // rendered the same as an answer of "nothing here", because the alternative is
  // telling an operator their node is out of date on a tab about drift.
  gitopsRevision?: GitOpsRevisionProjection;
  // Open team dismissals for this stack's findings. Absent on an older remote node,
  // which then offers no Dismiss because it cannot record one.
  dismissals?: FindingDismissal[];
}

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';

const STATUS_META: Record<StackDriftStatus, { label: string; icon: LucideIcon; tone: string; line: string }> = {
  'in-sync': {
    label: 'in sync',
    icon: Check,
    tone: 'border-success/40 bg-success/[0.06] text-success',
    line: 'Runtime matches the compose file.',
  },
  drifted: {
    label: 'drifted',
    icon: TriangleAlert,
    tone: 'border-warning/40 bg-warning/[0.06] text-warning',
    line: 'Runtime differs from the compose file.',
  },
  'missing-runtime': {
    label: 'not running',
    icon: CircleSlash,
    tone: 'border-muted bg-card/40 text-stat-subtitle',
    line: 'Defined on disk but no containers are running.',
  },
  unreachable: {
    label: 'unreachable',
    icon: WifiOff,
    tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
    line: 'Docker is unreachable, so drift cannot be assessed.',
  },
};

/** The temporal overlay: how the on-disk compose compares to the last deploy baseline. */
function temporalMeta(temporal: DriftTemporal): { label: string; icon: LucideIcon; tone: string; line: string; key: string } {
  if (!temporal.hasBaseline) {
    return {
      key: 'no-baseline',
      label: 'no deploy baseline',
      icon: FileQuestion,
      tone: 'border-muted bg-card/40 text-stat-subtitle',
      line: 'Deploy through Sencho to start tracking changes since deploy.',
    };
  }
  if (temporal.sourceChanged) {
    return {
      key: 'source-changed',
      label: 'source changed',
      icon: FileClock,
      tone: 'border-warning/40 bg-warning/[0.06] text-warning',
      line: temporal.renderedChanged
        ? 'The compose model changed since the last deploy.'
        : 'The compose file changed since the last deploy (formatting only).',
    };
  }
  return {
    key: 'matches',
    label: 'matches last deploy',
    icon: FileCheck2,
    tone: 'border-success/40 bg-success/[0.06] text-success',
    line: 'The compose source is unchanged since the last deploy.',
  };
}

function LedgerRow({ entry, onOpenGitSource }: { entry: DriftLedgerEntry; onOpenGitSource?: () => void }) {
  const resolved = entry.resolvedAt != null;
  const gitPath = entry.kind === 'managed-path-conflict';
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        {!gitPath && (
          <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{entry.service}</span>
        )}
        <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">{DRIFT_FINDING_LABEL[entry.kind] ?? entry.kind}</span>
        <span className={cn('font-mono text-[10px] uppercase tracking-wide', resolved ? 'text-success' : 'text-warning')}>
          {resolved ? 'resolved' : 'open'}
        </span>
        {gitPath && !resolved && onOpenGitSource && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs max-md:min-h-11"
            data-testid="drift-verb-open-git-source"
            onClick={onOpenGitSource}
          >
            Open Git source
          </Button>
        )}
      </div>
      <div className="mt-1 text-[12px] text-foreground/90">{entry.message}</div>
      <div className="mt-1 font-mono text-[10px] text-stat-subtitle">
        detected {formatTimeAgo(entry.detectedAt)}
        {entry.resolvedAt != null ? ` · resolved ${formatTimeAgo(entry.resolvedAt)}` : ''}
      </div>
    </div>
  );
}

/**
 * How one target's evidence quality reads.
 *
 * The grade is what the target's connectivity could prove, not whether its
 * observation matches the generation now intended, so the wording stays inside
 * that claim. A generation that has been accepted but not deployed is visible
 * one line above on the same card, in the runtime state, which is where "the
 * intended generation is not running yet" belongs.
 *
 * `unknown` is not a softer `stale`. Stale means Sencho has an answer and knows
 * it is no longer current; unknown means it has no answer to offer, which is why
 * the portfolio will not call the application settled.
 */
const EVIDENCE_META: Record<GitOpsPortfolioTargetSummary['evidence'], { label: string; tone: string; line: string }> = {
  fresh: {
    label: 'evidence current',
    tone: 'text-success',
    line: 'This node answered with its own runtime observation.',
  },
  stale: {
    label: 'evidence stale',
    tone: 'text-warning',
    line: 'This node has an observation on record, but it is known to be out of date.',
  },
  unknown: {
    label: 'evidence unknown',
    tone: 'text-stat-subtitle',
    line: 'Sencho cannot read this node’s runtime observation, so it cannot say what is running.',
  },
};

/**
 * The portfolio id for the application this revision belongs to.
 *
 * The two forms mirror the backend's identity: a Blueprint application is
 * single-instanced by blueprint id, while a Direct application lives on the
 * node that owns its stack, so the id names that node. Both are opaque here;
 * the route parses them back.
 *
 * Null when there is no live application to ask about, which is the ordinary
 * answer for a stack outside GitOps and for a report from a node that predates
 * the revision model.
 */
function portfolioIdFor(revision: GitOpsRevisionProjection | null, nodeId: number | undefined): string | null {
  if (!revision || revision.targetMode === 'not_applicable') return null;
  // The portfolio lists live applications only, and its detail route answers 404
  // for anything else. A detached stack still projects a Direct revision here,
  // because the tab is useful for reading what a stack was, so without this the
  // id would be built and the read would 404 into a warning about a state the
  // portfolio does not even list. Silence is the honest answer: there is no
  // current application to have a posture.
  if (revision.lifecycleStatus !== 'active') return null;
  if (revision.blueprintId != null) return `bp:${revision.blueprintId}`;
  return nodeId === undefined ? null : `${nodeId}:${revision.applicationId}`;
}

/** How fresh one node's observation is, from the portfolio's per-target evidence. */
function TargetEvidence({ nodeId, evidence, unknown }: {
  nodeId: number;
  evidence: GitOpsPortfolioTargetSummary['evidence'] | undefined;
  unknown: boolean;
}) {
  // A node the posture never covered reads as unknown, not as absent: the
  // runtime state is a real observation, and what is missing is the
  // application-level accounting.
  if (!evidence && !unknown) return null;
  const meta = EVIDENCE_META[evidence ?? 'unknown'];
  return (
    <div
      data-testid="gitops-target-evidence"
      data-evidence={evidence ?? 'unknown'}
      data-node={nodeId}
      className="mt-1 font-mono text-[10px] leading-relaxed text-stat-subtitle"
    >
      <span className={cn('uppercase tracking-wide', meta.tone)}>{meta.label}</span>
      {' · '}
      {meta.line}
    </div>
  );
}

/** Whether the posture read left anything to say beyond the answer itself. */
function hasPostureEvidence(posture: GitOpsApplicationPosture): boolean {
  if (posture.kind === 'unreadable') return true;
  if (posture.kind !== 'row') return false;
  const { evidence } = posture.row;
  return evidence.partial || evidence.unknown || evidence.unreachableNodes.length > 0;
}

/** What the application-level answer could not read, in the evidence rather than beside the Answer. */
function PostureEvidence({ posture, nodeLabel }: {
  posture: GitOpsApplicationPosture;
  nodeLabel: (id: number) => string;
}) {
  if (!hasPostureEvidence(posture)) return null;
  if (posture.kind === 'unreadable') {
    return (
      <p data-testid="gitops-posture-unreadable" className="font-mono text-[11px] leading-relaxed text-warning">
        Sencho could not read this application’s overall state. The state shown describes one node, not the application.
      </p>
    );
  }
  if (posture.kind !== 'row') return null;
  const { evidence } = posture.row;
  return (
    <ul data-testid="gitops-posture-evidence" className="space-y-0.5">
      {evidence.unknown && (
        <li className="font-mono text-[10px] leading-relaxed text-stat-subtitle">
          Part of this answer could not be read, so it is reported without interpreting it.
        </li>
      )}
      {evidence.partial && (
        <li className="font-mono text-[10px] leading-relaxed text-stat-subtitle">
          The evidence behind this is incomplete, so this is the best answer available.
        </li>
      )}
      {evidence.unreachableNodes.length > 0 && (
        <li className="font-mono text-[10px] leading-relaxed text-warning">
          Not reached: {evidence.unreachableNodes.map(nodeLabel).join(', ')}.
        </li>
      )}
    </ul>
  );
}

interface DriftPanelProps {
  stackName: string;
  /** Deploys the stack through the editor's own handler, so a redeploy here runs every gate it does. */
  onRedeploy?: () => void | Promise<void>;
  onEditCompose?: () => void;
  onOpenGitSource?: () => void;
}

export default function DriftPanel({ stackName, onRedeploy, onEditCompose, onOpenGitSource }: DriftPanelProps) {
  const { activeNode, nodes } = useNodes();
  const nodeId = activeNode?.id;
  const { can } = useAuth();
  const now = useNow(30_000);
  const [report, setReport] = useState<StackDriftReport | null>(null);
  /**
   * The node `report` was read from, so a report can be recognised as belonging
   * to a node the operator has since left.
   *
   * Dropping the report on a node change is not enough on its own: the render
   * that follows the change still sees the previous report, because the effect
   * that clears it runs after that render. Keying the derived posture off the
   * report's own node closes the window, so the new node is never composed with
   * the previous node's application.
   */
  const [reportNodeId, setReportNodeId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [rechecking, setRechecking] = useState(false);
  const [busyVerb, setBusyVerb] = useState<string | null>(null);
  const [redeployTarget, setRedeployTarget] = useState<{ finding: StackDriftFinding; verb: Extract<DriftVerb, { kind: 'redeploy' }> } | null>(null);
  const [redeploying, setRedeploying] = useState(false);

  // Passive load when the stack OR active node changes (the same stack can exist on
  // two nodes), and on an explicit retry. Read-only: it never writes the ledger, so
  // opening the tab has no side effects. A failed load shows a distinct retry state
  // rather than a stale or blank report.
  useEffect(() => {
    let cancelled = false;
    // Cleared in the effect body rather than inside the async run, so it lands
    // before the render that follows this commit. Inside the run it would land a
    // microtask later, leaving one render where the new node is paired with the
    // previous node's report, which both probes an identity that cannot exist and
    // shows a state belonging to the node the operator just left. `loading` is set
    // below for the same cycle, so the tab reads as checking rather than as wrong.
    setReport(null);
    setReportNodeId(undefined);
    const run = async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await apiFetch(`/stacks/${stackName}/drift`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(true);
          toast.error('Failed to load the drift report.');
          return;
        }
        setReport((await res.json()) as StackDriftReport);
        setReportNodeId(nodeId);
        setLoadError(false);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load the drift report.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId, reloadKey]);

  // Re-check reconciles the ledger server-side (recording newly detected / resolved
  // findings) and returns the fresh payload, so the history reflects this check.
  const recheck = async () => {
    setRechecking(true);
    try {
      const res = await apiFetch(`/stacks/${stackName}/drift/recheck`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Failed to re-check drift.');
        return;
      }
      setReport((await res.json()) as StackDriftReport);
      setReportNodeId(nodeId);
      setLoadError(false);
    } catch {
      toast.error('Failed to re-check drift.');
    } finally {
      setRechecking(false);
    }
  };

  const dismissalEndpoint = useMemo(() => ({
    create: `/stacks/${encodeURIComponent(stackName)}/drift/dismissals`,
    remove: (id: number) => `/stacks/${encodeURIComponent(stackName)}/drift/dismissals/${id}`,
  }), [stackName]);
  const { dismiss, restore, isPending } = useFindingDismissal({
    surface: 'drift',
    endpoint: dismissalEndpoint,
    onUpsert: dismissal => setReport(prev => prev && ({
      ...prev,
      dismissals: [...(prev.dismissals ?? []).filter(d => d.findingKey !== dismissal.findingKey), dismissal],
    })),
    onRemove: id => setReport(prev => prev && ({ ...prev, dismissals: (prev.dismissals ?? []).filter(d => d.id !== id) })),
    onGone: () => { void recheck(); },
  });

  const verbKey = (finding: StackDriftFinding, verb: DriftVerb) => `${verb.kind}:${finding.kind}:${finding.service}`;

  const startOne = async (finding: StackDriftFinding, verb: DriftVerb) => {
    if (nodeId === undefined) return;
    setBusyVerb(verbKey(finding, verb));
    try {
      const result = await startService(nodeId, stackName, finding.service);
      if (result.ok) {
        toast.success(`Started ${finding.service}.`);
        await recheck();
      } else if (result.reason === 'no-containers') {
        toast.error(`${finding.service} has no container to start. Redeploy the stack to create it.`);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error('[DriftPanel] start service failed:', error);
      toast.error(`Could not start ${finding.service}.`);
    } finally {
      setBusyVerb(null);
    }
  };

  const runVerb = (finding: StackDriftFinding, verb: DriftVerb) => {
    switch (verb.kind) {
      case 'open-editor': onEditCompose?.(); return;
      case 'open-git-source': onOpenGitSource?.(); return;
      case 'redeploy': setRedeployTarget({ finding, verb }); return;
      case 'start-service': void startOne(finding, verb); return;
    }
  };

  const confirmRedeploy = async () => {
    if (!onRedeploy) return;
    setRedeploying(true);
    try {
      await onRedeploy();
    } catch (error) {
      console.error('[DriftPanel] redeploy failed:', error);
      toast.error('Could not redeploy the stack.');
    } finally {
      setRedeploying(false);
      setRedeployTarget(null);
    }
    await recheck();
  };

  const meta = report ? STATUS_META[report.status] : null;
  const StatusIcon = meta?.icon;
  // Only render the temporal card when the payload actually carries it. A report
  // proxied from an older node without the ledger layer omits it; showing "no deploy
  // baseline" there would be misleading, so the card is left out entirely.
  const temporal = report?.temporal ? temporalMeta(report.temporal) : null;
  const TemporalIcon = temporal?.icon;
  const ledger = report?.ledger ?? [];
  // The ledger only moves on a reconcile (re-check, deploy, or background scan), so
  // label the history with when that last happened: a "resolved"/"open" row then
  // reads as the state at that check, not a claim about the live status above it.
  const lastChecked = report?.lastCheckedAt != null ? formatTimeAgo(report.lastCheckedAt) : null;
  const busy = loading || rechecking;

  const revision = report?.gitopsRevision ?? null;
  const gitopsLive = revision && revision.targetMode !== 'not_applicable' ? revision : null;
  const gitopsDrift = gitopsLive?.drift ?? [];
  // A target can name a node this client has no record of, so fall back to the
  // id rather than rendering an empty cell.
  const nodeLabel = (id: number) => nodes.find(n => n.id === id)?.name ?? `node ${id}`;

  // The application-level posture, from the hub-owned portfolio rather than from
  // anything on this tab. It is the only answer here that spans every node
  // holding a target and accounts for evidence that is unknown or missing. The
  // store application id rides along so the change stream can be filtered to this
  // application instead of the whole fleet.
  // Null unless the report in hand was read from the node now selected, which is
  // what keeps a node change from composing the new node with the old report's
  // application for the length of the request.
  const reportIsCurrent = reportNodeId === nodeId;
  // Verbs and Dismiss act on this node's stack, so they wait for a report read from it.
  const canDeploy = reportIsCurrent && can('stack:deploy', 'stack', stackName, nodeId);
  const verbContext = { canDeploy, hasRedeploy: onRedeploy !== undefined, hasEditor: onEditCompose !== undefined, hasGitSource: onOpenGitSource !== undefined };
  const findings = report?.findings ?? [];
  const { dismissed } = partitionFindings(findings.filter(isDismissableDriftFinding), report?.dismissals ?? [], now, DRIFT_SEVERITY_SCALE);
  const dismissedIds = new Set(dismissed.map(item => item.finding.id));
  const activeFindings = findings.filter(f => f.id === undefined || !dismissedIds.has(f.id));
  const rowControls: DriftRowControls = {
    run: runVerb,
    isBusy: (finding, verb) => busyVerb === verbKey(finding, verb),
    canDismiss: canDeploy && report?.dismissals !== undefined,
    isDismissing: finding => finding.id !== undefined && isPending(finding.id),
    onDismiss: (finding, mode, days) => {
      if (!isDismissableDriftFinding(finding)) return;
      void dismiss(finding, mode, days);
    },
  };
  const posture = useGitOpsApplicationPosture(
    reportIsCurrent ? portfolioIdFor(revision, nodeId) : null,
    reportIsCurrent && revision && revision.targetMode !== 'not_applicable' ? revision.applicationId : null,
  );
  // Per-target evidence quality, keyed by the node the target runs on, so each
  // target card can carry the freshness the portfolio computed for it. Only
  // current targets: a tombstoned target's history is not current state, and
  // the posture deliberately excludes it.
  const targetEvidence = new Map<number, GitOpsPortfolioTargetSummary['evidence']>(
    posture.kind === 'row'
      ? posture.row.targets
        .filter(target => !target.tombstoned)
        .map(target => [target.nodeId, target.evidence])
      : [],
  );
  // A target with no portfolio entry is a target the posture could not see. That
  // is different from one it saw and found fresh, and the card says so rather
  // than implying coverage.
  const unknownEvidence = (nodeId: number): boolean => posture.kind === 'row' && !targetEvidence.has(nodeId);

  return (
    <div data-testid="drift-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>compose vs runtime</span>
        <button
          type="button"
          data-testid="drift-recheck-btn"
          onClick={recheck}
          disabled={busy}
          className={ACTION_CLASS}
        >
          <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} strokeWidth={1.5} /> re-check
        </button>
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3">
          <span className="font-mono text-[11px] text-destructive">Could not load the drift report.</span>
          <button
            type="button"
            data-testid="drift-retry-btn"
            onClick={() => setReloadKey(k => k + 1)}
            className="font-mono text-[10px] uppercase tracking-wide text-destructive hover:underline"
          >
            retry
          </button>
        </div>
      ) : !report ? (
        <div className="py-3 font-mono text-[11px] text-stat-subtitle">Checking drift…</div>
      ) : (
        <>
          {meta && StatusIcon && (
            <div data-testid="drift-status" data-status={report.status} className={cn(CARD_CLASS, meta.tone)}>
              <div className="flex items-center gap-2">
                <StatusIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[11px] uppercase tracking-wide">{meta.label}</span>
                {activeFindings.length > 0 && (
                  <span className="font-mono text-[10px] text-stat-subtitle">
                    · {activeFindings.length} finding{activeFindings.length === 1 ? '' : 's'}
                  </span>
                )}
                {dismissed.length > 0 && (
                  <span className="font-mono text-[10px] text-stat-subtitle">· {dismissed.length} dismissed</span>
                )}
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{meta.line}</div>
            </div>
          )}

          {temporal && TemporalIcon && (
            <div data-testid="drift-temporal" data-temporal={temporal.key} className={cn(CARD_CLASS, temporal.tone)}>
              <div className="flex items-center gap-2">
                <TemporalIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[11px] uppercase tracking-wide">{temporal.label}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{temporal.line}</div>
            </div>
          )}

          {revision && (
            <GitOpsStatus
              heading="gitops"
              revision={revision}
              row={posture.kind === 'row' ? posture.row : null}
              nodeName={nodeLabel}
              extraMarker={posture.kind === 'unreadable' ? 'posture unreadable' : undefined}
              targetExtra={t => <TargetEvidence nodeId={t.nodeId} evidence={targetEvidence.get(t.nodeId)} unknown={unknownEvidence(t.nodeId)} />}
              proofExtra={hasPostureEvidence(posture) ? <PostureEvidence posture={posture} nodeLabel={nodeLabel} /> : undefined}
            />
          )}
          {/* With no stage to report the status renders nothing, but a failed posture read must still warn. */}
          {gitopsLive && posture.kind === 'unreadable' && !buildGitOpsStatus(revision, null) && (
            <PostureEvidence posture={posture} nodeLabel={nodeLabel} />
          )}

          {gitopsDrift.length > 0 && (
            <section>
              <div className={cn(LABEL_CLASS, 'mb-1.5')}>gitops drift</div>
              <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                {gitopsDrift.map((d, i) => (
                  <GitOpsDriftRow key={`${d.class}-${d.owner}-${i}`} item={d} />
                ))}
              </div>
            </section>
          )}

          {report.parseError && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-2 font-mono text-[11px] text-destructive">
              {report.parseError}
            </div>
          )}

          {activeFindings.length > 0 && (
            <section>
              <div className={cn(LABEL_CLASS, 'mb-1.5')}>findings</div>
              <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                {activeFindings.map(f => (
                  <DriftFindingRow
                    key={`${f.service}-${f.kind}`}
                    finding={f}
                    resolution={resolveDriftFinding(f, verbContext)}
                    controls={rowControls}
                  />
                ))}
              </div>
            </section>
          )}

          <DismissedSection
            items={dismissed.map(({ finding, dismissal }) => ({
              id: dismissal.id,
              title: [finding.service, DRIFT_FINDING_LABEL[finding.kind]].filter(part => part !== '').join(' · '),
              meta: describeDismissal(dismissal, now),
              onRestore: rowControls.canDismiss ? () => { void restore(dismissal.id); } : undefined,
              restoring: isPending(dismissal.id),
            }))}
          />

          {ledger.length > 0 && (
            <section>
              <div className={cn(LABEL_CLASS, 'mb-1.5 flex items-center gap-1.5')}>
                <span>drift history</span>
                {lastChecked && (
                  <span className="tracking-normal normal-case text-stat-subtitle/70">· checked {lastChecked}</span>
                )}
              </div>
              <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                {ledger.map((e, i) => (
                  <LedgerRow key={`${e.service}-${e.kind}-${e.detectedAt}-${i}`} entry={e} onOpenGitSource={reportIsCurrent ? onOpenGitSource : undefined} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <ConfirmModal
        open={redeployTarget !== null}
        onOpenChange={open => { if (!open) setRedeployTarget(null); }}
        kicker="DRIFT · REDEPLOY"
        title={`Redeploy ${stackName}`}
        description="Deploy the stack so its running services match the compose file."
        hint="RECREATES DIFFERING SERVICES"
        confirmLabel="Redeploy"
        busyConfirmLabel="Redeploying…"
        confirming={redeploying}
        onConfirm={() => { void confirmRedeploy(); }}
      >
        <p className="text-sm text-stat-subtitle">{redeployTarget?.verb.confirm}</p>
      </ConfirmModal>
    </div>
  );
}

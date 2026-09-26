import { useEffect, useState } from 'react';
import {
  Check, TriangleAlert, CircleSlash, WifiOff, RefreshCw,
  FileClock, FileCheck2, FileQuestion, type LucideIcon,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useNodes } from '@/context/NodeContext';
import GitOpsStateCard, { GitOpsFaultCard } from '@/components/gitops/GitOpsStateCard';
import GitOpsCaveats from '@/components/gitops/GitOpsCaveats';
import GitOpsApprovalChips from '@/components/gitops/GitOpsApprovalChips';
import GitOpsDriftRow from '@/components/gitops/GitOpsDriftRow';
import { GitOpsDigestDetail } from '@/components/gitops/GitOpsDigestDetail';
import { useGitOpsApplicationPosture, type GitOpsApplicationPosture } from '@/components/gitops/useGitOpsApplicationPosture';
import { POSTURE_LABEL, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import { ARTIFACT_STATE_LOOKUP, ROLLOUT_STATE_LOOKUP, RUNTIME_STATE_LOOKUP, SOURCE_STATE_LOOKUP, absentFault, liveArtifactFacet, livePlacementFacet, liveRolloutFacet, liveSourceFacet, placementStateMeta } from '@/lib/gitopsState';
import type { GitOpsRevisionProjection } from '@/types/gitops';
import type { GitOpsPortfolioRow, GitOpsPortfolioTargetSummary } from '@/types/gitopsPortfolio';

// Mirrors the backend payload shape (the frontend never imports backend).
type StackDriftStatus = 'in-sync' | 'drifted' | 'missing-runtime' | 'unreachable';
type DriftFindingKind =
  | 'service-missing' | 'service-undeclared' | 'image-mismatch' | 'ports-mismatch'
  | 'network-undeclared' | 'network-missing' | 'managed-path-conflict';

interface StackDriftFinding {
  kind: DriftFindingKind;
  service: string;
  detail: string;
  expected?: string;
  actual?: string;
}

interface DriftTemporal {
  hasBaseline: boolean;
  sourceChanged: boolean;
  renderedChanged: boolean;
}

interface DriftLedgerEntry {
  service: string;
  kind: DriftFindingKind;
  message: string;
  detectedAt: number;
  resolvedAt: number | null;
}

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

const FINDING_LABEL: Record<DriftFindingKind, string> = {
  'service-missing': 'service missing',
  'service-undeclared': 'undeclared',
  'image-mismatch': 'image',
  'ports-mismatch': 'ports',
  'network-undeclared': 'network',
  'network-missing': 'network missing',
  'managed-path-conflict': 'managed path',
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

function Finding({ finding }: { finding: StackDriftFinding }) {
  const gitPath = finding.kind === 'managed-path-conflict';
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        {!gitPath && (
          <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{finding.service}</span>
        )}
        <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">{FINDING_LABEL[finding.kind]}</span>
      </div>
      <div className="mt-1 text-[12px] text-foreground/90">{finding.detail}</div>
      {finding.expected !== undefined && finding.actual !== undefined && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          <span className="text-stat-subtitle">compose</span>
          <span className="text-foreground/90">{finding.expected}</span>
          <span className="text-stat-subtitle">→ running</span>
          <span className="font-semibold text-foreground">{finding.actual}</span>
        </div>
      )}
    </div>
  );
}

function LedgerRow({ entry }: { entry: DriftLedgerEntry }) {
  const resolved = entry.resolvedAt != null;
  const gitPath = entry.kind === 'managed-path-conflict';
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        {!gitPath && (
          <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{entry.service}</span>
        )}
        <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">{FINDING_LABEL[entry.kind] ?? entry.kind}</span>
        <span className={cn('font-mono text-[10px] uppercase tracking-wide', resolved ? 'text-success' : 'text-warning')}>
          {resolved ? 'resolved' : 'open'}
        </span>
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
 * Fallback for a posture this build has no wording for, so a newer backend's
 * value renders as an explicit unknown rather than crashing the tab.
 */
const UNRECOGNIZED_POSTURE = {
  label: 'unknown',
  tone: 'neutral',
} as const;

/**
 * One sentence saying what this posture means, in the words the rest of the tab
 * uses.
 *
 * Only the settled states get a positive sentence. Every other value says what
 * is missing rather than what is wrong, because the whole reason the posture is
 * fail-closed is that "not proven" and "proven bad" are different facts, and a
 * generic "needs attention" would erase that distinction on the one surface an
 * operator opens to find out.
 */
function postureLine(row: GitOpsPortfolioRow): string {
  switch (row.posture) {
    case 'converged':
      return 'Every target reached, complete, and current evidence confirms the intended generation is running.';
    case 'converged_qualified':
      return 'Every target reached the intended generation, but the executable artifact could not be proven bit-identical.';
    case 'failed':
      return 'Something was proven wrong. The lines below show what Sencho established on this node.';
    case 'attention':
      return 'A decision or repair is waiting on an operator. The lines below show what Sencho established on this node.';
    case 'in_progress':
      return 'Work is still in flight, so this is not a settled answer yet.';
    case 'unknown':
      return 'Sencho cannot currently prove any other state for this application.';
    default:
      return 'This application reports a state this Sencho build does not know.';
  }
}

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

/**
 * The canonical posture for this stack's application.
 *
 * Everything else on this tab is node-local: the compose-versus-runtime report
 * and the revision projection both describe one node's own view, and a
 * projection that cannot prove a state says so through a caveat rather than a
 * status. The posture is computed once, hub-side, across every node holding a
 * target, and it is the only answer here that accounts for evidence that is
 * unknown, stale, or missing from a node that did not answer.
 *
 * Rendering it is what stops this tab showing every facet card reading satisfied,
 * with no drift listed, for an application the portfolio reports as unsettled.
 */
function PostureCard(
  { posture, nodeLabel }: {
    posture: GitOpsApplicationPosture;
    nodeLabel: (id: number) => string;
  },
) {
  if (posture.kind === 'loading' || posture.kind === 'absent') return null;

  if (posture.kind === 'unreadable') {
    return (
      <div data-testid="gitops-posture" data-posture="unreadable" className={cn(CARD_CLASS, 'border-warning/40 bg-warning/[0.06] text-warning')}>
        <div className="flex items-center gap-2">
          <FileQuestion className="h-4 w-4 shrink-0" strokeWidth={1.5} />
          <span className="font-mono text-[11px] uppercase tracking-wide">posture unreadable</span>
        </div>
        <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">
          Sencho could not read this application’s overall state. The cards below describe one node, not the application.
        </div>
      </div>
    );
  }

  const { row } = posture;
  // A browser tab left open across a Sencho upgrade can hold this build against
  // a newer backend that reports a posture this build has no wording for. The
  // sibling application view renders that as an explicit unknown rather than
  // dereferencing a missing entry, and a Drift tab that threw here would take
  // the whole tab down, not just this card.
  const meta = POSTURE_LABEL[row.posture] ?? UNRECOGNIZED_POSTURE;
  const Icon = meta.tone === 'success' ? FileCheck2 : meta.tone === 'destructive' || meta.tone === 'warning' ? TriangleAlert : FileQuestion;

  return (
    <div data-testid="gitops-posture" data-posture={row.posture} className={cn(CARD_CLASS, 'border', POSTURE_TONE_CLASS[meta.tone])}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
        <span className="font-mono text-[11px] uppercase tracking-wide">application · {meta.label}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">
        {postureLine(row)}
      </div>
      {(row.evidence.partial || row.evidence.unknown || row.evidence.unreachableNodes.length > 0) && (
        <ul className="mt-1.5 space-y-0.5">
          {row.evidence.unknown && (
            <li className="font-mono text-[10px] leading-relaxed text-stat-subtitle">
              Part of this answer could not be read, so it is reported without interpreting it.
            </li>
          )}
          {row.evidence.partial && (
            <li className="font-mono text-[10px] leading-relaxed text-stat-subtitle">
              The evidence behind this is incomplete, so this is the best answer available.
            </li>
          )}
          {row.evidence.unreachableNodes.length > 0 && (
            <li className="font-mono text-[10px] leading-relaxed text-warning">
              Not reached: {row.evidence.unreachableNodes.map(nodeLabel).join(', ')}.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function DriftPanel({ stackName }: { stackName: string }) {
  const { activeNode, nodes } = useNodes();
  const nodeId = activeNode?.id;
  const [report, setReport] = useState<StackDriftReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [rechecking, setRechecking] = useState(false);

  // Passive load when the stack OR active node changes (the same stack can exist on
  // two nodes), and on an explicit retry. Read-only: it never writes the ledger, so
  // opening the tab has no side effects. A failed load shows a distinct retry state
  // rather than a stale or blank report.
  useEffect(() => {
    let cancelled = false;
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
      setLoadError(false);
    } catch {
      toast.error('Failed to re-check drift.');
    } finally {
      setRechecking(false);
    }
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
  const gitopsFaults = revision ? absentFault(revision) : [];
  const gitopsLive = revision && revision.targetMode !== 'not_applicable' ? revision : null;
  // Null for a Blueprint-owned stack: this route resolves through whatever
  // manages the directory, and a Blueprint application has no Git source facet.
  const gitopsSource = liveSourceFacet(revision);
  const gitopsArtifact = liveArtifactFacet(revision);
  const gitopsPlacement = livePlacementFacet(revision);
  const gitopsRollout = liveRolloutFacet(revision);
  const gitopsApprovals = gitopsLive ? gitopsLive.approvals : null;
  const gitopsTargets = gitopsLive?.targets ?? [];
  const gitopsDrift = gitopsLive?.drift ?? [];
  // A target can name a node this client has no record of, so fall back to the
  // id rather than rendering an empty cell.
  const nodeLabel = (id: number) => nodes.find(n => n.id === id)?.name ?? `node ${id}`;

  // The application-level posture, from the hub-owned portfolio rather than from
  // anything on this tab. It is the only answer here that spans every node
  // holding a target and accounts for evidence that is unknown or missing.
  const posture = useGitOpsApplicationPosture(portfolioIdFor(revision, nodeId));
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
                {report.findings.length > 0 && (
                  <span className="font-mono text-[10px] text-stat-subtitle">
                    · {report.findings.length} finding{report.findings.length === 1 ? '' : 's'}
                  </span>
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

          {gitopsFaults.length > 0 && <GitOpsFaultCard message={gitopsFaults[0].message} />}

          {(gitopsSource || gitopsArtifact || gitopsPlacement || gitopsRollout || gitopsTargets.length > 0
            || posture.kind === 'row' || posture.kind === 'unreadable') && (
            <section>
              <div className={cn(LABEL_CLASS, 'mb-1.5')}>gitops</div>
              <div className="flex flex-col gap-2">
                <PostureCard posture={posture} nodeLabel={nodeLabel} />
                <GitOpsApprovalChips approvals={gitopsApprovals} placement={gitopsPlacement} rollout={gitopsRollout} />
                {gitopsSource && (
                  <GitOpsStateCard
                    data-testid="gitops-source"
                    stateKey={gitopsSource.status}
                    state={SOURCE_STATE_LOOKUP[gitopsSource.status]}
                  />
                )}
                {gitopsArtifact && (
                  <GitOpsStateCard
                    data-testid="gitops-artifact"
                    stateKey={gitopsArtifact.status}
                    state={ARTIFACT_STATE_LOOKUP[gitopsArtifact.status]}
                  />
                )}
                {gitopsPlacement && (
                  <GitOpsStateCard
                    data-testid="gitops-placement"
                    stateKey={gitopsPlacement.status}
                    state={placementStateMeta(gitopsPlacement)}
                  />
                )}
                {gitopsRollout && (
                  <GitOpsStateCard
                    data-testid="gitops-rollout"
                    stateKey={gitopsRollout.status}
                    state={ROLLOUT_STATE_LOOKUP[gitopsRollout.status]}
                  />
                )}
                {gitopsTargets.map(t => {
                  const evidence = targetEvidence.get(t.nodeId);
                  // A node the posture never covered reads as unknown, not as
                  // absent: the runtime card below is a real observation, and
                  // what is missing is the application-level accounting.
                  const evidenceMeta = evidence
                    ? EVIDENCE_META[evidence]
                    : unknownEvidence(t.nodeId)
                      ? EVIDENCE_META.unknown
                      : null;
                  return (
                    <GitOpsStateCard
                      key={t.nodeId}
                      data-testid="gitops-target"
                      stateKey={t.runtime.status}
                      state={RUNTIME_STATE_LOOKUP[t.runtime.status]}
                    >
                      <div className="mt-1 font-mono text-[10px] text-stat-subtitle">
                        {nodeLabel(t.nodeId)}{t.stackName ? ` · ${t.stackName}` : ''}
                      </div>
                      {evidenceMeta && (
                        <div
                          data-testid="gitops-target-evidence"
                          data-evidence={evidence ?? 'unknown'}
                          className="mt-1 font-mono text-[10px] leading-relaxed text-stat-subtitle"
                        >
                          <span className={cn('uppercase tracking-wide', evidenceMeta.tone)}>{evidenceMeta.label}</span>
                          {' · '}
                          {evidenceMeta.line}
                        </div>
                      )}
                      <GitOpsDigestDetail target={t} />
                    </GitOpsStateCard>
                  );
                })}
                <GitOpsCaveats revision={revision} />
              </div>
            </section>
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

          {report.findings.length > 0 && (
            <section>
              <div className={cn(LABEL_CLASS, 'mb-1.5')}>findings</div>
              <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                {report.findings.map((f, i) => (
                  <Finding key={`${f.service}-${f.kind}-${i}`} finding={f} />
                ))}
              </div>
            </section>
          )}

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
                  <LedgerRow key={`${e.service}-${e.kind}-${e.detectedAt}-${i}`} entry={e} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

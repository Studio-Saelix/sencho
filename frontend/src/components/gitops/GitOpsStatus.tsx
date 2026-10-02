import type { ReactNode } from 'react';

import GitOpsCaveats from '@/components/gitops/GitOpsCaveats';
import { GitOpsPolicyLines } from '@/components/gitops/GitOpsPolicyLines';
import { GitOpsTargetCard } from '@/components/gitops/GitOpsTargetCard';
import { StatusPath, type StatusPathStage } from '@/components/ui/status-path';
import {
  buildGitOpsStatus,
  grantedAuthority,
  isSpeakingStage,
  type GitOpsStageId,
  type GitOpsStatusKind,
  type GitOpsStatusStage,
  type GrantedAuthority,
} from '@/lib/gitopsStatus';
import { hasPolicyLines } from '@/lib/gitopsAuthorityPolicy';
import { limitationCaveats } from '@/lib/gitopsLimitations';
import type { PortfolioLabel } from '@/lib/gitopsPortfolio';
import { liveCaveats, livePlacementFacet } from '@/lib/gitopsState';
import type { GitOpsRevisionProjection, GitOpsTargetProjection } from '@/types/gitops';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

const PROOF_LABEL = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';

const ANSWER_TEST_ID: Record<GitOpsStatusKind, string> = {
  unavailable: 'gitops-fault',
  posture: 'gitops-posture',
  stage: 'gitops-answer',
};

function OtherReasons({ reasons }: { reasons: readonly PortfolioLabel[] }) {
  if (reasons.length === 0) return null;
  return (
    <div data-testid="gitops-other-reasons" className="space-y-1">
      <div className={PROOF_LABEL}>Also needing attention</div>
      <ul className="space-y-1 font-mono text-[11px] leading-relaxed">
        {reasons.map(reason => (
          <li key={reason.label}>
            <span className="uppercase tracking-wide text-stat-subtitle">{reason.label}</span>
            <span className="text-foreground/80"> · {reason.line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecordedAuthority({ granted }: { granted: readonly GrantedAuthority[] }) {
  if (granted.length === 0) return null;
  return (
    <div data-testid="gitops-approvals" className="space-y-1">
      <div className={PROOF_LABEL}>Recorded authority</div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {granted.map(g => (
          <div key={g.approval} data-approval={g.approval} className="contents">
            <dt className="text-stat-subtitle">{g.label}</dt>
            {/* Only a short prefix of the ref appears, in the tooltip; the row itself says "recorded". */}
            <dd title={`Recorded as ${g.ref.slice(0, 8)}.`} className="text-foreground/80">recorded</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Stage notes the Path does not already state: a quiet stage's sentence, and any stage's detail. */
function StageNotes({ notes, speaking }: { notes: readonly GitOpsStatusStage[]; speaking: ReadonlySet<GitOpsStageId> }) {
  if (notes.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className={PROOF_LABEL}>Stages</div>
      <ul className="space-y-1 font-mono text-[11px] leading-relaxed">
        {notes.map(s => (
          <li key={s.id} data-testid={`gitops-stage-note-${s.id}`}>
            <span className="uppercase tracking-wide text-stat-subtitle">{s.label} {s.word}</span>
            {!speaking.has(s.id) && <span className="text-foreground/80"> · {s.line}</span>}
            {s.detail && <span className="text-stat-subtitle"> · {s.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TargetList({ targets, nodeName, targetExtra }: {
  targets: readonly GitOpsTargetProjection[];
  nodeName?: (nodeId: number) => string;
  targetExtra?: (target: GitOpsTargetProjection) => ReactNode;
}) {
  if (targets.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className={PROOF_LABEL}>Targets · {targets.length}</div>
      {targets.map(t => (
        <GitOpsTargetCard
          key={t.nodeId}
          target={t}
          nodeName={nodeName ? nodeName(t.nodeId) : `node ${t.nodeId}`}
          extra={targetExtra?.(t)}
        />
      ))}
    </div>
  );
}

/**
 * One GitOps application's status, layered: an Answer with its resolving verb,
 * a quiet Path of the stages that apply, and the evidence behind them collapsed.
 *
 * The same state is stated once: the Answer carries the verb and the one toned
 * block, the Path names each stage, and the Evidence holds everything behind
 * them. See DESIGN.md section 1.1.
 *
 * `row` is the portfolio row for the same application when the caller has it;
 * it makes the Answer the application's canonical posture rather than the
 * loudest node-local stage.
 */
export function GitOpsStatus({
  revision,
  row,
  action,
  nodeName,
  includeTargets = true,
  targetExtra,
  proofExtra,
  extraMarker,
  heading,
  focus,
  className,
}: {
  revision: GitOpsRevisionProjection | null;
  row?: GitOpsPortfolioRow | null;
  /** The resolving verb(s) for the Answer. */
  action?: ReactNode;
  nodeName?: (nodeId: number) => string;
  /** False when the surface lists targets in a section of its own. */
  includeTargets?: boolean;
  targetExtra?: (target: GitOpsTargetProjection) => ReactNode;
  /** Surface-specific evidence appended to the Proof. */
  proofExtra?: ReactNode;
  /** A qualifier the surface alone knows, shown with the Answer's own. */
  extraMarker?: string;
  /** A section label rendered above the status, and only when there is a status to label. */
  heading?: string;
  /** The stage the `action` resolves, so the Answer speaks for it. */
  focus?: GitOpsStageId;
  className?: string;
}) {
  const model = buildGitOpsStatus(revision, row, focus);
  if (!model || !revision) return null;

  const live = revision.targetMode === 'not_applicable' ? null : revision;
  const placement = livePlacementFacet(revision);
  const granted = grantedAuthority(live?.approvals ?? null, placement?.status === 'rollout_authorization_stale');
  const targets = includeTargets && live ? live.targets : [];
  const hasCaveats = limitationCaveats(liveCaveats(revision)).length > 0;

  const speaking = new Set(model.stages.filter(s => isSpeakingStage(s, model)).map(s => s.id));
  const quietStages = model.stages.filter(
    s => s.id !== model.answerStageId && !speaking.has(s.id) && (s.line || s.detail),
  );
  // A speaking stage's sentence is already on screen; its detail still belongs to the evidence.
  const detailOnly = model.stages.filter(s => speaking.has(s.id) && s.detail);
  const stageNotes = [...quietStages, ...detailOnly];

  const stages: StatusPathStage[] = model.stages.map(s => ({
    id: s.id,
    label: s.label,
    tone: s.tone,
    word: s.word,
    status: s.status,
    title: s.line,
    line: speaking.has(s.id) ? s.line : undefined,
    'data-testid': `gitops-${s.id}`,
  }));

  const policies = live?.authorityPolicies;
  const hasProof = granted.length > 0 || stageNotes.length > 0
    || model.otherReasons.length > 0 || targets.length > 0 || hasPolicyLines(policies) || hasCaveats
    || Boolean(proofExtra);

  const status = (
    <StatusPath
      data-testid="gitops-status"
      className={className}
      answer={{
        ...model.answer,
        marker: [model.marker, extraMarker].filter(Boolean).join(' · ') || undefined,
        action,
        'data-testid': ANSWER_TEST_ID[model.kind],
      }}
      stages={stages}
      proof={hasProof ? {
        label: 'Evidence',
        children: (
          <>
            <OtherReasons reasons={model.otherReasons} />
            <RecordedAuthority granted={granted} />
            <StageNotes notes={stageNotes} speaking={speaking} />
            <GitOpsPolicyLines authorityPolicies={policies} />
            <TargetList targets={targets} nodeName={nodeName} targetExtra={targetExtra} />
            {proofExtra}
            <GitOpsCaveats revision={revision} />
          </>
        ),
      } : undefined}
    />
  );
  if (!heading) return status;
  return (
    <section>
      <div className={`${PROOF_LABEL} mb-1.5`}>{heading}</div>
      {status}
    </section>
  );
}

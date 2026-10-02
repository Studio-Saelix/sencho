/**
 * The layered status model for one GitOps application: an Answer, the stages
 * that apply, and what backs them up.
 *
 * Pure apart from the retry-wait clock: it reads a revision projection (and optionally the portfolio row for
 * the same application) and decides what to say and in what order. Nothing
 * here renders, and nothing is inferred beyond the statuses and lookups the
 * rest of the GitOps UI already shares, so a status this build does not know
 * still gets an explicit "unrecognized" word instead of disappearing.
 *
 * See DESIGN.md section 1.1 (Principle 2, answer, path, proof).
 */
import { FileCheck2, FileQuestion, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';

import { limitationCaveats } from '@/lib/gitopsLimitations';
import { attentionLabel, hasKnownPosture, POSTURE_LABEL, type PortfolioLabel } from '@/lib/gitopsPortfolio';
import {
  absentFault,
  ARTIFACT_STATE_LOOKUP,
  liveArtifactFacet,
  liveCaveats,
  livePlacementFacet,
  liveRolloutFacet,
  liveSourceFacet,
  placementStateMeta,
  ROLLOUT_STATE_LOOKUP,
  RUNTIME_STATE_LOOKUP,
  SOURCE_STATE_LOOKUP,
  stateOrUnrecognized,
  type GitOpsStateMeta,
  type GitOpsTone,
} from '@/lib/gitopsState';
import type { GitOpsApprovalRefs, GitOpsRevisionProjection } from '@/types/gitops';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

export type GitOpsStageId = 'source' | 'artifact' | 'placement' | 'rollout' | 'runtime';

export interface GitOpsStatusStage {
  id: GitOpsStageId;
  /** Names the stage; equal to its id. */
  label: GitOpsStageId;
  tone: GitOpsTone;
  /** The state's short name, as the lookups word it. */
  word: string;
  /** The state's full sentence. */
  line: string;
  /** The raw status key, kept so a surface and a test can assert the state without matching copy. */
  status: string;
  /** Specifics the sentence does not carry: a commit, a retry wait, a pause reason, an artifact identity prefix, a target count. */
  detail: string | null;
  icon: LucideIcon;
}

export interface GitOpsStatusAnswer {
  tone: GitOpsTone;
  title: string;
  line: string;
  detail: string | null;
  /** The raw status key the Answer speaks from: the portfolio posture, or the loudest stage's status. */
  status: string;
  icon: LucideIcon;
}

/**
 * Which voice the Answer speaks in. A posture speaks for the whole application
 * (the portfolio row), a stage for the loudest node-local stage, and an
 * unavailable status for an application that was expected and could not be read.
 */
export type GitOpsStatusKind = 'posture' | 'stage' | 'unavailable';

export interface GitOpsStatusModel {
  kind: GitOpsStatusKind;
  answer: GitOpsStatusAnswer;
  /** The stage the Answer speaks for, so its sentence is not repeated under the Path or in the Evidence. Set only for `kind: 'stage'`. */
  answerStageId: GitOpsStageId | null;
  stages: readonly GitOpsStatusStage[];
  /** Attention reasons after the first, which the posture Answer names; kept so none is lost. */
  otherReasons: readonly PortfolioLabel[];
  /** "evidence partial", "2 unproven", or null when there is nothing to qualify. */
  marker: string | null;
}

/** Higher means louder. Success is quietest because a settled stage needs no attention. */
const TONE_RANK: Record<GitOpsTone, number> = {
  destructive: 4,
  warning: 3,
  brand: 2,
  neutral: 1,
  success: 0,
};

/**
 * Whether a placement status tells the reader anything about this application.
 * "Unbound direct" says a stack is not a Blueprint, which is true of every
 * Direct stack and so says nothing; it is left out of the Path rather than
 * printed as a state. `not_applicable` is already dropped by the live-facet
 * readers and is excluded here only so the function stands on its own.
 */
function placementApplies(status: string): boolean {
  return status !== 'unbound_direct' && status !== 'not_applicable';
}

export function formatRetryWait(retryAt: number, now: number = Date.now()): string {
  const ms = retryAt - now;
  if (ms <= 0) return 'Retry due';
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `Retry in ${secs}s`;
  return `Retry in ${Math.ceil(secs / 60)}m`;
}

function sourceDetail(source: NonNullable<ReturnType<typeof liveSourceFacet>>): string | null {
  const parts: string[] = [];
  if (source.candidateGenerationId !== null && source.fetchedCommitSha) {
    parts.push(`Commit ${source.fetchedCommitSha.slice(0, 7)}`);
  }
  if (source.status === 'source_failed') {
    parts.push(source.failureClass);
    if (source.retryAt) parts.push(formatRetryWait(source.retryAt));
  } else if (source.status === 'source_retry_scheduled') {
    parts.push(formatRetryWait(source.retryAt));
  } else if (source.status === 'source_suspended' && source.suspendedReason) {
    parts.push(source.suspendedReason);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function stage(
  id: GitOpsStageId,
  status: string,
  state: GitOpsStateMeta,
  detail: string | null,
): GitOpsStatusStage {
  return { id, label: id, tone: state.tone, word: state.label, line: state.line, status, detail, icon: state.icon };
}

/** The stages that apply to this revision, in reading order. Empty on the absent arm. */
export function applicableStages(revision: GitOpsRevisionProjection | null): readonly GitOpsStatusStage[] {
  if (!revision || revision.targetMode === 'not_applicable') return [];
  const stages: GitOpsStatusStage[] = [];

  const source = liveSourceFacet(revision);
  if (source) {
    stages.push(stage('source', source.status, stateOrUnrecognized(SOURCE_STATE_LOOKUP[source.status], source.status), sourceDetail(source)));
  }

  const artifact = liveArtifactFacet(revision);
  if (artifact) {
    const identity = artifact.expected?.identity ?? null;
    stages.push(stage('artifact', artifact.status, stateOrUnrecognized(ARTIFACT_STATE_LOOKUP[artifact.status], artifact.status), identity ? identity.slice(0, 19) : null));
  }

  const placement = livePlacementFacet(revision);
  if (placement && placementApplies(placement.status)) {
    stages.push(stage('placement', placement.status, stateOrUnrecognized(placementStateMeta(placement), placement.status), null));
  }

  const rollout = liveRolloutFacet(revision);
  if (rollout) {
    const paused = rollout.status === 'rollout_paused' && rollout.pauseReason ? rollout.pauseReason : null;
    stages.push(stage('rollout', rollout.status, stateOrUnrecognized(ROLLOUT_STATE_LOOKUP[rollout.status], rollout.status), paused));
  }

  const targets = revision.targets ?? [];
  const runtimeDetail = targets.length > 1 ? `${targets.length} targets` : null;
  // The loudest target speaks for the runtime stage.
  const runtime = loudest(targets.map(t => (
    stage('runtime', t.runtime.status, stateOrUnrecognized(RUNTIME_STATE_LOOKUP[t.runtime.status], t.runtime.status), runtimeDetail)
  )));
  if (runtime) stages.push(runtime);
  return stages;
}

/** The loudest stage, earliest first on a tie, or null when there are none. */
function loudest(stages: readonly GitOpsStatusStage[]): GitOpsStatusStage | null {
  let best: GitOpsStatusStage | null = null;
  for (const candidate of stages) {
    if (best === null || TONE_RANK[candidate.tone] > TONE_RANK[best.tone]) best = candidate;
  }
  return best;
}

function markerFor(
  revision: GitOpsRevisionProjection,
  evidence: GitOpsPortfolioRow['evidence'] | undefined,
): string | null {
  const parts: string[] = [];
  if (evidence?.unknown) parts.push('evidence unknown');
  else if (evidence?.partial) parts.push('evidence partial');
  if (evidence && evidence.unreachableNodes.length > 0) {
    const n = evidence.unreachableNodes.length;
    parts.push(`${n} ${n === 1 ? 'node' : 'nodes'} not reached`);
  }
  const unproven = limitationCaveats(liveCaveats(revision)).length;
  if (unproven > 0) parts.push(`${unproven} unproven`);
  return parts.length > 0 ? parts.join(' \u00b7 ') : null;
}

const UNRECOGNIZED_POSTURE = { label: 'unknown', tone: 'neutral' } as const;

/**
 * Glyph per tone. Work in flight (refresh) and cannot-prove (question) are the
 * pair most easily confused from a distance, so they differ; warning and
 * destructive share a glyph and differ by tone.
 */
const POSTURE_ICON: Record<GitOpsTone, LucideIcon> = {
  success: FileCheck2,
  destructive: TriangleAlert,
  warning: TriangleAlert,
  brand: RefreshCw,
  neutral: FileQuestion,
};

/** What the portfolio posture means, in one sentence. Settled states get a positive one; the rest say what is missing. */
function postureLine(posture: string): string {
  switch (posture) {
    case 'converged':
      return 'Every target reached, complete, and current evidence confirms the intended generation is running.';
    case 'converged_qualified':
      return 'Every target reached the intended generation, but the executable artifact could not be proven bit-identical.';
    case 'failed':
      return 'Something was proven wrong.';
    case 'attention':
      return 'A decision or repair is waiting on an operator.';
    case 'in_progress':
      return 'Work is still in flight, so this is not a settled answer yet.';
    case 'unknown':
      return 'Sencho cannot currently prove any other state for this application.';
    default:
      return 'This application reports a state this Sencho build does not know.';
  }
}

function postureDetail(
  row: GitOpsPortfolioRow,
  known: boolean,
  otherReasons: readonly PortfolioLabel[],
  detailOverride: string | null,
): string | null {
  if (detailOverride !== null) return detailOverride;
  // A posture this build has no wording for keeps its raw value, so nothing is lost to "unknown".
  if (!known) return `reported as "${row.posture}"`;
  if (otherReasons.length > 0) return `${otherReasons.length} more needing attention`;
  return null;
}

function postureAnswer(
  row: GitOpsPortfolioRow,
  detailOverride: string | null,
): { answer: GitOpsStatusAnswer; otherReasons: readonly PortfolioLabel[] } {
  const known = hasKnownPosture(row.posture) ? POSTURE_LABEL[row.posture] : undefined;
  const posture = known ?? UNRECOGNIZED_POSTURE;
  const reasons = row.attention.map(attentionLabel);
  const top = reasons[0] ?? null;
  const otherReasons = reasons.slice(1);
  return {
    answer: {
      tone: posture.tone,
      title: posture.label,
      line: top ? top.line : postureLine(row.posture),
      detail: postureDetail(row, known !== undefined, otherReasons, detailOverride),
      status: row.posture,
      icon: POSTURE_ICON[posture.tone],
    },
    otherReasons,
  };
}

/** The Answer when no stage applies but a caveat still qualifies the silence. */
const NO_STAGE_ANSWER: GitOpsStatusAnswer = {
  tone: 'neutral',
  title: 'no stage reported',
  line: 'Sencho has no stage to report for this application yet.',
  detail: null,
  status: 'none',
  icon: FileQuestion,
};

function stageAnswer(stage: GitOpsStatusStage): GitOpsStatusAnswer {
  return { tone: stage.tone, title: stage.word, line: stage.line, detail: stage.detail, status: stage.status, icon: stage.icon };
}

/**
 * The status of one application, layered.
 *
 * With the portfolio row the Answer is the application's canonical posture,
 * naming the reason that needs an operator first and keeping the rest for the
 * evidence; the posture holds even when the revision is absent or unreadable,
 * because it is computed hub-side from more than this node's projection. Without
 * the row (the Git source sheet and Blueprint views, which only hold the
 * revision) the Answer speaks for the loudest stage.
 *
 * Returns null when there is no revision to describe, or nothing to say about it.
 */
export function buildGitOpsStatus(
  revision: GitOpsRevisionProjection | null,
  row?: GitOpsPortfolioRow | null,
  /**
   * A stage the surface offers a verb for. It speaks for the Answer when it is
   * not settled, so the verb never sits beside a sentence about something else.
   * Ignored when the portfolio row speaks, which answers for the whole application.
   */
  focus?: GitOpsStageId,
): GitOpsStatusModel | null {
  if (!revision) return null;

  const faults = absentFault(revision);
  if (row) {
    const { answer, otherReasons } = postureAnswer(row, faults.length > 0 ? faults[0].message : null);
    const stages = applicableStages(revision);
    return {
      kind: 'posture',
      answer,
      answerStageId: null,
      stages,
      otherReasons,
      marker: faults.length > 0 ? 'state unavailable' : markerFor(revision, row.evidence),
    };
  }

  if (faults.length > 0) {
    return {
      kind: 'unavailable',
      answer: {
        tone: 'destructive',
        title: 'gitops state unavailable',
        line: faults[0].message,
        detail: null,
        status: 'unavailable',
        icon: TriangleAlert,
      },
      answerStageId: null,
      stages: [],
      otherReasons: [],
      marker: null,
    };
  }

  // The absent arm with no fault is the ordinary stack outside GitOps.
  if (revision.targetMode === 'not_applicable') return null;

  const stages = applicableStages(revision);
  const marker = markerFor(revision, undefined);
  const loudestStage = loudest(stages);
  // The focused stage speaks only if it is at least as loud as anything else, so a
  // verb never quiets a failure elsewhere.
  const focused = focus ? stages.find(s => s.id === focus && s.tone !== 'success') : undefined;
  const speaking = focused && loudestStage && TONE_RANK[focused.tone] >= TONE_RANK[loudestStage.tone]
    ? focused
    : loudestStage;
  // No stage to report, but a caveat still qualifies that silence and must not be dropped.
  if (!speaking && marker === null) return null;
  return {
    kind: 'stage',
    answer: speaking ? stageAnswer(speaking) : NO_STAGE_ANSWER,
    answerStageId: speaking?.id ?? null,
    stages,
    otherReasons: [],
    marker,
  };
}

/**
 * A stage that should state its own sentence under the Path: blocking, not the
 * stage the Answer speaks for, and not a sentence the Answer already says.
 */
export function isSpeakingStage(stage: GitOpsStatusStage, model: Pick<GitOpsStatusModel, 'answer' | 'answerStageId'>): boolean {
  if (stage.id === model.answerStageId) return false;
  if (stage.tone !== 'warning' && stage.tone !== 'destructive') return false;
  return stage.line !== model.answer.line;
}

export interface GrantedAuthority {
  approval: 'source' | 'placement' | 'rollout' | 'legacy';
  label: string;
  ref: string;
}

/**
 * The authority steps with a recorded grant. A ref being set is the whole proof
 * a step was granted; a pending or inapplicable step is not listed, because the
 * Path already carries pending ones in its stage words.
 */
export function grantedAuthority(approvals: GitOpsApprovalRefs | null, rolloutStale: boolean): GrantedAuthority[] {
  if (!approvals) return [];
  const out: GrantedAuthority[] = [];
  if (approvals.sourceAcceptanceRef) out.push({ approval: 'source', label: 'Source accepted', ref: approvals.sourceAcceptanceRef });
  if (approvals.placementApprovalRef) out.push({ approval: 'placement', label: 'Placement approved', ref: approvals.placementApprovalRef });
  // A stale rollout authorization keeps its stored ref, but it no longer covers the current inputs.
  if (approvals.rolloutAuthorizationRef && !rolloutStale) out.push({ approval: 'rollout', label: 'Rollout authorized', ref: approvals.rolloutAuthorizationRef });
  if (approvals.legacyCombinedApprovalRef) out.push({ approval: 'legacy', label: 'Legacy combined approval', ref: approvals.legacyCombinedApprovalRef });
  return out;
}

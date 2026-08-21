// The one place a GitOps facet status becomes words and a colour.
//
// Every surface that shows GitOps state reads these maps, so a status is named
// the same way in a sidebar tooltip, the Git source panel and the Drift tab.
//
// Both maps are Records keyed on the closed status unions in types/gitops.ts.
// That does not react to a backend change on its own, since the mirror is
// hand-written: it means the build fails here the moment someone widens the
// mirror, which is the step that would otherwise leave a status rendering blank.
//
// Each `line` states the condition the backend actually derives, not the one
// the status name suggests. Several of them differ.

import {
  Activity,
  ArchiveX,
  Ban,
  Check,
  CircleAlert,
  CircleDashed,
  CircleHelp,
  CirclePause,
  CircleSlash,
  CircleX,
  Clock,
  Download,
  Hourglass,
  RefreshCw,
  Rocket,
  ShieldAlert,
  TriangleAlert,
  Undo2,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import type {
  GitOpsIdentityRef,
  GitOpsLimitation,
  GitOpsRevisionProjection,
  GitOpsRuntimeStatus,
  GitOpsSourceStatus,
  SourceFacet,
} from '@/types/gitops';

/** The five semantic slots the design system defines. Fuchsia is reserved for image updates. */
export type GitOpsTone = 'brand' | 'success' | 'warning' | 'destructive' | 'neutral';

export interface GitOpsStateMeta {
  /** Short name of the state, rendered in mono uppercase. */
  label: string;
  tone: GitOpsTone;
  /** A complete sentence. Doubles as the sidebar tooltip, so it has to stand alone. */
  line: string;
  icon: LucideIcon;
}

/** Card classes per tone. Identical to the drift status cards so the families read as one. */
export const GITOPS_TONE_CLASS: Record<GitOpsTone, string> = {
  brand: 'border-brand/40 bg-brand/[0.06] text-brand',
  success: 'border-success/40 bg-success/[0.06] text-success',
  warning: 'border-warning/40 bg-warning/[0.06] text-warning',
  destructive: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
  neutral: 'border-muted bg-card/40 text-stat-subtitle',
};

export const SOURCE_STATE: Record<GitOpsSourceStatus, GitOpsStateMeta> = {
  not_applicable: {
    label: 'no git source',
    tone: 'neutral',
    line: 'This application is not backed by a Git source.',
    icon: CircleSlash,
  },
  never_reconciled: {
    label: 'never reconciled',
    tone: 'neutral',
    // Says accepted, not fetched: a fetch that produced no materialization
    // records its commit and still leaves no generation behind.
    line: 'No commit from this repository has been accepted yet.',
    icon: CircleDashed,
  },
  checking_fetching: {
    label: 'fetching',
    tone: 'brand',
    line: 'Sencho is fetching from the repository.',
    icon: Download,
  },
  application_generation_accepted: {
    label: 'accepted',
    tone: 'success',
    line: 'The fetched commit has been accepted as the current generation.',
    icon: Check,
  },
  candidate_ready: {
    label: 'pending update',
    tone: 'brand',
    // This status is reached only when review is not required, and it is the
    // one status that offers apply. Saying "ready to review" would describe
    // source_review_pending, which is the opposite state.
    line: 'A fetched commit is ready to apply.',
    icon: CircleAlert,
  },
  source_review_pending: {
    label: 'review required',
    tone: 'warning',
    line: 'A fetched commit is waiting for review before it can apply.',
    icon: Hourglass,
  },
  source_conflict_blocker: {
    label: 'pending update blocked',
    tone: 'warning',
    line: 'The change plan has local conflicts. Apply stays disabled until they are resolved.',
    icon: TriangleAlert,
  },
  source_reconcile_required: {
    label: 'reconcile required',
    tone: 'warning',
    // Reachable both from a stale candidate and from an accepted generation
    // with no candidate at all, so the line cannot name a fetched commit.
    line: 'What was reconciled no longer matches the configuration in force. Fetch again to rebuild the candidate.',
    icon: RefreshCw,
  },
  source_superseded: {
    label: 'superseded',
    tone: 'neutral',
    line: 'A newer generation replaced the one this state describes.',
    icon: ArchiveX,
  },
  applying: {
    label: 'applying',
    tone: 'brand',
    line: 'A commit is being applied to the stack directory.',
    icon: Upload,
  },
  source_retry_scheduled: {
    label: 'retry scheduled',
    tone: 'warning',
    line: 'The last attempt failed and a retry is scheduled.',
    icon: Clock,
  },
  source_suspended: {
    label: 'suspended',
    tone: 'neutral',
    line: 'Reconciliation is suspended for this source.',
    icon: CirclePause,
  },
  source_failed: {
    label: 'source failed',
    tone: 'destructive',
    line: 'The last operation on this source failed.',
    icon: CircleX,
  },
  source_unknown: {
    label: 'outcome unknown',
    tone: 'warning',
    line: 'An operation was interrupted, so its outcome could not be confirmed.',
    icon: CircleHelp,
  },
  recovery_required: {
    label: 'recovering',
    // In flight, not pending: the only derivation is a recovery phase of
    // restoring or compensating, and no action is offered while it runs.
    tone: 'brand',
    line: 'Recovery is running on this stack.',
    icon: Undo2,
  },
  recovery_failed: {
    label: 'recovery failed',
    tone: 'destructive',
    line: 'Recovery of this stack did not complete.',
    icon: ShieldAlert,
  },
  not_live: {
    label: 'not live',
    tone: 'neutral',
    line: 'This application is no longer live. The identity shown is what it was.',
    icon: CircleSlash,
  },
};

export const RUNTIME_STATE: Record<GitOpsRuntimeStatus, GitOpsStateMeta> = {
  tombstoned: {
    label: 'tombstoned',
    tone: 'neutral',
    // Still projected, so "no longer tracked" would be wrong. It is retired.
    line: 'This target is retired and is no longer reconciled.',
    icon: ArchiveX,
  },
  never_applied: {
    label: 'never applied',
    tone: 'neutral',
    line: 'No generation has been applied on this node yet.',
    icon: CircleDashed,
  },
  deploying: {
    label: 'deploying',
    tone: 'brand',
    line: 'A deploy is in progress on this node.',
    icon: Rocket,
  },
  withdrawing: {
    label: 'withdrawing',
    tone: 'brand',
    line: 'The stack is being withdrawn from this node.',
    icon: Undo2,
  },
  correcting: {
    label: 'correcting',
    tone: 'brand',
    line: 'Sencho is correcting this node back to the intended state.',
    icon: RefreshCw,
  },
  health_checking: {
    label: 'health checking',
    tone: 'brand',
    line: 'A health run is watching the current deploy.',
    icon: Activity,
  },
  fully_deployed_health_pending: {
    label: 'health pending',
    tone: 'brand',
    line: 'The generation is deployed and its health verdict is still pending.',
    icon: Hourglass,
  },
  artifact_verification_pending: {
    label: 'artifact unverified',
    tone: 'brand',
    line: 'What is running could not be identified precisely enough to compare.',
    icon: CircleHelp,
  },
  synced_and_healthy: {
    label: 'synced and healthy',
    tone: 'success',
    // Claims neither acceptance nor a health run. The deriver never compares
    // the deployed generation with the accepted one, and it reaches this state
    // with no health run at all when the health gate is off.
    line: 'This node is running its deployed generation with nothing outstanding.',
    icon: Check,
  },
  applied_not_deployed: {
    label: 'applied not deployed',
    tone: 'warning',
    // The target's own applied pointer, which lags the application's accepted
    // generation whenever this node is behind.
    line: 'The applied generation is on disk but has not been deployed.',
    icon: Upload,
  },
  drifted: {
    label: 'drifted',
    tone: 'warning',
    line: 'What is running no longer matches the intended generation.',
    icon: TriangleAlert,
  },
  health_drift: {
    label: 'health drift',
    tone: 'warning',
    line: 'The deployed generation is current but its health check is failing.',
    icon: Activity,
  },
  disk_invocation_drift: {
    label: 'invocation drift',
    tone: 'warning',
    line: 'The files on disk no longer match the invocation that deployed them.',
    icon: TriangleAlert,
  },
  rollout_artifact_drift: {
    label: 'rollout artifact drift',
    tone: 'warning',
    line: 'The planned rollout artifact differs from the one this node holds.',
    icon: TriangleAlert,
  },
  runtime_artifact_drift: {
    label: 'runtime artifact drift',
    tone: 'warning',
    line: 'The running image differs from the expected artifact for this node.',
    icon: TriangleAlert,
  },
  stale_acknowledgement: {
    label: 'stale acknowledgement',
    tone: 'warning',
    line: 'This node acknowledged a generation that is no longer current.',
    icon: Clock,
  },
  acknowledged_completion_unknown: {
    label: 'completion unknown',
    tone: 'warning',
    line: 'This node acknowledged the work but its outcome was never confirmed.',
    icon: CircleHelp,
  },
  pending_state_review: {
    label: 'state review pending',
    tone: 'warning',
    line: 'This node is holding stateful changes for review before it proceeds.',
    icon: Hourglass,
  },
  evict_blocked: {
    label: 'evict blocked',
    tone: 'warning',
    line: 'The stack cannot be removed from this node yet.',
    icon: Ban,
  },
  retry_scheduled: {
    label: 'retry scheduled',
    tone: 'warning',
    line: 'The last attempt on this node failed and a retry is scheduled.',
    icon: Clock,
  },
  recovery_required: {
    label: 'recovering',
    // Same derivation as the source facet: a recovery phase in flight.
    tone: 'brand',
    line: 'Recovery is running on this node.',
    icon: Undo2,
  },
  partially_rolled_out: {
    label: 'partially rolled out',
    tone: 'warning',
    // Derived from this target's own partial result. The fleet-wide reading
    // belongs to the rollout facet, which this map does not cover.
    line: 'This node reports a partial result for its last rollout.',
    icon: CircleDashed,
  },
  paused: {
    label: 'paused',
    tone: 'warning',
    line: 'Work on this node is paused.',
    icon: CirclePause,
  },
  completion_unknown: {
    label: 'completion unknown',
    tone: 'warning',
    line: 'An operation was interrupted, so its outcome could not be confirmed.',
    icon: CircleHelp,
  },
  failed_previous_workload_intact: {
    label: 'failed, workload intact',
    tone: 'destructive',
    line: 'The deploy failed before it changed anything. The previous workload is still running.',
    icon: CircleX,
  },
  failed_after_mutation: {
    label: 'failed after change',
    tone: 'destructive',
    line: 'The deploy failed after it had started changing the workload.',
    icon: CircleX,
  },
  recovery_failed: {
    label: 'recovery failed',
    tone: 'destructive',
    line: 'Recovery on this node did not complete.',
    icon: ShieldAlert,
  },
};

/**
 * Read views over the two maps for a status that crossed the wire.
 *
 * The maps above are total over the closed unions, so indexing them yields a
 * non-optional value and a miss is invisible to the compiler. That is right
 * for a status this build derived and wrong for one a proxied node sent, which
 * may belong to a vocabulary this build has never seen. Reading through these
 * makes the miss a fact TypeScript produces, so the guard on it cannot be
 * mistaken for dead code and deleted.
 *
 * Same objects, no copy, no cast: a total record over string-literal keys is
 * assignable to a partial record over `string`.
 */
export const SOURCE_STATE_LOOKUP: Partial<Record<string, GitOpsStateMeta>> = SOURCE_STATE;
export const RUNTIME_STATE_LOOKUP: Partial<Record<string, GitOpsStateMeta>> = RUNTIME_STATE;

/**
 * Frontend view state: stack name to the source status of its waiting candidate.
 * A key being present is what "this stack has a Git update waiting" means, so
 * the value is optional: a miss is a stack with nothing waiting, not a status.
 */
export type GitSourcePendingMap = Record<string, GitOpsSourceStatus | undefined>;

/** A source facet that is actually describing a Git source, so it carries the identity fields. */
export type LiveSourceFacet = Exclude<SourceFacet, { status: 'not_applicable' }>;

/**
 * The Git source facet of a live application, or null when there is none to show.
 *
 * Two exclusions, and both mean "this surface has nothing to say", not "an
 * error": the absent arm carries no facets at all, and a live application whose
 * source facet is `not_applicable` is Blueprint-owned, where naming a source
 * state would be a claim the model never made.
 */
export function liveSourceFacet(revision: GitOpsRevisionProjection | null): LiveSourceFacet | null {
  if (!revision || revision.targetMode === 'not_applicable') return null;
  const source = revision.facets.source;
  return source.status === 'not_applicable' ? null : source;
}

/**
 * The source status when a fetched candidate is waiting, else null.
 *
 * Presence is keyed on the candidate pointer rather than on the status name.
 * `source_reconcile_required` is reachable two ways: from a candidate whose
 * fingerprint went stale, and from an accepted generation with no candidate at
 * all. Only the first is a waiting update, so keying on the status would start
 * flagging stacks that have nothing to review.
 *
 * A retired application is excluded before the pointer is read. Tombstoning
 * keeps the candidate pointer as a frozen fact, so a stack detached while a
 * commit was staged still carries one, and reporting it would advertise an
 * update on a stack Git no longer manages.
 */
export function pendingSourceStatus(revision: GitOpsRevisionProjection): GitOpsSourceStatus | null {
  const source = liveSourceFacet(revision);
  if (!source || source.status === 'not_live') return null;
  return source.candidateGenerationId === null ? null : source.status;
}

/**
 * Limitations that mean "an application we had reason to expect was unreachable".
 *
 * Only the absent arm can carry these. On the live arm, limitations are caveats
 * on state that is being reported (an unparseable repo URL, a missing artifact
 * pointer), not faults, and surfacing them as failures would recreate the same
 * conflation in the opposite direction.
 */
export function absentFault(revision: GitOpsRevisionProjection): readonly GitOpsLimitation[] {
  return revision.targetMode === 'not_applicable' ? revision.limitations : [];
}

/**
 * Caveats on state that is being reported, the exact complement of `absentFault`.
 *
 * A live limitation qualifies the answer rather than replacing it: the state
 * shown is real, and one piece of evidence behind it could not be proven. The
 * two arms are read through separate functions on purpose, because rendering a
 * caveat as a fault would claim the state is unavailable when it is not, and
 * rendering a fault as a caveat would claim a state nobody derived.
 */
export function liveCaveats(revision: GitOpsRevisionProjection): readonly GitOpsLimitation[] {
  return revision.targetMode === 'not_applicable' ? [] : revision.limitations;
}

/** One short line naming what an identity reference points at, for a drift comparison row. */
export function identityRefLabel(ref: GitOpsIdentityRef): string {
  switch (ref.kind) {
    case 'none':
      return 'none';
    case 'unknown':
      return 'unknown';
    case 'commit':
      return `commit ${ref.sha.slice(0, 7)}`;
    case 'generation':
      return `generation ${ref.id.slice(0, 8)}`;
    case 'artifact_set':
      return `artifact ${ref.id.slice(0, 8)} · ${ref.qualification}`;
    case 'runtime_artifact':
      return ref.identity;
    case 'intent':
      return `intent ${ref.id.slice(0, 8)}`;
    case 'rollout_candidate':
      return `candidate ${ref.id.slice(0, 8)}`;
    case 'rollout_generation':
      return `rollout ${ref.id.slice(0, 8)}`;
    case 'invocation':
      return ref.authored.composeFileOrder.join(', ') || 'no compose files';
    case 'health_run':
      return `health run ${ref.runId.slice(0, 8)}`;
  }
}

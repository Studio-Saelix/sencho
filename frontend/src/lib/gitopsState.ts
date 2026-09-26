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
  Eye,
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
  Fingerprint,
  KeyRound,
  MapPin,
  OctagonX,
  PauseCircle,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';

import type {
  ArtifactFacet,
  GitOpsArtifactStatus,
  GitOpsIdentityRef,
  GitOpsLimitation,
  GitOpsPlacementStatus,
  GitOpsRevisionProjection,
  GitOpsRolloutStatus,
  GitOpsRuntimeStatus,
  GitOpsSourceStatus,
  HealthRolloutPolicy,
  HealthStopReason,
  PlacementFacet,
  RolloutFacet,
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

export const ARTIFACT_STATE: Record<GitOpsArtifactStatus, GitOpsStateMeta> = {
  not_applicable: {
    label: 'no artifact proof',
    tone: 'neutral',
    line: 'Executable artifact identity does not apply to this application.',
    icon: CircleSlash,
  },
  artifact_unresolved: {
    label: 'artifact unresolved',
    tone: 'neutral',
    line: 'Sencho has not recorded executable artifact evidence for this generation yet.',
    icon: CircleDashed,
  },
  artifact_resolution_pending: {
    label: 'artifact pending',
    tone: 'brand',
    line: 'The accepted generation is waiting for executable artifact resolution to finish.',
    icon: Hourglass,
  },
  artifact_exact: {
    label: 'artifact exact',
    tone: 'success',
    line: 'Sencho proved the exact executable digest for every required registry service.',
    icon: Fingerprint,
  },
  artifact_qualified: {
    label: 'artifact qualified',
    tone: 'success',
    line: 'Sencho proved the platform-specific digest for this node on a multi-arch image.',
    icon: Fingerprint,
  },
  artifact_stale: {
    label: 'artifact stale',
    tone: 'warning',
    line: 'A registry tag moved after acceptance. The frozen expected artifact set did not change.',
    icon: RefreshCw,
  },
  artifact_unavailable: {
    label: 'artifact unavailable',
    tone: 'warning',
    line: 'Sencho could not reach a registry or classify an image reference for this generation.',
    icon: CircleHelp,
  },
  artifact_local_build_unverified: {
    label: 'local build unverified',
    tone: 'warning',
    line: 'This generation includes a local build service, so Sencho cannot claim an exact cross-node digest.',
    icon: CircleHelp,
  },
  artifact_identity_changed: {
    label: 'artifact changed',
    tone: 'warning',
    line: 'Newer artifact evidence disagrees with the frozen expected executable identity.',
    icon: TriangleAlert,
  },
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
  source_poll_scheduled: {
    label: 'poll scheduled',
    tone: 'neutral',
    line: 'The source is healthy and waiting for its next scheduled poll.',
    icon: Clock,
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

export const PLACEMENT_STATE: Record<GitOpsPlacementStatus, GitOpsStateMeta> = {
  not_applicable: {
    label: 'no placement',
    tone: 'neutral',
    line: 'Blueprint placement does not apply to this application.',
    icon: CircleSlash,
  },
  unbound_direct: {
    label: 'unbound direct',
    tone: 'neutral',
    line: 'This Direct stack is not bound to a Blueprint placement model.',
    icon: CircleSlash,
  },
  unknown: {
    label: 'placement unknown',
    tone: 'warning',
    line: 'Sencho could not resolve placement because the intent revision is missing.',
    icon: CircleHelp,
  },
  source_acceptance_pending: {
    label: 'source acceptance pending',
    tone: 'brand',
    line: 'A generation is waiting for source acceptance before placement can proceed.',
    icon: Hourglass,
  },
  placement_review_pending: {
    label: 'placement review pending',
    tone: 'warning',
    line: 'Placement is waiting for operator review of the confirmed blast radius.',
    icon: Hourglass,
  },
  rollout_authorization_pending: {
    label: 'rollout authorization pending',
    tone: 'brand',
    line: 'Registry preflight is satisfied and rollout authorization is waiting to be recorded.',
    icon: KeyRound,
  },
  rollout_authorization_stale: {
    label: 'rollout authorization stale',
    tone: 'warning',
    // Granted, then outlived by its inputs. Never "expired" or "invalid": the
    // authorization was real, the placement or preflight it was bound to moved.
    line: 'The rollout authorization was granted against earlier inputs and no longer matches the current placement or preflight fingerprint.',
    icon: RefreshCw,
  },
  stateful_confirmation_required: {
    label: 'stateful confirmation required',
    tone: 'warning',
    line: 'A stateful placement outcome needs operator confirmation before it can proceed.',
    icon: Hourglass,
  },
  preflight_blocked: {
    label: 'registry preflight blocked',
    tone: 'destructive',
    line: 'Registry readiness is blocked, or has not been evaluated yet.',
    icon: Ban,
  },
  blueprint_bound: {
    label: 'blueprint bound',
    // Neutral, not success: bound is a fact about which model owns placement,
    // not a proven outcome. Sencho does not derive convergence for it.
    tone: 'neutral',
    line: 'Placement is bound to a Blueprint; Sencho does not derive its placement convergence.',
    icon: MapPin,
  },
};

// The fleet-wide reading of a rollout. Per-node wording stays in RUNTIME_STATE:
// lines here say "the fleet" or "the rollout", never "this node".
export const ROLLOUT_STATE: Record<GitOpsRolloutStatus, GitOpsStateMeta> = {
  not_applicable: {
    label: 'no rollout',
    tone: 'neutral',
    // Two derivations land here: a Direct application, and a Blueprint
    // application with no rollout candidate and no authorized generation binding.
    line: 'No rollout applies to this application.',
    icon: CircleSlash,
  },
  rollout_not_executable: {
    label: 'rollout not executable',
    tone: 'warning',
    line: 'A rollout candidate exists, but no authorized rollout is bound to the current inputs.',
    icon: Ban,
  },
  rollout_queued: {
    label: 'rollout queued',
    tone: 'brand',
    // Also the authorized-but-unacknowledged reading: not every required node
    // has confirmed the authorized generation yet.
    line: 'The rollout is authorized and waiting for the fleet to pick it up.',
    icon: Hourglass,
  },
  canary_in_progress: {
    label: 'canary in progress',
    tone: 'brand',
    line: 'The rollout is deploying to a canary subset of the fleet.',
    icon: Rocket,
  },
  batch_in_progress: {
    label: 'batch in progress',
    tone: 'brand',
    line: 'The rollout is deploying across the fleet in batches.',
    icon: Rocket,
  },
  rollout_paused: {
    label: 'rollout paused',
    tone: 'warning',
    line: 'The rollout is paused.',
    icon: CirclePause,
  },
  partially_rolled_out: {
    label: 'partially rolled out',
    tone: 'warning',
    // Fleet reading only. The stored partial payload is undecoded JSON, so the
    // line must not claim to know which nodes are behind or why.
    line: 'The rollout has reached only part of the fleet.',
    icon: CircleDashed,
  },
  fully_deployed_health_pending: {
    label: 'health pending',
    tone: 'brand',
    line: 'Every required node runs the rollout; health verdicts are still pending.',
    icon: Hourglass,
  },
  configuration_converged_artifact_qualified: {
    label: 'configuration converged',
    tone: 'success',
    // Configuration convergence with per-platform artifact proof, reached when
    // the artifact facet is qualified rather than exact. Not executable
    // convergence: exactly_converged_healthy is the only terminal success.
    line: 'The fleet runs the authorized configuration, proven with per-platform artifact evidence.',
    icon: Fingerprint,
  },
  exactly_converged_healthy: {
    label: 'exactly converged',
    tone: 'success',
    line: 'Every required node runs the authorized generation with matching exact digests and passing health.',
    icon: Check,
  },
  rollout_superseded: {
    label: 'superseded',
    tone: 'neutral',
    // Covers both producers: a newer generation replaced it, or an operator
    // withdrew it (supersede, or a rollback that abandoned it).
    line: 'This rollout generation is no longer active: an operator withdrew it or a newer generation replaced it.',
    icon: ArchiveX,
  },
  target_stale: {
    label: 'target stale',
    tone: 'warning',
    line: 'A rollout target has not reported recently, so the fleet picture may be behind.',
    icon: Clock,
  },
  target_unreachable: {
    label: 'target unreachable',
    tone: 'warning',
    line: 'A rollout target is unreachable, so the fleet state cannot be fully confirmed.',
    icon: TriangleAlert,
  },
  rollback_in_progress: {
    label: 'rollback in progress',
    tone: 'brand',
    line: 'A rollback is running across the fleet.',
    icon: Undo2,
  },
  rollback_partial_failed: {
    label: 'rollback partially failed',
    tone: 'destructive',
    line: 'The rollback failed on part of the fleet.',
    icon: ShieldAlert,
  },
  recovery_required: {
    label: 'recovery required',
    tone: 'warning',
    // Needs recovery first, not in flight: source and runtime use this status
    // for a recovery phase that is running, while the rollout vocabulary
    // reserves it for a rollout that cannot proceed until one has happened.
    // Nothing derives it yet; the entry exists so the union stays total.
    line: 'The rollout needs recovery before it can proceed.',
    icon: Undo2,
  },
  completion_unknown: {
    label: 'completion unknown',
    tone: 'warning',
    line: 'An interruption left the outcome of the rollout unconfirmed.',
    icon: CircleHelp,
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
  runtime_artifact_drift: {
    label: 'runtime artifact drift',
    tone: 'warning',
    line: 'The running image digest differs from the frozen expected artifact for this node.',
    icon: TriangleAlert,
  },
  rollout_artifact_drift: {
    label: 'rollout artifact drift',
    tone: 'warning',
    line: 'A required rollout target holds a different image digest than the approved set.',
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
 * Read views over the maps for a status that crossed the wire.
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
export const ARTIFACT_STATE_LOOKUP: Partial<Record<string, GitOpsStateMeta>> = ARTIFACT_STATE;
export const PLACEMENT_STATE_LOOKUP: Partial<Record<string, GitOpsStateMeta>> = PLACEMENT_STATE;
export const ROLLOUT_STATE_LOOKUP: Partial<Record<string, GitOpsStateMeta>> = ROLLOUT_STATE;
export const RUNTIME_STATE_LOOKUP: Partial<Record<string, GitOpsStateMeta>> = RUNTIME_STATE;

/** Card copy for a placement facet. Preflight blocked uses the redacted server reason as the line. */
export function placementStateMeta(facet: PlacementFacet): GitOpsStateMeta | undefined {
  const base = PLACEMENT_STATE_LOOKUP[facet.status];
  if (!base) return undefined;
  if (facet.status === 'preflight_blocked') {
    return { ...base, line: facet.reason };
  }
  return base;
}

/**
 * The state for a status, or an explicit unrecognized state when this build
 * does not know it. The shared card renders nothing for an unknown status,
 * which suits a list row; on an evidence surface the whole point is that no
 * facet and no target disappears, so a status from a newer node still gets a
 * card that says so.
 */
export function stateOrUnrecognized(state: GitOpsStateMeta | undefined, status: string): GitOpsStateMeta {
  return state ?? {
    label: 'unrecognized state',
    tone: 'neutral',
    line: `Reported as "${status}", a state this version of Sencho does not recognize.`,
    icon: CircleHelp,
  };
}

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
 * state would be a claim the model never made. Defensively, a live payload
 * missing its facets (a malformed remote answer) also reads as nothing to show.
 */
export function liveSourceFacet(revision: GitOpsRevisionProjection | null): LiveSourceFacet | null {
  if (!revision || revision.targetMode === 'not_applicable' || !revision.facets) return null;
  const source = revision.facets.source;
  return source.status === 'not_applicable' ? null : source;
}

/** Artifact facet for a live Direct application, or null when there is none to show. */
export type LiveArtifactFacet = Exclude<ArtifactFacet, { status: 'not_applicable' }>;

export function liveArtifactFacet(revision: GitOpsRevisionProjection | null): LiveArtifactFacet | null {
  if (!revision || revision.targetMode === 'not_applicable' || !revision.facets) return null;
  const artifact = revision.facets.artifact;
  return artifact.status === 'not_applicable' ? null : artifact;
}

/** Placement facet for a live application, or null when there is none to show. */
export type LivePlacementFacet = Exclude<PlacementFacet, { status: 'not_applicable' }>;

export function livePlacementFacet(revision: GitOpsRevisionProjection | null): LivePlacementFacet | null {
  if (!revision || revision.targetMode === 'not_applicable' || !revision.facets) return null;
  const placement = revision.facets.placement;
  return placement.status === 'not_applicable' ? null : placement;
}

/** Rollout facet for a live application, or null when there is none to show. */
export type LiveRolloutFacet = Exclude<RolloutFacet, { status: 'not_applicable' }>;

export function liveRolloutFacet(revision: GitOpsRevisionProjection | null): LiveRolloutFacet | null {
  if (!revision || revision.targetMode === 'not_applicable' || !revision.facets) return null;
  const rollout = revision.facets.rollout;
  return rollout.status === 'not_applicable' ? null : rollout;
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

/**
 * The class name a drift item is shown under. The backend class is an
 * identifier, and one of them is not a word a reader should have to decode, so
 * every surface that prints a class reads it from here. The map is keyed by
 * string because the classes arrive over the wire: a class this build does not
 * know is shown as itself rather than hidden.
 */
const DRIFT_CLASS_LABELS: Record<string, string> = {
  source: 'source',
  managed_project: 'managed project',
  invocation: 'invocation',
  placement: 'placement',
  rollout: 'rollout',
  runtime: 'runtime',
  health: 'health',
};

export function driftClassLabel(className: string): string {
  return DRIFT_CLASS_LABELS[className] ?? className;
}

/**
 * What each health-and-rollout policy does, in the operator's terms.
 *
 * Every entry states the default, because a rollout that has never had a policy
 * chosen is already running under it, and an operator reading the control needs
 * to know that choosing nothing is not choosing nothing.
 */
export const HEALTH_ROLLOUT_POLICY_STATE: Record<HealthRolloutPolicy, GitOpsStateMeta> = {
  observe: {
    label: 'observe',
    tone: 'neutral',
    line: 'Record each target\u2019s health outcome and keep deploying the rest regardless. The default.',
    icon: Eye,
  },
  pause: {
    label: 'pause',
    tone: 'warning',
    line: 'Stop before the next target when one fails or its health cannot be confirmed.',
    icon: PauseCircle,
  },
  retry_once: {
    label: 'retry once',
    tone: 'brand',
    line: 'Deploy the same generation to a failed target one more time, then pause.',
    icon: RotateCcw,
  },
  stop: {
    label: 'stop',
    tone: 'destructive',
    line: 'Stop the rest of the rollout when a target fails. Already deployed targets stay as they are.',
    icon: OctagonX,
  },
  rollback: {
    label: 'rollback',
    tone: 'destructive',
    line: 'Restore a failed target to the generation it ran before this rollout, then stop the rest.',
    icon: Undo2,
  },
};

/**
 * Why a rollout stopped advancing, and what it means for this target.
 *
 * A reason nobody can act on is worse than none, so an unknown or a passed
 * reason is stated as such rather than dressed up.
 */
export const HEALTH_STOP_REASON_STATE: Record<HealthStopReason, GitOpsStateMeta> = {
  health_passed: {
    label: 'advanced',
    tone: 'success',
    line: 'This target passed and the rollout moved on to the next one.',
    icon: Check,
  },
  health_failed: {
    label: 'health failed',
    tone: 'destructive',
    line: 'The health run for this target failed.',
    icon: CircleX,
  },
  health_unknown: {
    label: 'health unknown',
    tone: 'warning',
    line: 'Health could not be confirmed. The rollout paused rather than assume the target is healthy.',
    icon: CircleHelp,
  },
  health_retried: {
    label: 'retrying',
    tone: 'brand',
    line: 'This target failed once and is being deployed again with the same generation.',
    icon: RotateCcw,
  },
  health_retry_exhausted: {
    label: 'retry exhausted',
    tone: 'warning',
    line: 'This target already used its one retry and failed again, so the rollout paused.',
    icon: PauseCircle,
  },
  rollout_stopped: {
    label: 'rollout stopped',
    tone: 'destructive',
    line: 'A target failed and the rest of the rollout was stopped. Already deployed targets are unchanged.',
    icon: OctagonX,
  },
  rollback_completed: {
    label: 'rolled back',
    tone: 'neutral',
    line: 'This target was put back on the generation it ran before this rollout.',
    icon: RotateCcw,
  },
  rollback_unavailable: {
    label: 'recovery required',
    tone: 'destructive',
    line: 'This target failed and no pre-rollout generation was captured, so nothing was restored automatically.',
    icon: TriangleAlert,
  },
};

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

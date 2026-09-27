/**
 * The executable identity a runtime drift repair is allowed to restore.
 *
 * Enforce restores state; it does not authorize state. The only thing it may
 * restore is the generation and artifact set the target was already
 * acknowledged against, so the authority for a repair is the target's own
 * binding: its acknowledged generation and the artifact set that generation was
 * qualified under. For a Git-managed Blueprint that binding is corroborated by
 * the immutable rollout generation it was frozen into.
 *
 * Nothing here reads the application's current accepted generation or artifact
 * set. Those pointers answer "what is newest", and a repair that consults them
 * silently upgrades a target that was acknowledged against an older generation
 * the moment a newer one is accepted for any reason.
 */
import { decodeGitOpsRequiredTargetsJson } from './json';
import type { GitOpsStore } from './store';
import type {
  GitOpsApplicationRow,
  GitOpsTargetCurrentRow,
} from './types';

/** Why a repair was not attempted. Each arm is a state, not an error. */
export type RuntimeRepairHoldReason =
  /** The target has no acknowledged generation to restore. */
  | 'evidence_incomplete'
  /** The target's rollout generation was superseded; the rollout that replaced it owns the target. */
  | 'rollout_superseded'
  /** The node is not in the frozen required set of the rollout it is bound to. */
  | 'not_a_required_target'
  /** A named rollout generation or artifact set could not be read. */
  | 'authority_unreadable'
  /** The rollout generation and the target's acknowledged pointers disagree. */
  | 'binding_incoherent'
  /** The target is unreachable, or its connectivity evidence has gone stale. */
  | 'target_evidence_stale'
  /** A previous mutation on this target was interrupted, so its state is not known. */
  | 'target_interrupted'
  /** A recovery or rollback owns this target, and a repair would race it. */
  | 'recovery_bound'
  /**
   * The Blueprint's classification forbids an automatic repair, so the drift
   * policy declines it whatever the runtime evidence says.
   */
  | 'classification_forbids_repair';

/**
 * Whether a recovery is still moving on this target.
 *
 * Only the in-progress phases. `complete` and `failed` are terminal and persist
 * for the life of the target, so testing the column for non-null would hold
 * every target that has ever been recovered, which is most of them after a
 * rollback. Mirrors `recoveryInProgress` in `derive.ts`; kept local rather than
 * imported so this module stays below the projection.
 */
function recoveryInProgress(phase: string | null): boolean {
  return phase === 'capturing' || phase === 'restoring' || phase === 'compensating';
}

export type RuntimeRepairBinding =
  | {
      kind: 'binding';
      /** The generation this target acknowledged, and the only one a repair may restore. */
      acceptedGenerationId: string;
      /** The artifact set that generation was qualified under, for digest comparison and pins. */
      artifactSetId: string;
      /** The live rollout generation that froze the pair, or null for Inline content. */
      rolloutGenerationId: string | null;
    }
  | { kind: 'hold'; reason: RuntimeRepairHoldReason };

/**
 * Resolve the identity a runtime repair may restore for one target.
 *
 * Mirrors the shape of the frozen health policy read: a named authority that
 * cannot be read is a damaged pointer, never a permission. Every arm is
 * fail-closed, because the alternative is a repair against an identity nobody
 * authorized for this target.
 */
export function resolveRuntimeRepairBinding(
  store: GitOpsStore,
  app: GitOpsApplicationRow,
  target: GitOpsTargetCurrentRow | undefined,
): RuntimeRepairBinding {
  if (!target) return { kind: 'hold', reason: 'evidence_incomplete' };

  // These arms come first because they say the target's own state is not
  // trustworthy yet, which outranks any question about which generation to
  // restore. A repair writes to the node, so it must not run against a target
  // that is unreachable, mid-interruption, or owned by an unfinished recovery.
  if (target.connectivity === 'unreachable' || target.connectivity === 'stale') {
    return { kind: 'hold', reason: 'target_evidence_stale' };
  }
  if (target.interruption_stage !== null) {
    return { kind: 'hold', reason: 'target_interrupted' };
  }
  // Every state below means another writer owns this target's next mutation: a
  // recovery in progress, a partial rollout, an LKG that cannot be reached, or a
  // rollout waiting on a health verdict. A repair that raced any of them would
  // fight the writer that already holds the target.
  if (
    target.health_stop_reason === 'rollback_pending'
    || target.partial_json !== null
    || target.lkg_unavailable_at !== null
    || recoveryInProgress(target.recovery_phase)
    || target.pending_health_run_id !== null
  ) {
    return { kind: 'hold', reason: 'recovery_bound' };
  }

  const acceptedGenerationId = target.desired_generation_id;
  const artifactSetId = target.expected_artifact_set_id;
  // The acknowledged pair is the whole authority. One without the other cannot
  // name a restorable identity, and reading either from the application instead
  // is exactly the substitution this refuses to perform.
  if (!acceptedGenerationId || !artifactSetId) {
    return { kind: 'hold', reason: 'evidence_incomplete' };
  }

  const generation = store.getGeneration(acceptedGenerationId);
  if (!generation || generation.application_id !== app.id) {
    return { kind: 'hold', reason: 'authority_unreadable' };
  }
  if (!store.getArtifactSet(artifactSetId)) {
    return { kind: 'hold', reason: 'authority_unreadable' };
  }

  // Inline content has no rollout generation: the acknowledged pair is frozen by
  // the source acceptance that produced it, and there is no rollout to supersede.
  // Both paths still require the pair to resolve, so "the set this target
  // acknowledged cannot be read" reports the same way regardless of content mode.
  if (!target.rollout_generation_id) {
    return { kind: 'binding', acceptedGenerationId, artifactSetId, rolloutGenerationId: null };
  }

  const rollout = store.getRolloutGeneration(target.rollout_generation_id);
  if (!rollout || rollout.application_id !== app.id) {
    return { kind: 'hold', reason: 'authority_unreadable' };
  }
  // A superseded rollout is not repaired behind the rollout that replaced it.
  // The target is mid-advancement, and the newer rollout owns its next mutation.
  if (rollout.superseded_at !== null) {
    return { kind: 'hold', reason: 'rollout_superseded' };
  }

  let requiredNodeIds: number[];
  try {
    requiredNodeIds = decodeGitOpsRequiredTargetsJson(rollout.required_targets_json).nodeIds;
  } catch {
    return { kind: 'hold', reason: 'authority_unreadable' };
  }
  if (!requiredNodeIds.includes(target.node_id)) {
    return { kind: 'hold', reason: 'not_a_required_target' };
  }

  // The rollout freezes the pair the target acknowledged. A disagreement means
  // one of the two is mid-write or damaged, and guessing which one is current
  // is the failure mode this whole module exists to remove.
  if (
    rollout.accepted_generation_id !== acceptedGenerationId
    || rollout.artifact_set_id !== artifactSetId
  ) {
    return { kind: 'hold', reason: 'binding_incoherent' };
  }

  return {
    kind: 'binding',
    acceptedGenerationId,
    artifactSetId,
    rolloutGenerationId: rollout.id,
  };
}

/** Operator-facing explanation of a hold, for the drift summary and notifications. */
export function describeRuntimeRepairHold(reason: RuntimeRepairHoldReason): string {
  switch (reason) {
    case 'evidence_incomplete':
      return 'no acknowledged generation to restore';
    case 'rollout_superseded':
      return 'the rollout for this target was superseded, so the rollout replacing it owns it';
    case 'not_a_required_target':
      return 'this node is not in the frozen target set of the rollout it is bound to';
    case 'authority_unreadable':
      return 'the generation or artifact set this target acknowledged could not be read';
    case 'binding_incoherent':
      return 'the rollout and the target acknowledgements disagree, so neither can be trusted as current';
    case 'target_evidence_stale':
      return 'this node is unreachable or its connectivity evidence is stale, so Sencho cannot write to it safely';
    case 'target_interrupted':
      return 'an earlier change to this target was interrupted, so what is running is not known';
    case 'recovery_bound':
      return 'a recovery or rollback owns this target, so an auto-fix would race it';
    case 'classification_forbids_repair':
      return 'this Blueprint is stateful or cannot be classified, so auto-fix is declined to avoid touching data Sencho cannot prove is safe';
  }
}

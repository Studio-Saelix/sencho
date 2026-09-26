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
  /** The target is not in the frozen required set of the rollout it is bound to. */
  | 'not_a_required_target'
  /** A named rollout generation or artifact set could not be read. */
  | 'authority_unreadable'
  /** The rollout generation and the target's acknowledged pointers disagree. */
  | 'binding_incoherent';

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
  }
}

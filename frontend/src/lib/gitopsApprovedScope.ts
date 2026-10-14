/**
 * One reader for the rollout scope a confirmation may promise.
 *
 * A confirmation that can start a rollout has to name where it goes, and there
 * is exactly one place that scope comes from: the target set the placement
 * approval froze, read by the backend out of the same evidence the dispatch
 * boundary uses. The observed `targets` rows cannot stand in for it. A Blueprint
 * approved for a node no rollout has reached yet has no row there, and a node it
 * was withdrawn from keeps one, so the two sets disagree exactly when a
 * confirmation matters.
 *
 * The reader returns a status and never a sentence. Each surface words its own,
 * because the same status has to read correctly inside two different templates
 * and a phrase that survives one does not survive the other.
 */
import type { ApprovedRolloutScope, GitOpsRevisionProjection } from '@/types/gitops';

export type { ApprovedRolloutScope };

export type ApprovedScopeReading =
  /** An approval resolves and froze these nodes. */
  | { status: 'approved'; names: string[] }
  /** No placement approval exists. Nothing is approved for. */
  | { status: 'unapproved' }
  /**
   * No scope can be proven: an approval is recorded but unreadable, or the
   * projection carries no scope field at all, or this application has no
   * placement model. No dispatch can authorize against any of them either, so
   * this is never a rollout.
   */
  | { status: 'unverified' };

/**
 * The approved rollout scope of a projection, resolved to node names.
 *
 * A node this frontend does not know is named by id rather than dropped, so the
 * scope never reads shorter than what was approved because a roster read was
 * partial.
 */
export function readApprovedScope(
  projection: GitOpsRevisionProjection,
  nodes: readonly { id: number; name: string }[],
): ApprovedScopeReading {
  const scope = projection.approvedRolloutScope;
  if (!scope || scope.status === 'unresolved') return { status: 'unverified' };
  if (scope.status === 'not_applicable' || scope.status === 'unapproved') return { status: 'unapproved' };
  // A scope whose node list is not an array of ids is not a scope this build
  // can read. Checking here rather than trusting the discriminant means a
  // future backend variant degrades to "unverified", which says the destination
  // is unknown, rather than to "approved" naming no nodes, which would read as
  // an approved rollout that deploys nowhere.
  if (!Array.isArray(scope.nodeIds)) return { status: 'unverified' };
  return {
    status: 'approved',
    names: scope.nodeIds.map((nodeId) => nodes.find((node) => node.id === nodeId)?.name ?? `node ${nodeId}`),
  };
}

/** The sentence the Accept source confirmation opens its scope with. */
export function acceptScopeSentence(reading: ApprovedScopeReading): string {
  if (reading.status === 'unverified') {
    return 'The recorded placement approval cannot be read, so this acceptance does not start a rollout.';
  }
  if (reading.status === 'unapproved') {
    return 'Placement is not approved yet, so this acceptance does not start a rollout.';
  }
  if (reading.names.length === 0) return 'Placement is approved, but for no nodes.';
  return `Placement is approved for ${reading.names.join(', ')}.`;
}

/** The sentence the automatic Pull source confirmation opens its scope with. */
export function pullScopeSentence(reading: ApprovedScopeReading): string {
  if (reading.status === 'unverified') {
    return 'The recorded placement approval cannot be read, so this cannot start a rollout.';
  }
  if (reading.status === 'unapproved') {
    return 'Placement is not approved yet, so this cannot start a rollout.';
  }
  if (reading.names.length === 0) return 'The placement approves no nodes, so this cannot deploy anything.';
  return `The next commit goes to the approved nodes: ${reading.names.join(', ')}.`;
}

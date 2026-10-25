/**
 * Bounded automatic placement.
 *
 * A placement change is the set difference between the last approved target set
 * and the set the current candidate asks for. This module decides whether that
 * difference is small and safe enough to approve without an operator. Everything
 * it needs is passed in, so the decision itself is pure and total: it reads no
 * database, no filesystem, and no browser input, and it never throws. Anything it
 * cannot read is a refusal reason, not an exception, because a decision that can
 * throw would be able to fail a caller's write rather than its own judgement.
 *
 * The bound is fixed and deliberately small. One stateless addition, or one
 * stateless removal, and nothing else. No numeric knob widens it: a blast-radius
 * setting is a way for an operator to talk the product into moving workloads it
 * cannot prove are safe, which is the opposite of what this policy is for.
 *
 * Two boundaries are worth stating because they are easy to get backwards.
 *
 * The baseline is the last **approved** target set, never the previous candidate.
 * An intent revision clears the placement approval before a new candidate is
 * opened, so at decision time the only set still in hand is a superseded one that
 * nobody approved. Diffing against it would let a pending, unapproved candidate
 * absorb a later edit: a candidate asking for `{A,B}` sits awaiting review, a
 * selector change mints `{A,B,C}`, the difference reads as one addition, and the
 * approval authorizes B on the strength of a decision no operator made.
 *
 * Statelessness is derived from the compose content that would actually be
 * placed, not from the Blueprint's stored classification. Compose edits are
 * refused for a Git-managed Blueprint, so that column says what the editor last
 * wrote and a repository push that adds a stateful service never updates it.
 * Reading it would approve a stateful placement off a stale label.
 *
 * Two kinds of check are deliberately absent from the reason union, because
 * neither can be answered here and an unreachable reason is worse than a missing
 * one: it advertises a check that does not exist.
 *
 * Directory-name ownership, meaning whether a stack directory on some node
 * carries this Blueprint's marker, is a per-node filesystem question. There is no
 * database signal for it: Blueprint names are unique and deployments are keyed by
 * Blueprint, so the only thing that can answer it is the deploy path's own probe
 * against the node, which already refuses an ownership conflict by name.
 * Re-probing it here would add a remote call to every placement decision and buy
 * a refusal that is made later, with better evidence, against the real node.
 *
 * Content-binding contention, meaning a live Git source already bound to the same
 * deploy stack, is refused by the binding service on the convert and adopt paths
 * rather than here, and placement cannot create the contention it would report.
 */

/** A node leaving the approved set. */
export type PlacementEffect = {
  additions: number[];
  removals: number[];
};

export type PlacementPolicyReason =
  /** The policy says an operator decides. Nothing else was consulted. */
  | 'policy_is_operator'
  /** The candidate asks for exactly the set already approved. */
  | 'no_placement_change'
  | 'stateless_addition'
  | 'stateless_removal'
  | 'mixed_add_and_remove'
  | 'multiple_additions'
  | 'multiple_removals'
  /** The workload carries data, so it is never placed or withdrawn automatically. */
  | 'stateful_workload'
  /** The workload's nature could not be established, so it is treated as data. */
  | 'unknown_workload'
  /** A first placement across more than one node. */
  | 'first_multi_node_placement'
  /** Placement moved because a pin moved, which is an operator's choice of where to run. */
  | 'pin_driven_placement'
  /** A cordon on an affected node would be overridden. */
  | 'cordon_override'
  /**
   * The node being withdrawn is cordoned, so this change follows from that
   * cordon rather than from anything Sencho judged about the workload.
   *
   * A separate reason from `cordon_override` because the two ask opposite
   * questions of the operator. That one says Sencho would have placed work on a
   * node you told it to leave alone; this one says the withdrawal you are seeing
   * is a consequence of the cordon you set, and the decision to actually move it
   * is yours.
   */
  | 'cordon_driven_removal'
  /**
   * An affected node is not answering in the node registry, or was last seen
   * unreachable. A node the registry no longer has at all is the next reason,
   * not this one.
   */
  | 'stale_node'
  /**
   * An affected node has not reported at all, or is not a node the registry
   * holds. Nothing was observed about it, so nothing claims it is unreachable.
   */
  | 'unknown_connectivity'
  /** Evidence the decision needed could not be read at all. */
  | 'missing_evidence'
  /** Evidence the decision needed was present but unusable. */
  | 'malformed_evidence'
  /** The effect would leave the application with no target. */
  | 'destructive_effect'
  /** An operation is in flight for this application or an affected target. */
  | 'conflicting_operation';

/**
 * The same vocabulary at runtime, for the places that must store or constrain it
 * rather than merely name it: the column check on the recorded refusal, and the
 * transport validation on the wire.
 *
 * Kept beside the union rather than derived from it so each member keeps the
 * comment explaining what it means, and asserted against the union below so the
 * two cannot drift. A list that gains a member without the union, or loses one,
 * is a compile error rather than a value the storage layer would reject at
 * runtime for a decision the policy can legitimately make.
 */
export const PLACEMENT_POLICY_REASONS = [
  'policy_is_operator',
  'no_placement_change',
  'stateless_addition',
  'stateless_removal',
  'mixed_add_and_remove',
  'multiple_additions',
  'multiple_removals',
  'stateful_workload',
  'unknown_workload',
  'first_multi_node_placement',
  'pin_driven_placement',
  'cordon_override',
  'cordon_driven_removal',
  'stale_node',
  'unknown_connectivity',
  'missing_evidence',
  'malformed_evidence',
  'destructive_effect',
  'conflicting_operation',
] as const satisfies readonly PlacementPolicyReason[];

export type PlacementDecision =
  | { decision: 'no_action'; reason: 'no_placement_change'; effect: PlacementEffect }
  | {
      decision: 'auto_approve';
      reason: 'stateless_addition' | 'stateless_removal';
      effect: PlacementEffect;
    }
  | { decision: 'operator_review'; reason: PlacementPolicyReason; effect: PlacementEffect };

/** How the workload's statelessness was established. */
export type WorkloadStatelessness = 'stateless' | 'stateful' | 'unknown';

/** How an affected node last answered. */
export type AffectedNodeState = 'reachable' | 'unreachable' | 'unknown';

export type BoundedAutoInput = {
  policy: 'operator' | 'bounded_auto';
  /** The last approved target set. Empty when nothing has ever been approved. */
  approvedNodeIds: readonly number[];
  /** The set the current candidate asks for. */
  candidateNodeIds: readonly number[];
  /** Whether an approval has ever been recorded for this application. */
  hasPriorApproval: boolean;
  /** Derived from the compose content that would be placed. */
  statelessness: WorkloadStatelessness;
  /** Placement moved because a pin moved. */
  pinDriven: boolean;
  /** A cordon on an affected node would be overridden. */
  cordonOverride: boolean;
  /** The only node being withdrawn is cordoned, so the cordon caused this. */
  cordonDrivenRemoval: boolean;
  /** The worst state across affected nodes. */
  affectedNodeState: AffectedNodeState;
  /** An operation is in flight for the application or an affected target. */
  conflictingOperation: boolean;
  /** Set false when evidence the decision needs could not be read. */
  evidenceReadable: boolean;
  /** Set false when evidence was read but was unusable. */
  evidenceWellFormed: boolean;
};

function setDifference(from: readonly number[], to: readonly number[]): number[] {
  const inTo = new Set(to);
  return from.filter((id) => !inTo.has(id));
}

/**
 * Read the two node lists, treating anything that is not a list of node ids as
 * no list at all.
 *
 * The types say these are number arrays and TypeScript enforces it, but the
 * values arrive from a JSON column read at runtime, which the compiler never
 * sees. Normalizing here means a damaged column produces "no change" and the
 * caller's evidence check refuses on it, rather than a TypeError thrown from
 * inside a decision.
 */
function nodeIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
}

/**
 * The decision.
 *
 * Rule order matters and is deliberate. The policy gate and the in-flight check
 * come first, because neither can be overridden by anything later. Evidence
 * integrity comes next, because a decision made on evidence nobody could read is
 * not a decision. The shape of the change is checked before the safety signals,
 * so an operator is told "two additions" rather than the first safety signal that
 * happens to trip, and the destructive case is checked before the allow, so a
 * removal that empties the set can never be reported as an approved removal.
 */
export function decideBoundedAutoPlacement(input: BoundedAutoInput): PlacementDecision {
  const approved = nodeIdList(input?.approvedNodeIds);
  const candidate = nodeIdList(input?.candidateNodeIds);
  const additions = setDifference(candidate, approved).sort((a, b) => a - b);
  const removals = setDifference(approved, candidate).sort((a, b) => a - b);
  const effect: PlacementEffect = { additions, removals };

  const review = (reason: PlacementPolicyReason): PlacementDecision => ({
    decision: 'operator_review',
    reason,
    effect,
  });

  if (input?.policy !== 'bounded_auto') return review('policy_is_operator');

  // A decision taken while a fetch, apply, deploy, or recovery is in flight
  // would be a decision about a world that is still moving.
  if (input?.conflictingOperation) return review('conflicting_operation');

  if (input?.evidenceReadable === false) return review('missing_evidence');
  if (input?.evidenceWellFormed === false) return review('malformed_evidence');

  if (additions.length === 0 && removals.length === 0) {
    return { decision: 'no_action', reason: 'no_placement_change', effect };
  }

  // A first placement across more than one node is the widest thing this policy
  // could ever be asked to approve, so it never is. A first placement of exactly
  // one node is an ordinary single addition and falls through to the normal rule.
  if (!input?.hasPriorApproval && candidate.length > 1) {
    return review('first_multi_node_placement');
  }

  if (additions.length > 0 && removals.length > 0) return review('mixed_add_and_remove');
  if (additions.length > 1) return review('multiple_additions');
  if (removals.length > 1) return review('multiple_removals');

  // Unreadable or unparseable compose is treated as data, never as stateless.
  if (input?.statelessness === 'stateful' || input?.statelessness === undefined) return review('stateful_workload');
  if (input?.statelessness === 'unknown') return review('unknown_workload');

  if (input?.cordonOverride) return review('cordon_override');
  // A withdrawal whose only cause is a cordon is the operator's decision to make.
  // Without this, one cordon on a stateless workload silently stops the
  // workload, because a single stateless removal is otherwise inside what this
  // policy may approve. Reading the cordon for removals as well as additions is
  // what makes "do not put work here" and "take work away from here" different
  // statements.
  if (input?.cordonDrivenRemoval) return review('cordon_driven_removal');
  if (input?.pinDriven) return review('pin_driven_placement');
  if (input?.affectedNodeState === 'unreachable') return review('stale_node');
  if (input?.affectedNodeState === 'unknown') return review('unknown_connectivity');

  // The last check before allowing, because an empty target set is a withdrawal
  // of everything and reads as a successful single removal without it.
  if (candidate.length === 0) return review('destructive_effect');

  return additions.length === 1
    ? { decision: 'auto_approve', reason: 'stateless_addition', effect }
    : { decision: 'auto_approve', reason: 'stateless_removal', effect };
}

/**
 * What each authority policy is set to, and what it actually did.
 *
 * The three policies are configured independently and are read independently,
 * so this reports them as three entries rather than as one object with three
 * fields. A caller that cares about one domain can then take one entry instead
 * of having to know that the other two are also there.
 *
 * Every entry answers the same two questions, because an operator looking at a
 * card needs both and neither alone is useful:
 *
 * - what is configured now, which is the answer to "who is deciding this"; and
 * - what the running work was actually decided under, which is not always the
 *   same thing. A generation freezes the policy it executes, so a policy edited
 *   afterwards does not retroactively claim the work already in flight.
 *
 * `effectiveFrozen` is null whenever no readable frozen snapshot exists for the
 * work in question, which includes the case where a generation predates the
 * policy contract entirely. That is reported as absent rather than filled in
 * with the current configuration, because implying that today's policy ran
 * yesterday's rollout is the claim this whole model refuses to make.
 */
import { GitOpsStore } from './store';
import { decodePolicySnapshot, type PolicyDomain, type PolicySnapshot } from './policyComposition';
import type { GitOpsApplicationRow, PlacementPolicyReason } from './types';
import type { PlacementFacet, RolloutFacet, SourceFacet } from './types';

/** How the work in question was decided. */
export type AuthorityPolicyDecision =
  /** A configured policy decided it, and the frozen snapshot says so. */
  | 'policy_authorized'
  /** An operator decided it by hand. */
  | 'operator_authorized'
  /** Nobody has decided it; the configured policy is waiting on a person. */
  | 'awaiting_operator'
  /** The configured policy declined and said why. */
  | 'policy_declined'
  /** This domain does not apply to this application. */
  | 'not_applicable';

export type AuthorityPolicyRead = {
  domain: PolicyDomain;
  /** The configured value, verbatim from the policy contract. */
  configured: string;
  /**
   * The value the work in flight was actually decided under, or null when no
   * readable frozen snapshot exists. Never inferred from the current setting.
   */
  effectiveFrozen: string | null;
  decision: AuthorityPolicyDecision;
  /**
   * Why a decision is outstanding, from the closed decision vocabulary, or null
   * when nothing is outstanding. A domain with no outstanding decision does not
   * carry a reason, so a stale one cannot be read as the current explanation.
   */
  reason: PlacementPolicyReason | null;
  /** Who decided the work in question, when something was decided. */
  decidedBy: 'operator' | 'configured_policy' | null;
  /** When that decision was recorded, for freshness. */
  decidedAt: number | null;
};

/**
 * The snapshot a rollout generation froze, when it holds a readable one.
 *
 * The generation is the only place the snapshot survives for a rollout, so an
 * unreadable or absent one is reported as absent. A legacy generation carries
 * the version-zero snapshot, which decodes to the fresh-install defaults, and
 * that is reported as what it is rather than as the current configuration.
 */
function frozenSnapshotFor(app: GitOpsApplicationRow): PolicySnapshot | null {
  const store = GitOpsStore.getInstance();
  const generationId = app.rollout_generation_id;
  if (!generationId) return null;
  const generation = store.getRolloutGeneration(generationId);
  if (!generation || generation.application_id !== app.id) return null;
  // Absent is absent. A generation that predates the policy contract has no
  // snapshot recorded, and decoding that as the fresh-install defaults would
  // report a rollout as having been decided under a policy that did not exist
  // when it ran. The strict decoder also throws on an unrecognized version,
  // which is caught here for the same reason: a snapshot this build cannot read
  // is not one it may report a value from.
  if (generation.policy_snapshot_json === null) return null;
  try {
    return decodePolicySnapshot(generation.policy_snapshot_json);
  } catch {
    return null;
  }
}

/** The snapshot field for a domain. Mapped rather than indexed, because the
 * contract's field names and the domain names are deliberately not the same
 * vocabulary, and indexing one with the other would compile only until someone
 * renames a field. */
const FROZEN_FIELD: Record<PolicyDomain, keyof Omit<PolicySnapshot, 'version'>> = {
  source: 'source',
  placement: 'placement',
  rollout_authorization: 'rolloutAuthorization',
};

function frozenValue(snapshot: PolicySnapshot | null, domain: PolicyDomain): string | null {
  if (!snapshot) return null;
  return snapshot[FROZEN_FIELD[domain]];
}

/**
 * The read for one domain.
 *
 * `decision` is derived from what the application actually holds, never from
 * the configured value alone. A `bounded_auto` policy with an open review is
 * `policy_declined` with the reason attached, not `awaiting_operator`, because
 * the two mean different things to an operator: one is the system working and
 * declining, the other is the system not having tried.
 */
function readFor(
  app: GitOpsApplicationRow,
  domain: PolicyDomain,
  facets: {
    source: SourceFacet;
    placement: PlacementFacet;
    rollout: RolloutFacet;
  },
): AuthorityPolicyRead {
  const configured = app[domain === 'source' ? 'source_policy'
    : domain === 'placement' ? 'placement_policy'
      : 'rollout_authorization_policy'];
  const snapshot = frozenSnapshotFor(app);
  const effectiveFrozen = frozenValue(snapshot, domain);
  const base = { domain, configured, effectiveFrozen };

  // Placement is the only domain with a decision the system makes and then
  // declines, so it is the only one that can be `policy_declined`.
  if (domain === 'placement') {
    const approval = app.placement_approval_ref
      ? GitOpsStore.getInstance().getApproval(app.placement_approval_ref)
      : undefined;
    if (approval && approval.kind === 'placement_approval') {
      return {
        ...base,
        decision: approval.authority === 'configured_policy' ? 'policy_authorized' : 'operator_authorized',
        reason: null,
        decidedBy: approval.authority === 'configured_policy' ? 'configured_policy' : 'operator',
        decidedAt: approval.created_at,
      };
    }
    const reviewOpen = facets.placement.status === 'placement_review_pending'
      || facets.placement.status === 'stateful_confirmation_required';
    if (reviewOpen) {
      const reason = app.placement_policy_refusal_reason;
      // A recorded reason means the policy ran and declined. No reason on an
      // open review means it has not run yet, or ran under a policy that has
      // since changed, and claiming either would be a claim nobody made.
      return {
        ...base,
        decision: reason ? 'policy_declined' : 'awaiting_operator',
        reason,
        decidedBy: null,
        decidedAt: reason ? app.placement_policy_refused_at : null,
      };
    }
    return { ...base, decision: 'awaiting_operator', reason: null, decidedBy: null, decidedAt: null };
  }

  if (domain === 'rollout_authorization') {
    const ref = app.rollout_authorization_ref;
    const approval = ref ? GitOpsStore.getInstance().getApproval(ref) : undefined;
    if (approval && approval.kind === 'rollout_authorization') {
      return {
        ...base,
        decision: approval.authority === 'configured_policy' ? 'policy_authorized' : 'operator_authorized',
        reason: null,
        decidedBy: approval.authority === 'configured_policy' ? 'configured_policy' : 'operator',
        decidedAt: approval.created_at,
      };
    }
    return { ...base, decision: 'awaiting_operator', reason: null, decidedBy: null, decidedAt: null };
  }

  // Source acceptance is the authority the source domain acts through. There is
  // no source decision the system declines on its own, so the only two answers
  // are that something decided it or that nobody has.
  //
  // The authority is read from the approval rather than assumed, because the
  // automatic path records the same row with the policy as the decider. Reporting
  // every acceptance as an operator's would have told an operator on the
  // automatic policy that they had personally accepted a revision nobody showed
  // them.
  const acceptance = app.source_acceptance_ref
    ? GitOpsStore.getInstance().getApproval(app.source_acceptance_ref)
    : undefined;
  if (acceptance && acceptance.kind === 'source_acceptance') {
    const byPolicy = acceptance.authority === 'configured_policy';
    return {
      ...base,
      decision: byPolicy ? 'policy_authorized' : 'operator_authorized',
      reason: null,
      decidedBy: byPolicy ? 'configured_policy' : 'operator',
      decidedAt: acceptance.created_at,
    };
  }
  return { ...base, decision: 'awaiting_operator', reason: null, decidedBy: null, decidedAt: null };
}

/**
 * The three reads for one application, in the order the stages are read.
 *
 * Not applicable is decided by the facets rather than by the target mode alone,
 * so a Direct application reports its source policy and marks the other two
 * rather than claiming a placement or rollout domain it does not have.
 */
export function authorityPolicyReads(
  app: GitOpsApplicationRow,
  facets: { source: SourceFacet; placement: PlacementFacet; rollout: RolloutFacet },
): AuthorityPolicyRead[] {
  return (['source', 'placement', 'rollout_authorization'] as const).map((domain) => readFor(app, domain, facets));
}

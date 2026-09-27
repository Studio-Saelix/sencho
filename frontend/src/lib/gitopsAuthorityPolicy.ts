/**
 * One vocabulary for the three authority policies.
 *
 * The three domains are configured independently and are read independently, but
 * they are the same question asked at three stages: who is allowed to decide
 * this. So they share one label map, one phrasing per decision, and one control.
 * Three vocabularies in three places would read as three features rather than
 * one policy model, and an operator moving between the source, placement and
 * rollout cards would have to learn three sets of words for the same idea.
 *
 * The reason strings are the load-bearing part. A refusal recorded by a policy
 * is only useful if it says what the policy saw and what the operator can do
 * about it. A reason that names an internal condition without saying which is
 * the same as no reason, and the whole point of recording one is that an
 * automatic path that declines must be distinguishable from one that never ran.
 */
import type { AuthorityPolicyDecision, AuthorityPolicyDomain, AuthorityPolicyRead } from '@/types/gitops';

/** The stage each domain governs, in the order the cards are read. */
export const AUTHORITY_POLICY_DOMAINS: readonly AuthorityPolicyDomain[] = [
  'source',
  'placement',
  'rollout_authorization',
] as const;

export const POLICY_DOMAIN_LABEL: Record<AuthorityPolicyDomain, string> = {
  source: 'Source',
  placement: 'Placement',
  rollout_authorization: 'Rollout',
};

/** What each domain's decision is about, for the control's accessible name. */
export const POLICY_DOMAIN_SUBJECT: Record<AuthorityPolicyDomain, string> = {
  source: 'which source revisions apply without an operator',
  placement: 'which placement changes approve without an operator',
  rollout_authorization: 'which rollouts authorize without an operator',
};

/**
 * What each configured value means, per domain.
 *
 * The values are named for the actor, not for the mechanism. "Bounded automatic"
 * tells an operator nothing about what is bounded; "one stateless change at a
 * time" tells them the whole rule.
 */
const VALUE_LABEL: Record<AuthorityPolicyDomain, Record<string, string>> = {
  source: {
    manual: 'Operator applies each revision',
    review: 'Operator reviews each revision',
    automatic: 'Applies without an operator',
  },
  placement: {
    operator: 'Operator approves each change',
    bounded_auto: 'One stateless change at a time',
  },
  rollout_authorization: {
    manual: 'Operator authorizes each rollout',
    automatic: 'Authorizes without an operator',
  },
};

/** The short form, for a control that has room for the value and nothing else. */
const VALUE_LABEL_SHORT: Record<AuthorityPolicyDomain, Record<string, string>> = {
  source: {
    manual: 'Manual',
    review: 'Review',
    automatic: 'Automatic',
  },
  placement: {
    operator: 'Operator',
    bounded_auto: 'Bounded auto',
  },
  rollout_authorization: {
    manual: 'Manual',
    automatic: 'Automatic',
  },
};

export function policyValueLabel(domain: AuthorityPolicyDomain, value: string): string {
  return VALUE_LABEL[domain][value] ?? value;
}

export function policyValueShortLabel(domain: AuthorityPolicyDomain, value: string): string {
  return VALUE_LABEL_SHORT[domain][value] ?? value;
}

/**
 * What the policy was recorded as having done, in one clause.
 *
 * The distinction that matters is between a policy that declined and one that
 * has not run, because they call for different things from the operator: the
 * first needs a decision about this change, the second needs the policy to fire
 * at all.
 */
export function policyDecisionLabel(read: AuthorityPolicyRead): string {
  switch (read.decision) {
    case 'policy_authorized':
      return 'approved by policy';
    case 'operator_authorized':
      return 'approved by an operator';
    case 'policy_declined':
      return 'declined by policy, waiting on an operator';
    case 'awaiting_operator':
      return 'waiting on an operator';
    case 'not_applicable':
      return 'not applicable here';
    default:
      return read.decision;
  }
}

/**
 * Why a bounded-automatic placement declined, and what the operator can do.
 *
 * Every one of these is a case where the policy did its job and a person has to
 * take over, which is the only circumstance in which the recorded reason is
 * read at all. Each says what was seen, not which internal check fired, because
 * the operator's next move depends on the former and not the latter.
 */
const PLACEMENT_REASON_TEXT: Record<string, string> = {
  policy_is_operator: 'The placement policy asks for an operator.',
  no_placement_change: 'The plan asks for the nodes that are already placed.',
  mixed_add_and_remove: 'The plan both places and withdraws nodes at once.',
  multiple_additions: 'The plan places more than one node.',
  multiple_removals: 'The plan withdraws more than one node.',
  stateful_workload: 'The workload carries data, so it is never moved automatically.',
  unknown_workload: 'What the workload holds could not be established, so it is treated as data.',
  first_multi_node_placement: 'This is the first placement, and it spans more than one node.',
  pin_driven_placement: 'Placement moved because a pin moved, which is a choice of where to run.',
  cordon_override: 'A node in the plan is cordoned, so moving work onto it would override that.',
  stale_node: 'A node in the plan is gone, or was last seen unreachable.',
  unknown_connectivity: 'A node in the plan answered but could not be read.',
  missing_evidence: 'The evidence this decision needed could not be read at all.',
  malformed_evidence: 'The evidence this decision needed was present but unusable.',
  destructive_effect: 'The change would leave the application with no node running it.',
  conflicting_operation: 'An operation is already in flight for this application or one of its nodes.',
  stateless_addition: 'One stateless node was added.',
  stateless_removal: 'One stateless node was withdrawn.',
};

export function placementReasonText(reason: string): string {
  return PLACEMENT_REASON_TEXT[reason] ?? reason;
}

/**
 * The line a facet card shows for its policy.
 *
 * Returns null when there is nothing worth saying, so a card never grows a line
 * that repeats its own state. The two cases that produce nothing are a policy
 * with no decision and no reason, and a domain that does not apply.
 */
export function policyReadLine(read: AuthorityPolicyRead | null): string | null {
  if (!read) return null;
  if (read.decision === 'not_applicable') return null;
  const reason = read.reason ? ` ${placementReasonText(read.reason)}` : '';
  if (!reason) return null;
  return policyDecisionLabel(read) + '.';
}

/** The read for one domain, or null when the build has never heard of it. */
export function policyReadFor(
  policies: readonly AuthorityPolicyRead[] | undefined,
  domain: AuthorityPolicyDomain,
): AuthorityPolicyRead | null {
  if (!policies) return null;
  return policies.find((entry) => entry.domain === domain) ?? null;
}

export type { AuthorityPolicyDecision, AuthorityPolicyDomain, AuthorityPolicyRead };

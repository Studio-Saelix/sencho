/**
 * The policy line a facet card carries, and the one that it must not carry.
 *
 * The card this lives in already states the facet's status, so the line earns
 * its place only by saying something the card does not: who is configured to
 * decide this stage, and what that policy actually did. The cases below are
 * mostly about the second, because a line that repeats the card's own state is
 * noise and a line that claims the current policy decided older work is a lie.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { GitOpsFacetCards } from './GitOpsFacetCards';
import { plainSource } from '@/__tests__/gitopsFixtures';
import type { AuthorityPolicyRead, PlacementFacet } from '@/types/gitops';

const SOURCE = plainSource('application_generation_accepted');
const PLACEMENT_PENDING: PlacementFacet = { status: 'placement_review_pending' };
const ROLLOUT = { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' } as const;

function read(overrides: Partial<AuthorityPolicyRead> = {}): AuthorityPolicyRead {
  return {
    domain: 'placement',
    configured: 'bounded_auto',
    effectiveFrozen: null,
    decision: 'awaiting_operator',
    reason: null,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

function renderCards(policies?: readonly AuthorityPolicyRead[], placement: PlacementFacet = PLACEMENT_PENDING) {
  return render(
    <GitOpsFacetCards
      source={SOURCE}
      artifact={null}
      placement={placement}
      rollout={ROLLOUT}
      authorityPolicies={policies}
    />,
  );
}

describe('the policy line on a facet card', () => {
  it('says nothing when the policy has no decision and no reason', () => {
    // The common case. A line here would restate the card's own state, and every
    // settled application would carry it for no information.
    renderCards([read()]);
    expect(screen.queryByTestId('gitops-policy-line')).toBeNull();
  });

  it('names the refusal and says the policy declined rather than never ran', () => {
    // The distinction an operator needs: a policy that ran and declined needs a
    // decision about this change, and a policy that never fired needs a fix. The
    // two look identical without the reason.
    renderCards([read({ decision: 'policy_declined', reason: 'stateful_workload' })]);
    const line = screen.getByTestId('gitops-policy-line');
    expect(line).toHaveTextContent('One stateless change at a time');
    expect(line).toHaveTextContent('declined by policy');
    expect(line).toHaveTextContent('carries data');
  });

  it('shows nothing for the operator policy, which never declines anything', () => {
    // The state the backend actually produces for the operator policy: a review
    // waiting on a person, with no recorded reason, because that policy has no
    // decision to decline with. A fixture carrying a `policy_is_operator`
    // reason described a state the backend stopped producing, which is how a
    // wrong claim can sit in a test and still pass.
    renderCards([read({ configured: 'operator', decision: 'awaiting_operator', reason: null })]);
    expect(screen.queryByTestId('gitops-policy-line')).toBeNull();
  });

  it('names the operator policy when something else is outstanding', () => {
    // The operator policy can still be configured while a decision is recorded
    // from the stage before it, so the line has to name the policy.
    renderCards([read({ configured: 'operator', decision: 'operator_authorized', reason: null, decidedBy: 'operator' })]);
    expect(screen.getByTestId('gitops-policy-line')).toHaveTextContent('Operator approves each change');
  });

  it('reports the value the work in flight was decided under, when it differs', () => {
    // A policy edited after a generation opened does not retroactively claim it.
    // Showing only the configured value would read as though it had.
    renderCards([read({ configured: 'operator', effectiveFrozen: 'bounded_auto', decision: 'operator_authorized', decidedBy: 'operator' })]);
    expect(screen.getByTestId('gitops-policy-frozen')).toHaveTextContent('In flight under one stateless change at a time');
  });

  it('says nothing about a frozen value that matches the configuration', () => {
    // Reporting agreement on every application would be noise on the majority.
    renderCards([read({ effectiveFrozen: 'bounded_auto', decision: 'policy_authorized', decidedBy: 'configured_policy' })]);
    expect(screen.queryByTestId('gitops-policy-frozen')).toBeNull();
  });

  it('shows a reason it has no wording for, rather than hiding it', () => {
    // A vocabulary this build predates must reach the operator as a name, not as
    // silence. Silence would read as "no reason recorded".
    renderCards([read({ decision: 'policy_declined', reason: 'a_reason_from_a_newer_build' })]);
    expect(screen.getByTestId('gitops-policy-line')).toHaveTextContent('a_reason_from_a_newer_build');
  });

  it('renders the cards unchanged when the build carries no reads', () => {
    renderCards(undefined);
    expect(screen.getByTestId('gitops-placement')).toBeInTheDocument();
    expect(screen.queryByTestId('gitops-policy-line')).toBeNull();
  });

  it('puts no policy on the artifact card, which governs no decision', () => {
    // The artifact facet reports what was built, not who may act. A policy there
    // would attribute a decision to a stage that makes none.
    render(
      <GitOpsFacetCards
        source={SOURCE}
        artifact={{ status: 'not_applicable' } as never}
        placement={PLACEMENT_PENDING}
        rollout={ROLLOUT}
        authorityPolicies={[read({ decision: 'policy_declined', reason: 'cordon_override' })]}
      />,
    );
    const artifact = screen.getByTestId('gitops-artifact');
    expect(artifact.querySelector('[data-testid="gitops-policy-line"]')).toBeNull();
  });
});

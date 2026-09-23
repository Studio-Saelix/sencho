import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { noApprovals } from '@/__tests__/gitopsFixtures';
import GitOpsApprovalChips from './GitOpsApprovalChips';
import type { PlacementFacet } from '@/types/gitops';

const REFS = {
  source: 'src-acceptance-0123456789',
  placement: 'plc-approval-0123456789',
  rollout: 'rlo-authorization-0123456789',
  legacy: 'lcy-combined-0123456789',
};

const BINDING = {
  rolloutCandidateId: 'rc-1',
  acceptedGenerationId: 'gen-1',
  artifactSetId: 'art-1',
  intentRevisionId: 'int-1',
  requiredNodeIds: [1],
  sourceAcceptanceRef: REFS.source,
  placementApprovalRef: REFS.placement,
  preflightFingerprint: 'fp-1',
};

const stalePlacement: PlacementFacet = {
  status: 'rollout_authorization_stale',
  rolloutAuthorizationRef: REFS.rollout,
  bound: BINDING,
};

describe('GitOpsApprovalChips', () => {
  it('renders nothing when no authority has been recorded', () => {
    render(<GitOpsApprovalChips approvals={noApprovals} />);
    expect(screen.queryByTestId('gitops-approvals')).toBeNull();
  });

  it('renders nothing on the absent arm, where there are no approvals at all', () => {
    render(<GitOpsApprovalChips approvals={null} />);
    expect(screen.queryByTestId('gitops-approvals')).toBeNull();
  });

  it('reads a recorded ref as a granted step', () => {
    render(<GitOpsApprovalChips approvals={{ ...noApprovals, sourceAcceptanceRef: REFS.source }} />);
    const chip = screen.getByText('source accepted').closest('[data-approval]');
    expect(chip).toHaveAttribute('data-approval', 'source');
    expect(chip).toHaveAttribute('data-state', 'granted');
  });

  it('reads an outstanding step from the facet, never from the missing ref alone', () => {
    const placement: PlacementFacet = { status: 'placement_review_pending' };
    render(<GitOpsApprovalChips
      approvals={{ ...noApprovals, sourceAcceptanceRef: REFS.source }}
      placement={placement}
    />);
    const chip = screen.getByText('placement approval pending').closest('[data-approval]');
    expect(chip).toHaveAttribute('data-state', 'pending');
  });

  it('marks steps that do not apply instead of calling them pending', () => {
    const placement: PlacementFacet = { status: 'unbound_direct' };
    render(<GitOpsApprovalChips
      approvals={{ ...noApprovals, sourceAcceptanceRef: REFS.source }}
      placement={placement}
      rollout={{ status: 'not_applicable' }}
    />);
    expect(screen.getByText('placement n/a').closest('[data-approval]')).toHaveAttribute('data-state', 'not_required');
    expect(screen.getByText('rollout n/a').closest('[data-approval]')).toHaveAttribute('data-state', 'not_required');
  });

  it('reads a stale rollout authorization as pending even though its ref is still stored', () => {
    // The ref proves a grant happened; the facet proves it no longer covers the
    // current inputs. Granted would be the lie here.
    render(<GitOpsApprovalChips
      approvals={{ ...noApprovals, rolloutAuthorizationRef: REFS.rollout }}
      placement={stalePlacement}
    />);
    const chip = screen.getByText('rollout authorization pending').closest('[data-approval]');
    expect(chip).toHaveAttribute('data-state', 'pending');
  });

  it.each<{
    name: string;
    placement: PlacementFacet;
    label: string;
    approval: 'source' | 'placement' | 'rollout';
  }>([
    {
      name: 'source acceptance outstanding',
      placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-1' },
      label: 'source acceptance pending',
      approval: 'source',
    },
    {
      name: 'placement needs a stateful confirmation',
      placement: { status: 'stateful_confirmation_required' },
      label: 'placement approval pending',
      approval: 'placement',
    },
    {
      name: 'rollout authorization never recorded',
      placement: { status: 'rollout_authorization_pending', rolloutAuthorizationRef: null, binding: BINDING },
      label: 'rollout authorization pending',
      approval: 'rollout',
    },
    {
      name: 'preflight still blocking the rollout',
      placement: { status: 'preflight_blocked', reason: 'Image scan is still running.', binding: BINDING },
      label: 'rollout authorization pending',
      approval: 'rollout',
    },
  ])('reads $name as a pending chip', ({ placement, label, approval }) => {
    render(<GitOpsApprovalChips
      approvals={{ ...noApprovals, legacyCombinedApprovalRef: REFS.legacy }}
      placement={placement}
    />);
    const chip = screen.getByText(label).closest('[data-approval]');
    expect(chip).toHaveAttribute('data-approval', approval);
    expect(chip).toHaveAttribute('data-state', 'pending');
  });

  it('keeps a legacy combined approval additional to the decomposed steps', () => {
    render(<GitOpsApprovalChips approvals={{
      ...noApprovals,
      sourceAcceptanceRef: REFS.source,
      legacyCombinedApprovalRef: REFS.legacy,
    }} />);
    expect(screen.getByText('source accepted')).toBeInTheDocument();
    const legacy = screen.getByText('legacy combined approval').closest('[data-approval]');
    expect(legacy).toHaveAttribute('data-approval', 'legacy');
    expect(legacy).toHaveAttribute('data-state', 'granted');
  });

  it('never shows a ref in the visible text', () => {
    render(<GitOpsApprovalChips approvals={{
      sourceAcceptanceRef: REFS.source,
      placementApprovalRef: REFS.placement,
      rolloutAuthorizationRef: REFS.rollout,
      legacyCombinedApprovalRef: REFS.legacy,
    }} />);
    for (const ref of Object.values(REFS)) {
      expect(screen.queryByText(new RegExp(ref.slice(0, 8)))).toBeNull();
    }
  });
});

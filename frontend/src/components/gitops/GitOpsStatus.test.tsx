import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import {
  absentRevision,
  facets,
  liveArtifact,
  liveRevision,
  missingApplicationLimitation,
  noApprovals,
  plainSource,
  portfolioRow,
  target,
} from '@/__tests__/gitopsFixtures';
import { GitOpsStatus } from './GitOpsStatus';
import type { AuthorityPolicyRead } from '@/types/gitops';

describe('GitOpsStatus', () => {
  it('renders nothing for a stack outside GitOps', () => {
    const { container } = render(<GitOpsStatus revision={absentRevision()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the unreachable application as one fault, with no path or evidence', () => {
    render(<GitOpsStatus revision={absentRevision([missingApplicationLimitation])} />);
    expect(screen.getByTestId('gitops-fault')).toHaveTextContent(missingApplicationLimitation.message);
    expect(screen.queryByTestId('status-path')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Evidence' })).toBeNull();
  });

  it('says a blocking second stage once, and keeps a settled stage quiet', () => {
    render(<GitOpsStatus revision={liveRevision({
      facets: facets({
        source: plainSource('source_review_pending'),
        artifact: liveArtifact({ status: 'artifact_stale' }),
      }),
    })} />);
    // Answer speaks for the source; the artifact is the one blocker left to name.
    expect(screen.getByTestId('gitops-answer')).toHaveAttribute('data-state', 'source_review_pending');
    expect(screen.getByTestId('status-stage-line-artifact')).toBeInTheDocument();
    expect(screen.queryByTestId('status-stage-line-source')).toBeNull();
  });

  it('shows at most one toned block however many stages are unsettled', () => {
    render(<GitOpsStatus revision={liveRevision({
      facets: facets({
        source: plainSource('source_review_pending'),
        artifact: liveArtifact({ status: 'artifact_stale' }),
        placement: { status: 'placement_review_pending' },
      }),
      targets: [target({ runtime: { status: 'drifted' } })],
    })} />);
    expect(document.querySelectorAll('[data-testid="gitops-answer"]')).toHaveLength(1);
    expect(screen.queryByTestId('gitops-target')).toBeNull();
  });

  it('puts the resolving verb in the answer', () => {
    render(<GitOpsStatus
      revision={liveRevision({ facets: facets({ source: plainSource('candidate_ready') }) })}
      action={<button type="button">Review</button>}
      focus="source"
    />);
    expect(within(screen.getByTestId('gitops-answer')).getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });

  it('uses the portfolio posture as the answer when the row is given', () => {
    render(<GitOpsStatus revision={liveRevision()} row={portfolioRow({ posture: 'attention', attention: ['rollout_paused'] })} />);
    const posture = screen.getByTestId('gitops-posture');
    expect(posture).toHaveAttribute('data-state', 'attention');
    expect(posture).toHaveTextContent('needs attention');
  });

  it('keeps targets, recorded authority, and caveats in the evidence, closed by default', () => {
    render(<GitOpsStatus
      revision={liveRevision({
        approvals: { ...noApprovals, sourceAcceptanceRef: 'src-accept-0123' },
        limitations: [{ code: 'repo_identity_invalid', message: 'Repository identity could not be read.', evidence: null }],
        targets: [target({ nodeId: 1 })],
      })}
      nodeName={() => 'edge-01'}
    />);
    expect(screen.queryByTestId('gitops-target')).toBeNull();
    expect(screen.queryByTestId('gitops-approvals')).toBeNull();
    // The caveat is not hidden: the answer carries a marker for it.
    expect(screen.getByTestId('status-marker')).toHaveTextContent('unproven');

    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(screen.getByTestId('gitops-target')).toHaveTextContent('edge-01');
    expect(screen.getByTestId('gitops-approvals')).toHaveTextContent('Source accepted');
    expect(screen.getByTestId('gitops-caveats')).toBeInTheDocument();
  });

  it('never prints an approval ref, only its tooltip', () => {
    render(<GitOpsStatus revision={liveRevision({ approvals: { ...noApprovals, sourceAcceptanceRef: 'src-accept-0123' } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(screen.queryByText(/src-acce/)).toBeNull();
    expect(screen.getByText('recorded')).toHaveAttribute('title', expect.stringContaining('src-acce'));
  });

  it('lists targets in the evidence only when the surface does not list them itself', () => {
    render(<GitOpsStatus revision={liveRevision({ targets: [target({ nodeId: 1 })] })} includeTargets={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(screen.queryByTestId('gitops-target')).toBeNull();
    expect(screen.queryByText(/^Targets/)).toBeNull();
  });

  it('labels the section only when there is a status to label', () => {
    const { rerender } = render(<GitOpsStatus heading="gitops" revision={absentRevision()} />);
    expect(screen.queryByText('gitops')).toBeNull();
    rerender(<GitOpsStatus heading="gitops" revision={liveRevision()} />);
    expect(screen.getByText('gitops')).toBeInTheDocument();
  });

  it('lists every attention reason, not only the first', () => {
    render(<GitOpsStatus
      revision={liveRevision()}
      row={portfolioRow({ posture: 'attention', attention: ['rollout_paused', 'drift', 'target_stale'] })}
    />);
    expect(screen.getByTestId('gitops-posture')).toHaveTextContent('2 more needing attention');
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    const others = screen.getByTestId('gitops-other-reasons');
    expect(others).toHaveTextContent('drifted');
    expect(others).toHaveTextContent('What is running no longer matches the intended state.');
    expect(others).toHaveTextContent('stale target');
  });

  it('keeps a recorded policy decline reachable even when nothing else needs the evidence', () => {
    const declined: AuthorityPolicyRead = {
      domain: 'placement',
      configured: 'bounded_auto',
      effectiveFrozen: null,
      decision: 'policy_declined',
      reason: 'stateful_workload',
      decidedBy: null,
      decidedAt: null,
    };
    render(<GitOpsStatus
      revision={liveRevision({ facets: facets({ source: plainSource('application_generation_accepted', { candidateGenerationId: null }) }), targets: [], authorityPolicies: [declined] })}
      includeTargets={false}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(screen.getByTestId('gitops-policy-line')).toHaveTextContent('carries data');
  });

  it('offers no evidence control when a policy has recorded nothing and nothing else is behind the answer', () => {
    const waiting: AuthorityPolicyRead = {
      domain: 'placement',
      configured: 'bounded_auto',
      effectiveFrozen: null,
      decision: 'awaiting_operator',
      reason: null,
      decidedBy: null,
      decidedAt: null,
    };
    render(<GitOpsStatus
      revision={liveRevision({
        facets: facets({ source: plainSource('source_review_pending') }),
        targets: [],
        authorityPolicies: [waiting],
      })}
      includeTargets={false}
    />);
    expect(screen.queryByRole('button', { name: 'Evidence' })).toBeNull();
  });

  it('does not list a stale rollout authorization as granted though its ref is stored', () => {
    render(<GitOpsStatus revision={liveRevision({
      approvals: { ...noApprovals, rolloutAuthorizationRef: 'rlo-0123456789' },
      facets: facets({
        source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
        placement: {
          status: 'rollout_authorization_stale',
          rolloutAuthorizationRef: 'rlo-0123456789',
          bound: {
            rolloutCandidateId: 'rc-1', acceptedGenerationId: 'gen-1', artifactSetId: 'art-1', intentRevisionId: 'int-1',
            requiredNodeIds: [1], sourceAcceptanceRef: 's', placementApprovalRef: 'p', preflightFingerprint: 'fp',
          },
        },
      }),
    })} />);
    expect(screen.getByTestId('gitops-placement')).toHaveAttribute('data-state', 'rollout_authorization_stale');
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }));
    expect(screen.queryByText('Rollout authorized')).toBeNull();
    expect(document.querySelector('[data-approval="rollout"]')).toBeNull();
  });
});


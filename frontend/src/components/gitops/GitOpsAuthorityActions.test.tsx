/**
 * The decomposed authority action row: which action each facet state offers,
 * who may see it, and what a write reports back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { facets, liveRevision, noApprovals, plainSource } from '@/__tests__/gitopsFixtures';
import type { FutureRolloutAuthorizationBinding, GitOpsRevisionLive } from '@/types/gitops';
import type { PermissionAction } from '@/context/AuthContext';

vi.mock('@/lib/gitopsAuthorityApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitopsAuthorityApi')>();
  return { ...actual, acceptGitOpsSource: vi.fn(), authorizeGitOpsRollout: vi.fn() };
});

vi.mock('@/components/blueprints/RolloutPreviewDialog', () => ({
  RolloutPreviewDialog: ({ open }: { open: boolean }) => (
    open ? <div data-testid="placement-dialog" /> : null
  ),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { acceptGitOpsSource, authorizeGitOpsRollout } from '@/lib/gitopsAuthorityApi';
import { toast } from '@/components/ui/toast-store';
import GitOpsAuthorityActions from './GitOpsAuthorityActions';

const binding: FutureRolloutAuthorizationBinding = {
  rolloutCandidateId: 'cand-1',
  acceptedGenerationId: 'gen-1',
  artifactSetId: 'art-1',
  intentRevisionId: 'intent-1',
  requiredNodeIds: [1],
  sourceAcceptanceRef: 'src-1',
  placementApprovalRef: 'place-1',
  preflightFingerprint: 'f'.repeat(64),
};

function blueprintRevision(overrides: Partial<GitOpsRevisionLive> = {}): GitOpsRevisionLive {
  return liveRevision({
    targetMode: 'blueprint',
    applicationId: 'app-1',
    stackName: null,
    blueprintId: 5,
    approvals: noApprovals,
    facets: facets({
      source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
      placement: { status: 'placement_review_pending' },
      rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
    }),
    ...overrides,
  });
}

function sourcePending(): GitOpsRevisionLive {
  return blueprintRevision({
    facets: facets({
      source: plainSource('source_review_pending'),
      placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
      rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
    }),
  });
}

function placementPending(): GitOpsRevisionLive {
  return blueprintRevision({
    approvals: { ...noApprovals, sourceAcceptanceRef: 'src-1' },
  });
}

function rolloutPending(): GitOpsRevisionLive {
  return blueprintRevision({
    approvals: { ...noApprovals, sourceAcceptanceRef: 'src-1', placementApprovalRef: 'place-1' },
    facets: facets({
      source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
      placement: { status: 'rollout_authorization_pending', rolloutAuthorizationRef: null, binding },
      rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
    }),
  });
}

function renderActions(
  projection: GitOpsRevisionLive,
  can: (action: PermissionAction) => boolean = () => true,
  onChanged: () => void = () => {},
  blueprintEnabled = true,
) {
  return render(
    <GitOpsAuthorityActions
      applicationId="bp:5"
      blueprintId={5}
      blueprintName="web"
      projection={projection}
      onChanged={onChanged}
      can={can}
      blueprintEnabled={blueprintEnabled}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitOpsAuthorityActions', () => {
  it('accepts the reviewed source generation as the next step', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(acceptGitOpsSource).mockResolvedValue(undefined);
    renderActions(sourcePending(), () => true, onChanged);

    const button = screen.getByTestId('gitops-action-accept-source');
    await user.click(button);
    await waitFor(() => expect(acceptGitOpsSource).toHaveBeenCalledWith('bp:5', 'gen-candidate'));
    expect(toast.success).toHaveBeenCalledWith('Source revision accepted');
    expect(onChanged).toHaveBeenCalled();
  });

  it('reports a refused source acceptance without refreshing', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(acceptGitOpsSource).mockRejectedValue(new Error('candidate is blocked'));
    renderActions(sourcePending(), () => true, onChanged);

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('candidate is blocked'));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('opens the reviewed plan for placement approval', async () => {
    const user = userEvent.setup();
    renderActions(placementPending());
    await user.click(screen.getByTestId('gitops-action-approve-placement'));
    expect(await screen.findByTestId('placement-dialog')).toBeInTheDocument();
  });

  it('authorizes the rollout and reports a started dispatch', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(authorizeGitOpsRollout).mockResolvedValue({ dispatched: true, note: null });
    renderActions(rolloutPending(), () => true, onChanged);

    await user.click(screen.getByTestId('gitops-action-authorize-rollout'));
    await waitFor(() => expect(authorizeGitOpsRollout).toHaveBeenCalledWith('bp:5'));
    expect(toast.success).toHaveBeenCalledWith('Rollout authorized and started');
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps a granted authorization visible as a warning when the rollout did not start', async () => {
    const user = userEvent.setup();
    vi.mocked(authorizeGitOpsRollout).mockResolvedValue({
      dispatched: false,
      note: 'Deploy to node 2 is already in progress.',
    });
    renderActions(rolloutPending());

    await user.click(screen.getByTestId('gitops-action-authorize-rollout'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Deploy to node 2 is already in progress.'));
  });

  it('offers no placement approval without stack:create and stack:deploy', () => {
    renderActions(placementPending(), () => false);
    expect(screen.queryByTestId('gitops-authority-actions')).toBeNull();
  });

  it('offers no rollout authorization without stack:deploy', () => {
    renderActions(rolloutPending(), action => action !== 'stack:deploy');
    expect(screen.queryByTestId('gitops-authority-actions')).toBeNull();
  });

  it('offers no source acceptance without stack:create', () => {
    renderActions(sourcePending(), action => action !== 'stack:create');
    expect(screen.queryByTestId('gitops-authority-actions')).toBeNull();
  });

  it('offers source acceptance for a newer candidate after an earlier acceptance', async () => {
    const user = userEvent.setup();
    vi.mocked(acceptGitOpsSource).mockResolvedValue(undefined);
    renderActions(blueprintRevision({
      approvals: { ...noApprovals, sourceAcceptanceRef: 'src-old', placementApprovalRef: 'place-old' },
      facets: facets({
        source: plainSource('candidate_ready', { candidateGenerationId: 'gen-new' }),
        placement: { status: 'blueprint_bound', completion: 'unknown' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    }));

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    await waitFor(() => expect(acceptGitOpsSource).toHaveBeenCalledWith('bp:5', 'gen-new'));
  });

  it('withholds placement and rollout while the Blueprint is disabled', () => {
    const { unmount } = renderActions(placementPending(), () => true, () => {}, false);
    expect(screen.getByTestId('gitops-authority-actions')).toHaveTextContent('Blueprint disabled');
    expect(screen.getByTestId('gitops-action-approve-placement')).toBeDisabled();
    unmount();

    renderActions(rolloutPending(), () => true, () => {}, false);
    expect(screen.getByTestId('gitops-action-authorize-rollout')).toBeDisabled();
  });

  it('keeps source acceptance available while the Blueprint is disabled', () => {
    renderActions(sourcePending(), () => true, () => {}, false);
    expect(screen.getByTestId('gitops-action-accept-source')).toBeEnabled();
  });

  it('offers nothing for a Direct or Inline application', () => {
    const direct = liveRevision({
      facets: facets({
        source: plainSource('candidate_ready'),
        placement: { status: 'unbound_direct' },
      }),
    });
    renderActions(direct);
    expect(screen.queryByTestId('gitops-authority-actions')).toBeNull();
  });
});

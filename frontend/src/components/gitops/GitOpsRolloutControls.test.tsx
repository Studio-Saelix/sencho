/**
 * The rollout lifecycle control row: which control each rollout facet offers,
 * who may see it, and what the confirmed writes report back.
 */
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { facets, liveRevision, noApprovals, plainSource, target } from '@/__tests__/gitopsFixtures';
import type { GitOpsRevisionLive, RolloutFacet } from '@/types/gitops';
import type { PermissionAction } from '@/context/AuthContext';

// The overflow menu is the design's home for the rare and destructive
// controls; this suite drives the controls themselves, so the menu renders its
// items inline instead of negotiating Radix pointer events in jsdom.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, ...rest }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect} {...rest}>{children}</button>
  ),
}));

vi.mock('@/lib/gitopsAuthorityApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitopsAuthorityApi')>();
  return {
    ...actual,
    pauseGitOpsRollout: vi.fn(),
    resumeGitOpsRollout: vi.fn(),
    replanGitOpsRollout: vi.fn(),
    supersedeGitOpsRollout: vi.fn(),
    rollbackGitOpsRollout: vi.fn(),
    setGitOpsHealthRolloutPolicy: vi.fn(),
  };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import {
  pauseGitOpsRollout,
  replanGitOpsRollout,
  resumeGitOpsRollout,
  rollbackGitOpsRollout,
  setGitOpsHealthRolloutPolicy,
  supersedeGitOpsRollout,
} from '@/lib/gitopsAuthorityApi';
import { toast } from '@/components/ui/toast-store';
import GitOpsRolloutControls from './GitOpsRolloutControls';

function blueprintRevision(rollout: RolloutFacet, targets = [target()]): GitOpsRevisionLive {
  return liveRevision({
    targetMode: 'blueprint',
    applicationId: 'app-1',
    stackName: null,
    blueprintId: 5,
    approvals: noApprovals,
    targets,
    facets: facets({
      source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
      placement: { status: 'blueprint_bound', completion: 'unknown' },
      rollout,
    }),
  });
}

/** A target under a health-gated rollout, with the policy the gate froze. */
function gatedPolicy(policy: 'observe' | 'pause' | 'retry_once' | 'stop' | 'rollback') {
  return {
    policy,
    configuredPolicy: policy,
    awaitingRunId: null,
    attempts: 0,
    stopReason: null,
    recoveryAvailable: true,
  };
}

function renderControls(
  projection: GitOpsRevisionLive,
  can: (action: PermissionAction) => boolean = () => true,
  blueprintEnabled = true,
  onChanged: () => void = () => {},
  rollbackGenerations?: Array<{ generationId: string }>,
) {
  return render(
    <GitOpsRolloutControls
      applicationId="bp:5"
      projection={projection}
      onChanged={onChanged}
      can={can}
      blueprintEnabled={blueprintEnabled}
      rollbackGenerations={rollbackGenerations}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitOpsRolloutControls', () => {
  it('pauses a queued rollout with the operator reason', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(pauseGitOpsRollout).mockResolvedValue(undefined);
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      () => true,
      true,
      onChanged,
    );

    await user.click(screen.getByTestId('gitops-action-pause-rollout'));
    await user.type(screen.getByTestId('gitops-pause-reason'), 'maintenance window');
    await user.click(screen.getByTestId('gitops-confirm-pause'));

    await waitFor(() => expect(pauseGitOpsRollout).toHaveBeenCalledWith('bp:5', { reason: 'maintenance window' }));
    expect(toast.success).toHaveBeenCalledWith('Rollout paused');
    expect(onChanged).toHaveBeenCalled();
  });

  it('resumes a paused rollout and reports a started dispatch', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(resumeGitOpsRollout).mockResolvedValue({ dispatched: true, note: null });
    renderControls(
      blueprintRevision({ status: 'rollout_paused', pauseAt: 1, pauseReason: 'hold' }),
      () => true,
      true,
      onChanged,
    );

    await user.click(screen.getByTestId('gitops-action-resume-rollout'));
    await waitFor(() => expect(resumeGitOpsRollout).toHaveBeenCalledWith('bp:5'));
    expect(toast.success).toHaveBeenCalledWith('Rollout resumed and started');
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps a resumed rollout visible when nothing started', async () => {
    const user = userEvent.setup();
    vi.mocked(resumeGitOpsRollout).mockResolvedValue({
      dispatched: false,
      note: 'The rollout is resumed, but no live authorization exists; authorize the rollout to start it.',
    });
    renderControls(blueprintRevision({ status: 'rollout_paused', pauseAt: 1, pauseReason: 'hold' }));
    await user.click(screen.getByTestId('gitops-action-resume-rollout'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'The rollout is resumed, but no live authorization exists; authorize the rollout to start it.',
    ));
  });

  it('replans placement through its confirmation', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(replanGitOpsRollout).mockResolvedValue(undefined);
    renderControls(
      blueprintRevision({ status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' }),
      () => true,
      true,
      onChanged,
    );

    await user.click(screen.getByTestId('gitops-action-replan'));
    await user.click(screen.getByRole('button', { name: 'Replan placement' }));
    await waitFor(() => expect(replanGitOpsRollout).toHaveBeenCalledWith('bp:5'));
    expect(toast.success).toHaveBeenCalledWith('Placement review reopened');
  });

  it('supersedes the live rollout through its destructive confirmation', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(supersedeGitOpsRollout).mockResolvedValue(undefined);
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      () => true,
      true,
      onChanged,
    );

    await user.click(screen.getByTestId('gitops-action-supersede'));
    await user.click(screen.getByRole('button', { name: 'Supersede rollout' }));
    await waitFor(() => expect(supersedeGitOpsRollout).toHaveBeenCalledWith('bp:5'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('offers the health policy control and writes the chosen mode', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(setGitOpsHealthRolloutPolicy).mockResolvedValue(undefined);
    renderControls(
      blueprintRevision(
        { status: 'rollout_queued', rolloutGenerationId: 'rgen-1' },
        [target({ healthGate: gatedPolicy('observe') })],
      ),
      () => true,
      true,
      onChanged,
    );

    await user.click(screen.getByTestId('gitops-action-health-policy'));
    await user.click(screen.getByRole('radio', { name: 'pause' }));
    await user.click(screen.getByTestId('gitops-confirm-health-policy'));

    await waitFor(() => expect(setGitOpsHealthRolloutPolicy).toHaveBeenCalledWith('bp:5', 'pause'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows the policy the application is configured for, not the one the running rollout froze', async () => {
    const user = userEvent.setup();
    // The running rollout is under pause, but the operator has since set the
    // next one to rollback. The dialog edits the configured policy, so it opens
    // on rollback: opening on the frozen one would offer to undo a setting that
    // was never made.
    renderControls(
      blueprintRevision(
        { status: 'batch_in_progress', rolloutGenerationId: 'rgen-1' },
        [target({ healthGate: { ...gatedPolicy('pause'), configuredPolicy: 'rollback' } })],
      ),
      () => true,
    );

    await user.click(screen.getByTestId('gitops-action-health-policy'));

    expect(screen.getByTestId('gitops-confirm-health-policy')).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'rollback' })).toHaveAttribute('aria-checked', 'true');
  });

  it('reopens on the configured policy rather than the last one picked', async () => {
    const user = userEvent.setup();
    vi.mocked(setGitOpsHealthRolloutPolicy).mockResolvedValue(undefined);
    renderControls(
      blueprintRevision(
        { status: 'rollout_queued', rolloutGenerationId: 'rgen-1' },
        [target({ healthGate: gatedPolicy('observe') })],
      ),
      () => true,
    );

    // Pick something, then cancel.
    await user.click(screen.getByTestId('gitops-action-health-policy'));
    await user.click(screen.getByRole('radio', { name: 'stop' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Reopening has to start from what the application is actually set to. If it
    // kept the cancelled pick, the next open would offer to write a choice that
    // was abandoned, and confirming it would change the policy by accident.
    await user.click(screen.getByTestId('gitops-action-health-policy'));
    expect(screen.getByRole('radio', { name: 'observe' })).toHaveAttribute('aria-checked', 'true');
  });

  it('describes only the selected policy, and in words rather than the stored mode', async () => {
    const user = userEvent.setup();
    renderControls(
      blueprintRevision(
        { status: 'rollout_queued', rolloutGenerationId: 'rgen-1' },
        [target({ healthGate: gatedPolicy('observe') })],
      ),
      () => true,
    );

    await user.click(screen.getByTestId('gitops-action-health-policy'));

    // The stored name is a mode, not copy: `retry_once` is not something an
    // operator should be reading, so the option reads as prose.
    expect(screen.getByRole('radio', { name: 'retry once' })).toBeTruthy();
    // Five stacked explanations is a wall of text. Only the chosen one explains
    // itself, and the next rollout taking effect later is stated once, always.
    const body = screen.getByRole('dialog').textContent ?? '';
    expect(body).toContain('Record each target');
    expect(body).not.toContain('Restore the captured pre-rollout generation');
    expect(body).toMatch(/next rollout/i);
  });

  it('withholds the health policy control without deploy permission', () => {
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      action => action !== 'stack:deploy',
    );
    expect(screen.queryByTestId('gitops-action-health-policy')).toBeNull();
  });

  it('rolls back to the hub-known prior generation', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(rollbackGitOpsRollout).mockResolvedValue({
      ok: true,
      results: [{ nodeId: 1, status: 'restored' }],
    });
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      () => true,
      true,
      onChanged,
      [{ generationId: 'gen-lkg' }],
    );

    await user.click(screen.getByTestId('gitops-action-rollback'));
    expect(screen.getByTestId('gitops-rollback-caveats')).toHaveTextContent(
      /Only the generation captured immediately before each node's latest rollout can be restored there/,
    );
    await user.click(screen.getByTestId('gitops-confirm-rollback'));
    await waitFor(() => expect(rollbackGitOpsRollout).toHaveBeenCalledWith('bp:5', {
      generationId: 'gen-lkg',
      scope: { kind: 'all_changed' },
    }));
    expect(toast.success).toHaveBeenCalledWith('Rolled back 1 target');
    expect(onChanged).toHaveBeenCalled();
  });

  it('reports a partial rollback failure truthfully', async () => {
    const user = userEvent.setup();
    vi.mocked(rollbackGitOpsRollout).mockResolvedValue({
      ok: false,
      results: [{ nodeId: 1, status: 'failed', error: 'The node holds no recovery point for "bp-app".' }],
    });
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      () => true,
      true,
      () => {},
      [{ generationId: 'gen-lkg' }],
    );

    await user.click(screen.getByTestId('gitops-action-rollback'));
    await user.click(screen.getByTestId('gitops-confirm-rollback'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Rollback failed on 1 of 1 targets: The node holds no recovery point for "bp-app".',
    ));
  });

  it('scopes a rollback to the failed targets', async () => {
    const user = userEvent.setup();
    vi.mocked(rollbackGitOpsRollout).mockResolvedValue({
      ok: true,
      results: [{ nodeId: 1, status: 'restored' }],
    });
    renderControls(
      blueprintRevision(
        { status: 'rollout_queued', rolloutGenerationId: 'rgen-1' },
        [target({
          runtime: {
            status: 'recovery_failed',
            recoveryRef: 'rec-1',
            recoveryGenerationId: 'gen-lkg',
            failureClass: 'partial',
            failureAt: 1,
          },
        })],
      ),
      () => true,
      true,
      () => {},
      [{ generationId: 'gen-lkg' }],
    );

    await user.click(screen.getByTestId('gitops-action-rollback'));
    await user.click(screen.getByRole('radio', { name: 'Failed targets' }));
    await user.click(screen.getByTestId('gitops-confirm-rollback'));
    await waitFor(() => expect(rollbackGitOpsRollout).toHaveBeenCalledWith('bp:5', {
      generationId: 'gen-lkg',
      scope: { kind: 'failed' },
    }));
  });

  it('scopes a rollback to one target', async () => {
    const user = userEvent.setup();
    vi.mocked(rollbackGitOpsRollout).mockResolvedValue({
      ok: true,
      results: [{ nodeId: 1, status: 'restored' }],
    });
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      () => true,
      true,
      () => {},
      [{ generationId: 'gen-lkg' }],
    );

    await user.click(screen.getByTestId('gitops-action-rollback'));
    await user.click(screen.getByRole('radio', { name: 'One target' }));
    await user.click(screen.getByTestId('gitops-confirm-rollback'));
    await waitFor(() => expect(rollbackGitOpsRollout).toHaveBeenCalledWith('bp:5', {
      generationId: 'gen-lkg',
      scope: { kind: 'target', nodeId: 1 },
    }));
  });

  it('reports a rejected control with the server message', async () => {
    const user = userEvent.setup();
    vi.mocked(pauseGitOpsRollout).mockRejectedValue(new Error('The Blueprint is disabled.'));
    renderControls(blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }));

    await user.click(screen.getByTestId('gitops-action-pause-rollout'));
    await user.type(screen.getByTestId('gitops-pause-reason'), 'waiting');
    await user.click(screen.getByTestId('gitops-confirm-pause'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The Blueprint is disabled.'));
  });

  it('hides replan without stack:create but keeps the deploy controls', () => {
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      action => action !== 'stack:create',
      true,
      () => {},
      [{ generationId: 'gen-lkg' }],
    );
    expect(screen.getByTestId('gitops-action-pause-rollout')).toBeInTheDocument();
    expect(screen.getByTestId('gitops-action-supersede')).toBeInTheDocument();
    expect(screen.getByTestId('gitops-action-rollback')).toBeInTheDocument();
    expect(screen.queryByTestId('gitops-action-replan')).toBeNull();
  });

  it('offers the hub-known prior generations even when no target reports one', async () => {
    const user = userEvent.setup();
    vi.mocked(rollbackGitOpsRollout).mockResolvedValue({
      ok: true,
      results: [{ nodeId: 1, status: 'restored' }],
    });
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }, [target({ lkgGenerationId: null })]),
      () => true,
      true,
      () => {},
      [{ generationId: 'gen-hub-prior' }],
    );

    await user.click(screen.getByTestId('gitops-action-rollback'));
    await user.click(screen.getByTestId('gitops-confirm-rollback'));
    await waitFor(() => expect(rollbackGitOpsRollout).toHaveBeenCalledWith('bp:5', {
      generationId: 'gen-hub-prior',
      scope: { kind: 'all_changed' },
    }));
  });

  it('offers no controls without stack:deploy', () => {
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      action => action !== 'stack:deploy' && action !== 'stack:create',
    );
    expect(screen.queryByTestId('gitops-rollout-controls')).toBeNull();
  });

  it('withholds execution controls for a disabled Blueprint', () => {
    renderControls(
      blueprintRevision({ status: 'rollout_queued', rolloutGenerationId: 'rgen-1' }),
      () => true,
      false,
      () => {},
      [{ generationId: 'gen-lkg' }],
    );
    expect(screen.queryByTestId('gitops-action-pause-rollout')).toBeNull();
    expect(screen.queryByTestId('gitops-action-supersede')).toBeNull();
    expect(screen.queryByTestId('gitops-action-rollback')).toBeNull();
  });

  it('offers no controls for a Direct application', () => {
    renderControls(liveRevision({ facets: facets({ placement: { status: 'unbound_direct' } }) }));
    expect(screen.queryByTestId('gitops-rollout-controls')).toBeNull();
  });
});

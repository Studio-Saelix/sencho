/**
 * Covers the panel's load path for the unlinked-stack contract: when the
 * backend answers 200 { linked: false } (an existing stack with no Git source
 * attached), the form must land in the empty/unlinked state rather than
 * treating the sentinel as a configured source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

// Mutable controls so a deploy-mode test can set the active node and capture the
// runWithLog params, while the load tests keep the default (no active node).
const nodeCtl = vi.hoisted(() => ({ activeNode: null as { id: number; type?: string } | null }));
const dfCtl = vi.hoisted(() => ({ params: null as null | { stackName: string; action: string; nodeId: number | null } }));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: vi.fn(
      async (
        params: { stackName: string; action: string; nodeId: number | null },
        run: (started: Promise<void>) => Promise<{ ok: boolean }>,
      ) => {
        dfCtl.params = params;
        return run(Promise.resolve());
      },
    ),
  }),
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: nodeCtl.activeNode }),
}));
// Drive applyPull(commitSha, deploy=true) directly without standing up the real
// diff UI; the panel passes applyPull as onApply.
vi.mock('./GitSourceDiffDialog', () => ({
  GitSourceDiffDialog: ({
    open,
    onApply,
    onDismiss,
    pull,
  }: {
    open: boolean;
    onApply: (sha: string, deploy: boolean, fp: string) => void;
    onDismiss: () => void;
    pull: PullResult | null;
  }) => open ? (
    <div>
      <span data-testid="plan-fingerprint">{pull?.planFingerprint ?? ''}</span>
      <button
        data-testid="apply-deploy"
        onClick={() => onApply('sha-123', true, pull?.planFingerprint ?? 'fp-test')}
      >
        apply deploy
      </button>
      <button
        data-testid="apply-only"
        onClick={() => onApply('sha-123', false, pull?.planFingerprint ?? 'fp-test')}
      >
        apply
      </button>
      <button data-testid="dismiss" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  ) : null,
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

import { apiFetch } from '@/lib/api';
import { GitSourcePanel } from './GitSourcePanel';
import { toast } from '@/components/ui/toast-store';
import type { PullResult } from './GitSourceDiffDialog';
import {
  absentRevision,
  facets,
  liveRevision,
  missingApplicationLimitation,
  sourceRevision,
} from '@/__tests__/gitopsFixtures';
import { SOURCE_STATE } from '@/lib/gitopsState';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => '' } as unknown as Response;
}

const LINKED_SOURCE = {
  id: 1,
  stack_name: 'web',
  repo_url: 'https://github.com/org/repo.git',
  branch: 'main',
  compose_path: 'compose.yaml',
  sync_env: false,
  env_path: null,
  auth_type: 'none' as const,
  has_token: false,
  auto_apply_on_webhook: false,
  auto_deploy_on_apply: false,
  last_applied_commit_sha: null,
  pending_commit_sha: null,
  pending_fetched_at: null,
  created_at: 0,
  updated_at: 0,
  manifest_state: 'absent' as const,
  manifest: null,
  gitopsRevision: sourceRevision('application_generation_accepted', { candidateGenerationId: null }),
};

/** The linked source with its GitOps projection swapped for a specific state. */
function linkedWith(revision: unknown) {
  return { ...LINKED_SOURCE, gitopsRevision: revision };
}

const PULL_RESULT: PullResult = {
  commitSha: 'sha-old',
  validation: { ok: true },
  refusals: [],
  warnings: [],
  plan: {
    blocked: false,
    counts: {
      add: 0,
      modify: 0,
      delete: 0,
      rename: 0,
      unchanged: 1,
      localModified: 0,
      localMissing: 0,
      typeChanged: 0,
      unmanagedCollision: 0,
      invocation: 0,
    },
    operations: [],
    invocation: { candidateChanged: false, liveDiverged: false },
  },
  planFingerprint: 'fp-old',
};

function panel() {
  return (
    <GitSourcePanel
      open
      onOpenChange={vi.fn()}
      stackName="web"
      canEdit
      isDarkMode={false}
    />
  );
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  nodeCtl.activeNode = null;
  dfCtl.params = null;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('GitSourcePanel load', () => {
  it('treats a 200 { linked: false } response as the empty/unlinked state', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ linked: false }));

    render(panel());

    // Save (not Update) and no Pull now / Remove affordances means the panel
    // did not mistake the { linked: false } sentinel for a configured source.
    await screen.findByRole('button', { name: /^save$/i });
    expect(screen.queryByRole('button', { name: /update/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pull now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/repository url/i)).toHaveValue('');
  });

  it('renders the configured source when one is attached', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(LINKED_SOURCE));

    render(panel());

    // A real source flips the primary action to Update and exposes Pull now / Remove.
    await screen.findByRole('button', { name: /update/i });
    expect(screen.getByRole('button', { name: /pull now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText(/repository url/i)).toHaveValue('https://github.com/org/repo.git'),
    );
  });
});

describe('GitSourcePanel deploy-mode apply node binding', () => {
  beforeEach(() => {
    nodeCtl.activeNode = { id: 4, type: 'local' };
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ applied: true, deployed: true }));
  });

  it('binds both runWithLog and the apply POST to the captured node when deploying', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/git-source/apply')) {
        return jsonRes({ applied: true, deployed: true });
      }
      return jsonRes(LINKED_SOURCE);
    });
    render(panel());
    fireEvent.click(await screen.findByRole('button', { name: /pull now/i }));
    fireEvent.click(await screen.findByTestId('apply-deploy'));

    await waitFor(() => {
      const applyCall = vi.mocked(apiFetch).mock.calls.find(c => String(c[0]).includes('/git-source/apply'));
      expect(applyCall?.[1]).toEqual(expect.objectContaining({ nodeId: 4 }));
      expect(JSON.parse(String((applyCall?.[1] as { body?: string })?.body))).toEqual({
        commitSha: 'sha-123',
        planFingerprint: 'fp-test',
        deploy: true,
      });
    });
    expect(dfCtl.params).toEqual(expect.objectContaining({ action: 'deploy', nodeId: 4 }));
  });
});

describe('GitSourcePanel stale plan handling', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/git-source/pull')) {
        return jsonRes(PULL_RESULT);
      }
      if (String(url).includes('/git-source/apply')) {
        return jsonRes({
          error: 'The change plan is stale.',
          code: 'STALE_PLAN',
          planFingerprint: 'fp-new',
          plan: { ...PULL_RESULT.plan, blocked: true },
        }, false, 409);
      }
      return jsonRes(LINKED_SOURCE);
    });
  });

  it('keeps the diff open and replaces the pending plan on STALE_PLAN', async () => {
    render(panel());
    fireEvent.click(await screen.findByRole('button', { name: /pull now/i }));
    await screen.findByTestId('plan-fingerprint');
    expect(screen.getByTestId('plan-fingerprint')).toHaveTextContent('fp-old');

    fireEvent.click(screen.getByTestId('apply-only'));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/stale/i));
      expect(screen.getByTestId('plan-fingerprint')).toHaveTextContent('fp-new');
    });
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('GitSourcePanel dismiss handling', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/git-source/pull')) {
        return jsonRes(PULL_RESULT);
      }
      if (String(url).includes('/git-source/dismiss-pending')) {
        return jsonRes({
          error: 'Cannot dismiss the pending update for web: cannot dismiss while an operation is in flight',
          code: 'OPERATION_IN_FLIGHT',
        }, false, 409);
      }
      return jsonRes(LINKED_SOURCE);
    });
  });

  it('surfaces an error toast and keeps the diff open when dismiss is refused as in-flight', async () => {
    render(panel());
    fireEvent.click(await screen.findByRole('button', { name: /pull now/i }));
    await screen.findByTestId('plan-fingerprint');

    fireEvent.click(screen.getByTestId('dismiss'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/operation is in flight/i));
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('plan-fingerprint')).toHaveTextContent('fp-old');
  });
});

describe('GitSourcePanel manifest summary', () => {
  it('renders the managed-project section when the source carries a manifest', async () => {
    const summary = {
      state: 'active',
      manifestVersion: 2,
      resolvedCommitSha: 'abc1234567890abc1234567890abc1234567890a',
      managedCount: 3,
      unmanagedCount: 1,
      refusedCount: 0,
      refused: [],
      hasBuildContexts: true,
      generatedAt: 1,
    };
    vi.mocked(apiFetch).mockImplementation(async (url: string) =>
      url.includes('/git-source/manifest')
        ? jsonRes({
            // The manifest endpoint serves the redacted PUBLIC projection
            // (path, not sourcePath/materializedPath; no hashes or internals).
            manifest: {
              manifestVersion: 2,
              state: 'active',
              inputs: [
                { path: 'compose.yaml', role: 'compose-primary', dependencyKind: 'explicit', ownership: 'managed', sensitivity: 'medium', state: 'present', note: null },
              ],
            },
          })
        : jsonRes({ ...LINKED_SOURCE, manifest_state: 'active', manifest: summary }),
    );
    render(panel());
    const toggle = await screen.findByText('Managed project');
    expect(screen.getByText('abc1234')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    // Counts render in the expanded section; the inventory is lazy-fetched.
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('unmanaged')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('explicit')).toBeTruthy());
  });

  it('renders the manifest section with the DB state when the source has no manifest file', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(LINKED_SOURCE));
    render(panel());
    await waitFor(() => expect(screen.getByText('Last applied commit')).toBeTruthy());
    // The section is driven by the DB manifest_state ('absent') when the file
    // has not been materialized yet.
    expect(screen.getByText('Managed project')).toBeTruthy();
    expect(screen.getByText('Not materialized')).toBeTruthy();
  });
});

describe('GitSourcePanel GitOps state', () => {
  it('names the waiting state rather than a generic pending update', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonRes(linkedWith(sourceRevision('source_conflict_blocker'))),
    );

    render(panel());

    const banner = await screen.findByTestId('git-pending');
    expect(banner).toHaveAttribute('data-state', 'source_conflict_blocker');
    expect(within(banner).getByText(SOURCE_STATE.source_conflict_blocker.line)).toBeInTheDocument();
    // The short sha stays, so the operator can still see which commit it is.
    expect(within(banner).getByText('a1b2c3d')).toBeInTheDocument();
  });

  it('offers apply wording for a candidate that needs no review', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonRes(linkedWith(sourceRevision('candidate_ready'))),
    );

    render(panel());

    const banner = await screen.findByTestId('git-pending');
    expect(within(banner).getByText(SOURCE_STATE.candidate_ready.line)).toBeInTheDocument();
  });

  it('shows no banner when the accepted generation has no candidate behind it', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(LINKED_SOURCE));

    render(panel());

    await screen.findByRole('button', { name: /pull now/i });
    expect(screen.queryByTestId('git-pending')).not.toBeInTheDocument();
    expect(screen.getByTestId('git-source-state')).toHaveTextContent(
      SOURCE_STATE.application_generation_accepted.label,
    );
  });

  it('reports an application the projection could not reach', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonRes(linkedWith(absentRevision([missingApplicationLimitation]))),
    );

    render(panel());

    const fault = await screen.findByTestId('gitops-fault');
    expect(fault).toHaveTextContent(missingApplicationLimitation.message);
  });

  it('stays silent for a stack the model was never asked about', async () => {
    // Empty limitations is the ordinary case and must not read as a failure.
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ linked: false, gitopsRevision: absentRevision() }));

    render(panel());

    await screen.findByRole('button', { name: /^save$/i });
    expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-pending')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-source-state')).not.toBeInTheDocument();
  });

  it('drops the pending card once the source is detached', async () => {
    // The card is derived from the revision alone, so a detach that only
    // cleared the source would keep advertising a commit for a stack Git no
    // longer manages, behind a Review button that does nothing.
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/git-source') && !String(url).includes('?')) {
        return jsonRes(linkedWith(sourceRevision('candidate_ready')));
      }
      return jsonRes({ ok: true });
    });
    render(panel());
    await screen.findByTestId('git-pending');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: /^detach/i }));

    await waitFor(() => expect(screen.queryByTestId('git-pending')).not.toBeInTheDocument());
  });

  it('drops the revision when a later read fails, so one stack cannot report another stack state', async () => {
    // The panel is reused across stacks. A read that throws after a successful
    // one has to clear the projection, or stack A's pending commit renders
    // under stack B's header.
    vi.mocked(apiFetch).mockResolvedValue(
      jsonRes(linkedWith(sourceRevision('candidate_ready'))),
    );
    const { rerender } = render(
      <GitSourcePanel open onOpenChange={vi.fn()} stackName="web" canEdit isDarkMode={false} />,
    );
    await screen.findByTestId('git-pending');

    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    rerender(<GitSourcePanel open onOpenChange={vi.fn()} stackName="api" canEdit isDarkMode={false} />);

    // Wait for the load to settle before asserting: the body is skeletons while
    // it is in flight, so an assertion there would pass without the fix.
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await screen.findByLabelText(/repository url/i);
    expect(screen.queryByTestId('git-pending')).not.toBeInTheDocument();
  });

  it('re-reads after a save and shows the state the server reports', async () => {
    // The save answers with a bare source row and no revision, so the panel
    // cannot learn the new state from it. Keeping the old one would report a
    // candidate the save has just invalidated; showing nothing would report
    // "no GitOps here" for a stack that has it.
    vi.mocked(apiFetch).mockResolvedValue(
      jsonRes(linkedWith(sourceRevision('candidate_ready'))),
    );
    render(panel());
    await screen.findByTestId('git-pending');

    vi.mocked(apiFetch)
      // The PUT.
      .mockResolvedValueOnce(jsonRes({ ...LINKED_SOURCE, gitopsRevision: undefined }))
      // The re-read, which is where the state actually comes from.
      .mockResolvedValueOnce(jsonRes(linkedWith(
        sourceRevision('source_reconcile_required', { candidateGenerationId: null }),
      )));
    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() => expect(screen.getByTestId('git-source-state'))
      .toHaveTextContent(SOURCE_STATE.source_reconcile_required.label));
    // The staged candidate is gone, so nothing is offered to review.
    expect(screen.queryByTestId('git-pending')).not.toBeInTheDocument();
  });

  it('does not go blank after a save', async () => {
    // The save response carries no revision. Before the re-read, the panel
    // dropped its copy and rendered nothing until the next open, which reads
    // as a stack the model knows nothing about.
    vi.mocked(apiFetch).mockResolvedValue(
      jsonRes(linkedWith(sourceRevision('application_generation_accepted', { candidateGenerationId: null }))),
    );
    render(panel());
    await screen.findByTestId('git-source-state');

    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes({ ...LINKED_SOURCE, gitopsRevision: undefined }))
      .mockResolvedValueOnce(jsonRes(linkedWith(
        sourceRevision('application_generation_accepted', { candidateGenerationId: null }),
      )));
    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.getByTestId('git-source-state')).toBeInTheDocument();
  });

  it('shows no source card for an application that has no Git source', async () => {
    // Guards the panel against a projection whose source facet is not
    // applicable: without it the card renders "no git source" with a live
    // Review button.
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(linkedWith(liveRevision({
      targetMode: 'inline_blueprint',
      facets: facets({
        source: { status: 'not_applicable' },
        placement: { status: 'blueprint_bound', completion: 'unknown' },
      }),
    }))));
    render(panel());

    await screen.findByRole('button', { name: /pull now/i });
    expect(screen.queryByTestId('git-pending')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-source-state')).not.toBeInTheDocument();
  });

  it('still reports a waiting commit when no projection answered', async () => {
    // A swallowed GitOps write leaves the flat pointer as the only evidence.
    // The sidebar keeps showing it, so the panel has to agree.
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({
      ...LINKED_SOURCE,
      pending_commit_sha: 'f00ba12345',
      gitopsRevision: absentRevision(),
    }));
    render(panel());

    const banner = await screen.findByTestId('git-pending');
    expect(within(banner).getByText('f00ba12')).toBeInTheDocument();
  });

  it('does not treat a live application caveat as a fault', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(linkedWith(liveRevision({
      limitations: [{ code: 'repo_identity_invalid', message: 'Repository identity could not be read.', evidence: null }],
    }))));
    render(panel());

    await screen.findByTestId('git-source-state');
    expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
  });

  it('routes the pending card Review button to the pull endpoint', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonRes(linkedWith(sourceRevision('candidate_ready'))),
    );
    render(panel());
    const banner = await screen.findByTestId('git-pending');

    fireEvent.click(within(banner).getByRole('button', { name: 'Review' }));

    await waitFor(() => expect(
      vi.mocked(apiFetch).mock.calls.some(c => String(c[0]).includes('/git-source/pull')),
    ).toBe(true));
  });
});

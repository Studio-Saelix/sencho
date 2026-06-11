/**
 * Covers the panel's load path for the unlinked-stack contract: when the
 * backend answers 200 { linked: false } (an existing stack with no Git source
 * attached), the form must land in the empty/unlinked state rather than
 * treating the sentinel as a configured source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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
  GitSourceDiffDialog: ({ onApply }: { onApply: (sha: string, deploy: boolean) => void }) => (
    <button data-testid="apply-deploy" onClick={() => onApply('sha-123', true)}>apply</button>
  ),
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
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/repository url/i)).toHaveValue('');
  });

  it('renders the configured source when one is attached', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(LINKED_SOURCE));

    render(panel());

    // A real source flips the primary action to Update and exposes Pull now / Remove.
    await screen.findByRole('button', { name: /update/i });
    expect(screen.getByRole('button', { name: /pull now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
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
    render(panel());
    fireEvent.click(await screen.findByTestId('apply-deploy'));

    await waitFor(() => {
      const applyCall = vi.mocked(apiFetch).mock.calls.find(c => String(c[0]).includes('/git-source/apply'));
      expect(applyCall?.[1]).toEqual(expect.objectContaining({ nodeId: 4 }));
    });
    expect(dfCtl.params).toEqual(expect.objectContaining({ action: 'deploy', nodeId: 4 }));
  });
});

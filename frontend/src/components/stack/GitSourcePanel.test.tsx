/**
 * Covers the panel's load path for the unlinked-stack contract: when the
 * backend answers 200 { linked: false } (an existing stack with no Git source
 * attached), the form must land in the empty/unlinked state rather than
 * treating the sentinel as a configured source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({ runWithLog: vi.fn() }),
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: null }),
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

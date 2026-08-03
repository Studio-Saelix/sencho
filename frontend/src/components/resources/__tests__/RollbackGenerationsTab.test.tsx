import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RollbackGenerationsTab, type RollbackGeneration } from '../RollbackGenerationsTab';
import { toast } from '@/components/ui/toast-store';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

function generation(overrides: Partial<RollbackGeneration> = {}): RollbackGeneration {
  return {
    id: 'gen-1',
    shortId: 'abc123456789',
    stackName: 'seerr',
    status: 'superseded',
    isCurrent: false,
    phase: 'immediate_verified',
    createdAt: Date.now(),
    artifactExpiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
    releasable: true,
    ...overrides,
  };
}

beforeEach(() => {
  apiFetch.mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockReset();
  (toast.error as ReturnType<typeof vi.fn>).mockReset();
});

describe('RollbackGenerationsTab', () => {
  it('shows superseded-generation confirm copy (not the current-generation warning) for a non-current release', async () => {
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation({ isCurrent: false })]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));

    expect(await screen.findByText(/Permanently removes the held rollback image/i)).toBeInTheDocument();
    expect(screen.queryByText(/Automatic rollback is unavailable until/i)).not.toBeInTheDocument();
  });

  it('shows the current-generation warning copy when releasing the current generation', async () => {
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation({ isCurrent: true, status: 'active' })]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));

    expect(await screen.findByText(/Sencho will not be able to automatically/i)).toBeInTheDocument();
  });

  it('confirming release POSTs to the release endpoint and calls onReleased on success', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, message: 'Rollback protection released', artifactsCleaned: true }) });
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation()]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/system/rollback/generations/gen-1/release', { method: 'POST' }));
    await waitFor(() => expect(onReleased).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Rollback protection released');
  });

  it('surfaces the backend partial-cleanup message distinctly from a full release', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: 'Rollback protection released; cleanup will finish shortly', artifactsCleaned: false }),
    });
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation()]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rollback protection released; cleanup will finish shortly'));
  });

  it('surfaces the server error via toast and closes the modal without a lingering Releasing state on failure', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'This rollback generation cannot be released right now (it may be observing a health gate, mid-recovery, or already in progress).', code: 'NOT_ELIGIBLE' }) });
    const onReleased = vi.fn();
    render(<RollbackGenerationsTab generations={[generation()]} isLoading={false} isAdmin onReleased={onReleased} />);

    await userEvent.click(screen.getByRole('button', { name: /release rollback protection/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('cannot be released right now')));
    expect(onReleased).not.toHaveBeenCalled();
    // Modal closes (confirm button no longer present) rather than staying stuck mid-action.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument());
  });

  it('hides the Release action for a non-admin', () => {
    render(<RollbackGenerationsTab generations={[generation()]} isLoading={false} isAdmin={false} onReleased={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /release rollback protection/i })).not.toBeInTheDocument();
  });

  it('disables the Release action when the generation is not releasable', () => {
    render(<RollbackGenerationsTab generations={[generation({ releasable: false })]} isLoading={false} isAdmin onReleased={vi.fn()} />);
    expect(screen.getByRole('button', { name: /release rollback protection/i })).toBeDisabled();
  });

  it('renders an empty state when there are no generations', () => {
    render(<RollbackGenerationsTab generations={[]} isLoading={false} isAdmin onReleased={vi.fn()} />);
    expect(screen.getByText(/No rollback-protected generations on this node/i)).toBeInTheDocument();
  });

  it('shows a loading skeleton instead of the empty state while the initial fetch is in flight', () => {
    render(<RollbackGenerationsTab generations={[]} isLoading={true} isAdmin onReleased={vi.fn()} />);
    expect(screen.queryByText(/No rollback-protected generations on this node/i)).not.toBeInTheDocument();
  });
});

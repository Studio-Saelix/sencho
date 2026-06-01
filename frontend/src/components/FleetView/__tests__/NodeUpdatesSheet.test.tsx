import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { NodeUpdatesSheet } from '../NodeUpdatesSheet';
import { toast } from '@/components/ui/toast-store';
import type { NodeUpdateStatus } from '../types';

const STATUSES: NodeUpdateStatus[] = [
  { nodeId: 1, name: 'Local', type: 'local', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: false, updateStatus: 'completed' },
  { nodeId: 2, name: 'Edge', type: 'remote', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, updateStatus: null },
  { nodeId: 3, name: 'Db', type: 'remote', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: false, updateStatus: 'failed', error: 'pull failed' },
];

function baseProps(overrides: Partial<React.ComponentProps<typeof NodeUpdatesSheet>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    checkingUpdates: false,
    updateStatuses: STATUSES,
    updatingNodeId: null,
    isAdmin: true,
    fetchUpdateStatus: vi.fn(async () => {}),
    triggerNodeUpdate: vi.fn(),
    retryNodeUpdate: vi.fn(),
    dismissNodeUpdate: vi.fn(),
    triggerUpdateAll: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => apiFetchMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe('NodeUpdatesSheet', () => {
  it('renders the per-node table rows', () => {
    render(<NodeUpdatesSheet {...baseProps()} />);
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Edge')).toBeInTheDocument();
    expect(screen.getByText('Db')).toBeInTheDocument();
  });

  it('shows a checking spinner state', () => {
    render(<NodeUpdatesSheet {...baseProps({ checkingUpdates: true })} />);
    expect(screen.getByText('Checking for updates...')).toBeInTheDocument();
  });

  it('shows the empty state with no nodes', () => {
    render(<NodeUpdatesSheet {...baseProps({ updateStatuses: [] })} />);
    expect(screen.getByText('No nodes found.')).toBeInTheDocument();
  });

  it('triggers a per-node update from the Update button', () => {
    const triggerNodeUpdate = vi.fn();
    render(<NodeUpdatesSheet {...baseProps({ triggerNodeUpdate })} />);
    fireEvent.click(screen.getByRole('button', { name: /Update$/ }));
    expect(triggerNodeUpdate).toHaveBeenCalledWith(2);
  });

  it('filters the node table by the search box', () => {
    render(<NodeUpdatesSheet {...baseProps()} />);
    fireEvent.change(screen.getByPlaceholderText('Filter nodes...'), { target: { value: 'edge' } });
    expect(screen.getByText('Edge')).toBeInTheDocument();
    expect(screen.queryByText('Local')).not.toBeInTheDocument();
  });

  it('renders every mutating affordance for an admin', () => {
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true })} />);
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update all/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update$/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Retry update')).toBeInTheDocument();
  });

  it('toasts when a recheck is throttled by the server (rechecked:false)', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ rechecked: false }) });
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/fleet/update-status?recheck=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('surfaces an error when the recheck endpoint returns a non-ok status', async () => {
    // apiFetch only throws on 401/network, so a 500 lands as res.ok === false.
    apiFetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('does not toast when a recheck actually refreshed (rechecked:true)', async () => {
    const fetchUpdateStatus = vi.fn(async () => {});
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ rechecked: true }) });
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: true, fetchUpdateStatus })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(fetchUpdateStatus).toHaveBeenCalled());
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('hides every mutating affordance for a non-admin but keeps the read-only table', () => {
    render(<NodeUpdatesSheet {...baseProps({ isAdmin: false })} />);
    // Read-only status remains visible
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Edge')).toBeInTheDocument();
    expect(screen.getByText('Db')).toBeInTheDocument();
    // 'Available' appears once as the summary stat label; for a non-admin the
    // per-row read-only badge adds a second occurrence in place of the button.
    expect(screen.getAllByText('Available')).toHaveLength(2);
    // No mutate controls
    expect(screen.queryByRole('button', { name: 'Recheck' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update all/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update$/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Retry update')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dismiss')).not.toBeInTheDocument();
  });
});

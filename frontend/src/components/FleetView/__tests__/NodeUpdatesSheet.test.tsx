import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { NodeUpdatesSheet } from '../NodeUpdatesSheet';
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
});

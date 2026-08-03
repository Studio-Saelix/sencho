import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const useAuthMock = vi.fn();
const useNodesMock = vi.fn();

vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => useNodesMock() }));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/nodesApi', () => ({ cordonNode: vi.fn(), uncordonNode: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NodeCard } from '../NodeCard';
import type { FleetNode } from '../types';

function onlineNode(): FleetNode {
  return {
    id: 2, name: 'Edge', type: 'remote', status: 'online',
    stats: { active: 3, managed: 3, unmanaged: 0, exited: 1, total: 4 },
    systemStats: { cpu: { usage: '20.0', cores: 4 }, memory: { total: 100, used: 40, free: 60, usagePercent: '40.0' }, disk: { total: 100, used: 30, free: 70, usagePercent: '30.0' } },
    stacks: ['web'], cordoned: false, cordoned_at: null, cordoned_reason: null,
  };
}

function offlineNode(): FleetNode {
  return { ...onlineNode(), status: 'offline', stats: null, systemStats: null, stacks: null };
}

function baseProps(node: FleetNode) {
  return { node, onNavigate: vi.fn(), onOpenDetails: vi.fn() };
}

beforeEach(() => {
  useNodesMock.mockReturnValue({ nodes: [], hasCapability: vi.fn(() => false) });
  useAuthMock.mockReturnValue({ isAdmin: true, can: vi.fn(() => true) });
});
afterEach(() => vi.clearAllMocks());

describe('NodeCard', () => {
  it('renders stats and the online badge for an online node', () => {
    render(<NodeCard {...baseProps(onlineNode())} />);
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByText('Node unreachable')).not.toBeInTheDocument();
  });

  it('shows the unreachable placeholder and hides stats for an offline node', () => {
    render(<NodeCard {...baseProps(offlineNode())} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Node unreachable')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
  });

  it('exposes the actions menu and Cordon node for a user with node:manage', async () => {
    const can = vi.fn((action: string) => action === 'node:manage');
    useAuthMock.mockReturnValue({ isAdmin: false, can });
    render(<NodeCard {...baseProps(onlineNode())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Node actions' }));
    expect(await screen.findByText('Cordon node')).toBeInTheDocument();
    expect(can).toHaveBeenCalledWith('node:manage', 'node', '2');
  });

  it('shows edit and delete controls to a scoped node manager who is not an admin', async () => {
    const node = onlineNode();
    const registryNode = { id: 2, name: 'Edge', type: 'remote', is_default: false };
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    useNodesMock.mockReturnValue({ nodes: [registryNode, { id: 1, type: 'local' }], hasCapability: vi.fn(() => false) });
    useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn((action: string) => action === 'node:manage') });
    render(<NodeCard {...baseProps(node)} onEdit={onEdit} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole('button', { name: 'Node actions' }));
    expect(await screen.findByText('Edit node')).toBeInTheDocument();
    expect(screen.getByText('Delete node')).toBeInTheDocument();
  });

  it('shows only Node details to a user lacking node:manage', async () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
    render(<NodeCard {...baseProps(onlineNode())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Node actions' }));
    expect(await screen.findByText('Node details')).toBeInTheDocument();
    expect(screen.queryByText('Cordon node')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit node')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete node')).not.toBeInTheDocument();
  });

  it('calls onOpenDetails with the node id when Node details is clicked', async () => {
    const onOpenDetails = vi.fn();
    useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
    render(<NodeCard {...baseProps(onlineNode())} onOpenDetails={onOpenDetails} />);

    await userEvent.click(screen.getByRole('button', { name: 'Node actions' }));
    await userEvent.click(await screen.findByText('Node details'));
    expect(onOpenDetails).toHaveBeenCalledWith(2);
  });

  it('shows Node details ahead of the manage items for a node:manage user', async () => {
    const can = vi.fn((action: string) => action === 'node:manage');
    useAuthMock.mockReturnValue({ isAdmin: false, can });
    render(<NodeCard {...baseProps(onlineNode())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Node actions' }));
    const menuItems = await screen.findAllByRole('menuitem');
    const labels = menuItems.map(item => item.textContent);
    expect(labels[0]).toBe('Node details');
    expect(labels).toContain('Cordon node');
  });

  it('shows Uncordon when the node is already cordoned', async () => {
    const can = vi.fn((action: string) => action === 'node:manage');
    useAuthMock.mockReturnValue({ isAdmin: false, can });
    render(<NodeCard {...baseProps({ ...onlineNode(), cordoned: true, cordoned_reason: 'patching' })} />);

    await userEvent.click(screen.getByRole('button', { name: 'Node actions' }));
    expect(await screen.findByText('Uncordon node')).toBeInTheDocument();
  });

  const updateAvailableStatus = {
    nodeId: 2, name: 'Edge', type: 'remote' as const, version: '1.0.0', latestVersion: '1.1.0',
    updateAvailable: true, updateStatus: null,
  };

  it('renders the update button for an admin when an update is available', () => {
    useAuthMock.mockReturnValue({ isAdmin: true, can: vi.fn(() => true) });
    render(<NodeCard {...baseProps(onlineNode())} updateStatus={updateAvailableStatus} onUpdate={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Update/ })).toBeInTheDocument();
  });

  it('hides the update button and shows Pinned when updateBlocked', () => {
    useAuthMock.mockReturnValue({ isAdmin: true, can: vi.fn(() => true) });
    render(
      <NodeCard
        {...baseProps(onlineNode())}
        updateStatus={{ ...updateAvailableStatus, updateBlocked: true, updateBlockedReason: 'Digest pin.' }}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update/ })).not.toBeInTheDocument();
  });

  it('shows the networking signal badge and switches to the node on click', async () => {
    const onOpenNetworking = vi.fn();
    const user = userEvent.setup();
    render(
      <NodeCard
        {...baseProps(onlineNode())}
        onOpenNetworking={onOpenNetworking}
        networkingSignal={{ exposed: false, unknown: false, drift: true }}
      />,
    );
    const badge = screen.getByText(/Networking/);
    expect(badge).toBeInTheDocument();
    await user.click(badge);
    expect(onOpenNetworking).toHaveBeenCalledWith(2);
  });

  it('hides the networking signal badge when there is nothing to flag', () => {
    render(
      <NodeCard
        {...baseProps(onlineNode())}
        onOpenNetworking={vi.fn()}
        networkingSignal={{ exposed: false, unknown: false, drift: false }}
      />,
    );
    expect(screen.queryByText(/Networking/)).not.toBeInTheDocument();
  });
});

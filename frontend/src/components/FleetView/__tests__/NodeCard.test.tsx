import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const useAuthMock = vi.fn();
const useNodesMock = vi.fn();

vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => useNodesMock() }));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/lib/nodesApi', () => ({ cordonNode: vi.fn(), uncordonNode: vi.fn() }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastMock }));

import { NodeCard } from '../NodeCard';
import { GITOPS_PORTFOLIO_SCOPE_EVENT } from '@/components/gitops/portfolio/portfolioNavigation';
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
  it('renders stats and no status or type badge for an online node', () => {
    render(<NodeCard {...baseProps(onlineNode())} />);
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    expect(screen.queryByText('remote')).not.toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByText('Node unreachable')).not.toBeInTheDocument();
  });

  it('names the GitOps attention once and opens the applications from its verb, without opening the card', () => {
    const props = baseProps(onlineNode());
    const scopes: unknown[] = [];
    const onScope = (e: Event) => scopes.push((e as CustomEvent).detail);
    window.addEventListener(GITOPS_PORTFOLIO_SCOPE_EVENT, onScope);
    try {
      render(<NodeCard {...props} gitopsAttention={2} />);
      expect(screen.getByText('GitOps')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Open GitOps/ }));
    } finally {
      window.removeEventListener(GITOPS_PORTFOLIO_SCOPE_EVENT, onScope);
    }
    expect(scopes).toEqual([{ nodeId: 2, attention: true }]);
    expect(props.onOpenDetails).not.toHaveBeenCalled();
  });

  it('shows no state chip and no verb when nothing on the node needs attention', () => {
    render(<NodeCard {...baseProps(onlineNode())} gitopsAttention={0} />);
    expect(screen.queryByText('GitOps')).not.toBeInTheDocument();
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open GitOps|Update|Test connection/ })).not.toBeInTheDocument();
  });

  it('shows one chip for the loudest state and counts the rest, opening details from the count', async () => {
    const props = baseProps({ ...onlineNode(), cordoned: true, cordoned_reason: 'patching' });
    render(<NodeCard {...props} gitopsAttention={1} networkingSignal={{ exposed: true, unknown: false, drift: false }} />);
    expect(screen.getByText('GitOps')).toBeInTheDocument();
    expect(screen.queryByText('Cordoned')).not.toBeInTheDocument();
    expect(screen.queryByText('Networking')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /2 more states/ }));
    expect(props.onOpenDetails).toHaveBeenCalledWith(2);
  });

  it('says why an offline Proxy node is unreachable, with one Test connection verb and no stats', () => {
    render(<NodeCard {...baseProps(offlineNode())} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Proxy unreachable · never connected')).toBeInTheDocument();
    expect(screen.queryByText('Node unreachable')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test connection/ })).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
  });

  it('says a Pilot is disconnected with its last-seen age', () => {
    const seen = Math.floor(Date.now() / 1000) - 12 * 60;
    render(<NodeCard {...baseProps({ ...offlineNode(), mode: 'pilot_agent', pilot_last_seen: seen })} />);
    expect(screen.getByText('Pilot disconnected · last seen 12m ago')).toBeInTheDocument();
  });

  it('hides Test connection from a user who cannot manage the node', () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
    render(<NodeCard {...baseProps(offlineNode())} />);
    expect(screen.getByText('Proxy unreachable · never connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test connection/ })).not.toBeInTheDocument();
  });

  it('runs the connection test in place, reports the result, and refreshes the overview', async () => {
    const onTested = vi.fn();
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Pilot agent is not connected.' }), { status: 200 }));
    render(<NodeCard {...baseProps(offlineNode())} onTested={onTested} />);
    await userEvent.click(screen.getByRole('button', { name: /Test connection/ }));
    await vi.waitFor(() => expect(onTested).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenCalledWith('/nodes/2/test', expect.objectContaining({ method: 'POST', localOnly: true }));
    expect(toastMock.error).toHaveBeenCalledWith('Pilot agent is not connected.');
  });

  it('keeps the stale update reading off an offline node', () => {
    render(<NodeCard {...baseProps(offlineNode())} updateStatus={updateAvailableStatus} onUpdate={vi.fn()} />);
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update/ })).not.toBeInTheDocument();
  });

  it('keeps the update progress badge, with Retry and Dismiss, beside an Offline chip', async () => {
    const onRetryUpdate = vi.fn();
    const onDismissUpdate = vi.fn();
    render(
      <NodeCard
        {...baseProps(offlineNode())}
        updateStatus={{ ...updateAvailableStatus, updateAvailable: false, updateStatus: 'timeout', error: 'node never returned' }}
        onRetryUpdate={onRetryUpdate}
        onDismissUpdate={onDismissUpdate}
      />,
    );
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry update' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onRetryUpdate).toHaveBeenCalledWith(2);
    expect(onDismissUpdate).toHaveBeenCalledWith(2);
  });

  it('keeps Retry reachable for a failed update that a Critical state outranks', async () => {
    const onRetryUpdate = vi.fn();
    const node = { ...onlineNode(), systemStats: { ...onlineNode().systemStats!, cpu: { usage: '95.0', cores: 4 } } };
    render(
      <NodeCard
        {...baseProps(node)}
        updateStatus={{ ...updateAvailableStatus, updateAvailable: false, updateStatus: 'failed' }}
        onRetryUpdate={onRetryUpdate}
      />,
    );
    expect(screen.getByText('Critical')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry update' }));
    expect(onRetryUpdate).toHaveBeenCalledWith(2);
  });

  it('shows the just-finished update as Updated, on a node with nothing else to say', () => {
    render(<NodeCard {...baseProps(onlineNode())} updateStatus={{ ...updateAvailableStatus, updateAvailable: false, updateStatus: 'completed' }} />);
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('locks the update button while that node is updating, with a progressive label', () => {
    render(<NodeCard {...baseProps(onlineNode())} updateStatus={updateAvailableStatus} onUpdate={vi.fn()} updatingNodeId={2} />);
    expect(screen.getByRole('button', { name: /Update to/ })).toBeDisabled();
  });

  it('shows a reconnecting Pilot inside its grace window with Test connection, not empty stats', () => {
    const seen = Math.floor(Date.now() / 1000) - 5;
    render(<NodeCard {...baseProps({ ...onlineNode(), mode: 'pilot_agent', stats: null, systemStats: null, pilot_last_seen: seen })} />);
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test connection/ })).toBeInTheDocument();
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
    expect(await screen.findByRole('menuitem', { name: 'Uncordon node' })).toBeInTheDocument();
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
    expect(screen.getByText('Update pinned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update/ })).not.toBeInTheDocument();
  });

  it('marks an integration image quietly beside the version, regardless of update availability', () => {
    render(
      <NodeCard
        {...baseProps(onlineNode())}
        updateStatus={{ ...updateAvailableStatus, updateAvailable: false, isDevImage: true, devBuildUpdateAvailable: false }}
      />,
    );
    expect(screen.getByText(/v1\.0\.0 · integration/)).toBeInTheDocument();
    expect(screen.queryByText('Integration image')).not.toBeInTheDocument();
  });

  it('does not mark a non-dev node as an integration image', () => {
    render(<NodeCard {...baseProps(onlineNode())} updateStatus={updateAvailableStatus} onUpdate={vi.fn()} />);
    expect(screen.queryByText(/integration/)).not.toBeInTheDocument();
  });

  it('shows the dev-build update button for an admin when a dev build is available', async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();
    render(
      <NodeCard
        {...baseProps(onlineNode())}
        updateStatus={{ ...updateAvailableStatus, updateAvailable: false, isDevImage: true, devBuildUpdateAvailable: true }}
        onUpdate={onUpdate}
      />,
    );
    const button = screen.getByRole('button', { name: /Update dev build/ });
    expect(button).toBeInTheDocument();
    expect(screen.getByText('New dev build')).toBeInTheDocument();
    await user.click(button);
    expect(onUpdate).toHaveBeenCalledWith(2);
  });

  it('hides the dev-build update button for a non-admin', () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
    render(
      <NodeCard
        {...baseProps(onlineNode())}
        updateStatus={{ ...updateAvailableStatus, updateAvailable: false, isDevImage: true, devBuildUpdateAvailable: true }}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Update dev build/ })).not.toBeInTheDocument();
    expect(screen.getByText('New dev build')).toBeInTheDocument();
  });

  it('hides the dev-build update button when no dev build is available', () => {
    render(
      <NodeCard
        {...baseProps(onlineNode())}
        updateStatus={{ ...updateAvailableStatus, updateAvailable: false, isDevImage: true, devBuildUpdateAvailable: false }}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Update dev build/ })).not.toBeInTheDocument();
  });

  it('never shows both update buttons for a well-formed dev row (mutual exclusion by construction)', () => {
    // The backend (fleet.ts) guarantees updateAvailable=false whenever isDevImage
    // is true, so the two buttons' gating conditions can never both be satisfied
    // for real data; the component intentionally adds no redundant isDevImage
    // check to the stable button. This fixture reflects what the backend can
    // actually send, not an artificial one.
    render(
      <NodeCard
        {...baseProps(onlineNode())}
        updateStatus={{ ...updateAvailableStatus, updateAvailable: false, isDevImage: true, devBuildUpdateAvailable: true }}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Update dev build/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update to/ })).not.toBeInTheDocument();
  });

  it('pins a Proxy marker on a proxy remote node', () => {
    render(<NodeCard {...baseProps(onlineNode())} />);
    expect(screen.getByText('Proxy')).toBeInTheDocument();
    expect(screen.queryByText('Pilot')).not.toBeInTheDocument();
    expect(screen.queryByText('★ Local')).not.toBeInTheDocument();
  });

  it('pins a Pilot marker on a pilot agent node', () => {
    render(<NodeCard {...baseProps({ ...onlineNode(), mode: 'pilot_agent' })} />);
    expect(screen.getByText('Pilot')).toBeInTheDocument();
    expect(screen.queryByText('Proxy')).not.toBeInTheDocument();
  });

  it('prefers the registry connection mode over the fleet payload', () => {
    useNodesMock.mockReturnValue({
      nodes: [{ id: 2, name: 'Edge', type: 'remote', mode: 'proxy' }],
      hasCapability: vi.fn(() => false),
    });
    render(<NodeCard {...baseProps({ ...onlineNode(), mode: 'pilot_agent' })} />);
    expect(screen.getByText('Proxy')).toBeInTheDocument();
    expect(screen.queryByText('Pilot')).not.toBeInTheDocument();
  });

  it('uses the registry mode when the fleet payload carries none', () => {
    useNodesMock.mockReturnValue({
      nodes: [{ id: 2, name: 'Edge', type: 'remote', mode: 'pilot_agent' }],
      hasCapability: vi.fn(() => false),
    });
    render(<NodeCard {...baseProps(onlineNode())} />);
    expect(screen.getByText('Pilot')).toBeInTheDocument();
  });

  it('keeps the connection pin on an offline remote node', () => {
    render(<NodeCard {...baseProps({ ...offlineNode(), mode: 'pilot_agent' })} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Pilot')).toBeInTheDocument();
  });

  it('pins only the Local marker on the local node', () => {
    render(<NodeCard {...baseProps({ ...onlineNode(), type: 'local' })} />);
    expect(screen.getByText('★ Local')).toBeInTheDocument();
    expect(screen.queryByText('Proxy')).not.toBeInTheDocument();
    expect(screen.queryByText('Pilot')).not.toBeInTheDocument();
  });
});

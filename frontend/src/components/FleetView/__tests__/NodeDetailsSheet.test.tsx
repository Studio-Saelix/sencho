import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const useNodesMock = vi.fn();
const useAuthMock = vi.fn();
const apiFetchMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({ useNodes: () => useNodesMock() }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/lib/nodesApi', () => ({ cordonNode: vi.fn(), uncordonNode: vi.fn() }));

// NodeLabelPicker is a fully self-fetching reused unit (its own tests cover its
// behavior); shallow-mock it here so this file stays focused on the sheet.
vi.mock('@/components/blueprints/NodeLabelPicker', () => ({
  NodeLabelPicker: ({ nodeId, canEdit }: { nodeId: number; canEdit: boolean }) => (
    <div data-testid="node-label-picker">labels for {nodeId} · editable={String(canEdit)}</div>
  ),
}));

import { NodeDetailsSheet, type NodeSheetHandlers } from '../NodeDetailsSheet';
import type { FleetNode, NodeUpdateStatus } from '../types';
import type { Node } from '@/context/NodeContext';

// FleetNode's last_successful_contact/pilot_last_seen come from the
// fleet-overview endpoint in Unix SECONDS (see fleetSecondsToMs's comment in
// the component) — these fixtures must use seconds, not milliseconds, or a
// bug in the component's unit handling would go undetected here.
function fleetNode(overrides: Partial<FleetNode> = {}): FleetNode {
  return {
    id: 2,
    name: 'Edge',
    type: 'remote',
    mode: 'proxy',
    status: 'online',
    stats: { active: 3, managed: 3, unmanaged: 0, exited: 1, total: 4 },
    systemStats: { cpu: { usage: '20.0', cores: 4 }, memory: { total: 100, used: 40, free: 60, usagePercent: '40.0' }, disk: { total: 100, used: 30, free: 70, usagePercent: '30.0' } },
    stacks: ['web'],
    cordoned: false,
    cordoned_at: null,
    cordoned_reason: null,
    latency_ms: 42,
    last_successful_contact: Math.floor(Date.now() / 1000) - 5,
    ...overrides,
  };
}

function registryNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 2,
    name: 'Edge',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/srv/compose',
    is_default: false,
    status: 'online',
    created_at: Date.UTC(2026, 0, 1),
    api_url: 'https://edge.internal:1852',
    has_token: true,
    ...overrides,
  };
}

const UPDATE_STATUS: NodeUpdateStatus = {
  nodeId: 2, name: 'Edge', type: 'remote', version: '1.2.0', latestVersion: '1.2.0',
  updateAvailable: false, updateStatus: null, imageChannel: 'community', imagePinKind: 'semver',
};

function handlers(overrides: Partial<NodeSheetHandlers> = {}): NodeSheetHandlers {
  return { onEdit: vi.fn(), onDelete: vi.fn(), onUpdate: vi.fn(), onRetryUpdate: vi.fn(), onDismissUpdate: vi.fn(), onOpenNetworking: vi.fn(), ...overrides };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof NodeDetailsSheet>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    node: fleetNode(),
    registryNode: registryNode(),
    updateStatus: UPDATE_STATUS,
    networkingSignal: { exposed: false, unknown: false, drift: false },
    gitopsAttention: 0,
    handlers: handlers(),
    ...overrides,
  };
}

function asManager() {
  useAuthMock.mockReturnValue({ isAdmin: true, can: vi.fn(() => true) });
}

beforeEach(() => {
  useNodesMock.mockReturnValue({ nodes: [], nodeMeta: new Map(), refreshNodeMeta: vi.fn() });
  asManager();
});
afterEach(() => vi.clearAllMocks());

const openDetails = () => userEvent.click(screen.getByRole('button', { name: 'Details' }));

describe('NodeDetailsSheet', () => {
  it('opens on an Overview that answers first, with the structural meta line and no status word in it', () => {
    render(<NodeDetailsSheet {...baseProps()} />);
    expect(screen.getByRole('heading', { name: 'Edge' })).toBeInTheDocument();
    expect(screen.getByText('API Proxy · v1.2.0 · 1 stack')).toBeInTheDocument();
    expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'healthy');
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Overview', 'Resources', 'Settings']);
  });

  it('keeps the Path quiet: one row of the stages that apply, each fact once', () => {
    render(<NodeDetailsSheet {...baseProps()} />);
    const path = screen.getByTestId('status-path');
    expect(path).toHaveTextContent('connection');
    expect(path).toHaveTextContent('connected');
    expect(path).toHaveTextContent('3 running · 1 stopped');
    expect(path).toHaveTextContent('up to date');
    expect(path).not.toHaveTextContent(/networking|gitops|scheduling/i);
  });

  it('keeps the proof collapsed until opened, then shows connection evidence', async () => {
    render(<NodeDetailsSheet {...baseProps()} />);
    expect(screen.queryByText('42 ms')).not.toBeInTheDocument();
    await openDetails();
    expect(screen.getByText('42 ms')).toBeInTheDocument();
    expect(screen.getByText('Last successful contact')).toBeInTheDocument();
  });

  it('shows token-configured as a yes/no and never renders a raw token value', async () => {
    render(<NodeDetailsSheet {...baseProps({ registryNode: registryNode({ has_token: true }) })} />);
    await openDetails();
    expect(screen.getByText('Token configured')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.queryByText(/eyJ|Bearer /)).not.toBeInTheDocument();
  });

  it('shows a skeleton for capabilities until nodeMeta resolves, then renders the count', async () => {
    const { rerender } = render(<NodeDetailsSheet {...baseProps()} />);
    await openDetails();
    expect(screen.queryByText(/capabilities advertised/)).not.toBeInTheDocument();

    useNodesMock.mockReturnValue({
      nodes: [],
      nodeMeta: new Map([[2, { version: '1.2.0', capabilities: ['fleet', 'self-update'], fetchedAt: Date.now() }]]),
      refreshNodeMeta: vi.fn(),
    });
    rerender(<NodeDetailsSheet {...baseProps()} />);
    expect(screen.getByText('2 capabilities advertised (show)')).toBeInTheDocument();
  });

  it('returns null when no node is selected', () => {
    const { container } = render(<NodeDetailsSheet {...baseProps({ node: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('converts FleetNode seconds-based timestamps correctly, not decades off', async () => {
    render(
      <NodeDetailsSheet
        {...baseProps({
          node: fleetNode({
            mode: 'pilot_agent',
            last_successful_contact: Math.floor(Date.now() / 1000) - 5,
            pilot_last_seen: Math.floor(Date.now() / 1000) - 5,
          }),
          registryNode: registryNode({ mode: 'pilot_agent', pilot_last_seen: Date.now() - 5_000, pilot_agent_version: '1.0.0' }),
        })}
      />,
    );
    await openDetails();
    // "just now" appears for both Last successful contact and Last connected.
    // If the seconds value were passed straight to formatTimeAgo (which expects
    // ms), this would instead render something like "20647d ago".
    expect(screen.getAllByText('just now').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/d ago/)).not.toBeInTheDocument();
    expect(screen.queryByText('Pilot heartbeat')).not.toBeInTheDocument();
  });

  it('omits Last successful contact for the local node instead of showing Never', async () => {
    render(<NodeDetailsSheet {...baseProps({ node: fleetNode({ type: 'local', last_successful_contact: null }) })} />);
    await openDetails();
    expect(screen.queryByText('Last successful contact')).not.toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });

  it('never claims Up to date when the update status is absent', () => {
    render(<NodeDetailsSheet {...baseProps({ updateStatus: undefined })} />);
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('status-path')).not.toHaveTextContent('version');
  });

  describe('Answer verbs', () => {
    it('offers the versioned update as the Answer verb and runs the shared handler', async () => {
      const h = handlers();
      render(<NodeDetailsSheet {...baseProps({ handlers: h, updateStatus: { ...UPDATE_STATUS, latestVersion: '1.3.0', updateAvailable: true } })} />);
      expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'update-available');
      await userEvent.click(screen.getByRole('button', { name: 'Update to v1.3.0' }));
      expect(h.onUpdate).toHaveBeenCalledWith(2);
    });

    it('does not offer the update to a session that cannot run it', () => {
      useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => true) });
      render(<NodeDetailsSheet {...baseProps({ updateStatus: { ...UPDATE_STATUS, latestVersion: '1.3.0', updateAvailable: true } })} />);
      expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'update-available');
      expect(screen.queryByRole('button', { name: /Update to/ })).not.toBeInTheDocument();
    });

    it('opens networking from the Answer verb, with no inline network detail', async () => {
      const h = handlers();
      render(<NodeDetailsSheet {...baseProps({ handlers: h, networkingSignal: { exposed: false, unknown: false, drift: true } })} />);
      await userEvent.click(screen.getByRole('button', { name: 'View networking' }));
      expect(h.onOpenNetworking).toHaveBeenCalledWith(2);
      expect(screen.queryByText(/subnet/i)).not.toBeInTheDocument();
    });

    it('says a Pilot is disconnected, drops the Resources tab, and offers Test connection', async () => {
      const seen = Math.floor(Date.now() / 1000) - 12 * 60;
      apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
      const h = handlers({ onTested: vi.fn() });
      render(
        <NodeDetailsSheet
          {...baseProps({
            handlers: h,
            node: fleetNode({ mode: 'pilot_agent', status: 'offline', stats: null, systemStats: null, pilot_last_seen: seen }),
            registryNode: registryNode({ mode: 'pilot_agent' }),
          })}
        />,
      );
      expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'offline');
      expect(screen.getByText('Pilot disconnected · last seen 12m ago')).toBeInTheDocument();
      expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Overview', 'Settings']);
      expect(screen.queryByText(/Unavailable while the node is offline/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await vi.waitFor(() => expect(h.onTested).toHaveBeenCalledTimes(1));
      expect(apiFetchMock).toHaveBeenCalledWith('/nodes/2/test', expect.objectContaining({ method: 'POST', localOnly: true }));
    });

    it('withholds Test connection from a user who cannot manage the node', () => {
      useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
      render(<NodeDetailsSheet {...baseProps({ node: fleetNode({ status: 'offline', stats: null, systemStats: null }) })} />);
      expect(screen.getByText(/Proxy unreachable/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    });

    it('offers Retry update on a failed update and a Dismiss action in the toolbar', async () => {
      const h = handlers();
      render(<NodeDetailsSheet {...baseProps({ handlers: h, updateStatus: { ...UPDATE_STATUS, updateStatus: 'failed', error: 'pull failed' } })} />);
      expect(screen.getByText('pull failed')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Retry update' }));
      expect(h.onRetryUpdate).toHaveBeenCalledWith(2);
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss update' }));
      expect(h.onDismissUpdate).toHaveBeenCalledWith(2);
    });
  });

  describe('toolbar', () => {
    it('keeps object-level actions in the toolbar: Edit node, Cordon, and Delete node', async () => {
      const h = handlers();
      render(<NodeDetailsSheet {...baseProps({ handlers: h })} />);
      await userEvent.click(screen.getByRole('button', { name: 'Edit node' }));
      expect(h.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
      expect(screen.getByRole('button', { name: 'Cordon node' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Delete node' }));
      expect(h.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    });

    it('hides Delete node for the default node and every manage action from a non-manager', () => {
      render(<NodeDetailsSheet {...baseProps({ registryNode: registryNode({ is_default: true }) })} />);
      expect(screen.queryByRole('button', { name: 'Delete node' })).not.toBeInTheDocument();

      useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
      const { unmount } = render(<NodeDetailsSheet {...baseProps()} />);
      unmount();
      render(<NodeDetailsSheet {...baseProps()} />);
      expect(screen.queryByRole('button', { name: 'Edit node' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cordon node' })).not.toBeInTheDocument();
    });

    it('carries Uncordon once, in the toolbar, and not as an Answer verb', () => {
      render(<NodeDetailsSheet {...baseProps({ node: fleetNode({ cordoned: true, cordoned_reason: 'patching' }) })} />);
      expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'cordoned');
      expect(screen.getAllByRole('button', { name: 'Uncordon node' })).toHaveLength(1);
    });

    it('offers the verbs of conditions the Answer does not speak for, so none is lost', async () => {
      const h = handlers();
      const critical = fleetNode({ systemStats: { cpu: { usage: '95.0', cores: 4 }, memory: { total: 100, used: 40, free: 60, usagePercent: '40.0' }, disk: { total: 100, used: 30, free: 70, usagePercent: '30.0' } } });
      render(<NodeDetailsSheet {...baseProps({
        handlers: h,
        node: critical,
        gitopsAttention: 2,
        networkingSignal: { exposed: false, unknown: false, drift: true },
        updateStatus: { ...UPDATE_STATUS, latestVersion: '1.3.0', updateAvailable: true },
      })} />);
      expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'critical');
      await userEvent.click(screen.getByRole('button', { name: 'View networking' }));
      expect(h.onOpenNetworking).toHaveBeenCalledWith(2);
      await userEvent.click(screen.getByRole('button', { name: 'Update to v1.3.0' }));
      expect(h.onUpdate).toHaveBeenCalledWith(2);
      expect(screen.getByRole('button', { name: 'Open GitOps' })).toBeInTheDocument();
    });

    it('keeps Retry update and Dismiss update for a failed update that a louder state outranks', async () => {
      const h = handlers();
      const critical = fleetNode({ systemStats: { cpu: { usage: '95.0', cores: 4 }, memory: { total: 100, used: 40, free: 60, usagePercent: '40.0' }, disk: { total: 100, used: 30, free: 70, usagePercent: '30.0' } } });
      render(<NodeDetailsSheet {...baseProps({ handlers: h, node: critical, updateStatus: { ...UPDATE_STATUS, updateStatus: 'failed', error: 'pull failed' } })} />);
      await userEvent.click(screen.getByRole('button', { name: 'Retry update' }));
      expect(h.onRetryUpdate).toHaveBeenCalledWith(2);
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss update' }));
      expect(h.onDismissUpdate).toHaveBeenCalledWith(2);
    });

    it('shows a timed-out update on an offline node on the Path with its error, and lets it be dismissed', async () => {
      const h = handlers();
      render(<NodeDetailsSheet {...baseProps({
        handlers: h,
        node: fleetNode({ status: 'offline', stats: null, systemStats: null }),
        updateStatus: { ...UPDATE_STATUS, updateStatus: 'timeout', error: 'node never returned' },
      })} />);
      expect(screen.getByTestId('status-answer')).toHaveAttribute('data-state', 'offline');
      expect(screen.getByText(/node never returned/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss update' }));
      expect(h.onDismissUpdate).toHaveBeenCalledWith(2);
    });
  });

  describe('tabs', () => {
    it('shows capacity and workload on Resources', async () => {
      render(<NodeDetailsSheet {...baseProps()} />);
      await userEvent.click(screen.getByRole('tab', { name: 'Resources' }));
      expect(screen.getByText(/Compose workload/)).toBeInTheDocument();
      expect(screen.getByText(/CPU · 4 cores/)).toBeInTheDocument();
    });

    it('shows labels and configuration on Settings, with the cordon reason as visible text', async () => {
      render(
        <NodeDetailsSheet
          {...baseProps({
            node: fleetNode({ cordoned: true, cordoned_reason: 'Host maintenance', cordoned_at: Date.UTC(2026, 6, 1) }),
          })}
        />,
      );
      await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
      expect(screen.getByTestId('node-label-picker')).toHaveTextContent('labels for 2 · editable=true');
      expect(screen.getByText('Host maintenance')).toBeInTheDocument();
      expect(screen.getByText(new Date(Date.UTC(2026, 6, 1)).toLocaleString())).toBeInTheDocument();
    });
  });

  it('reads the connection mode from the fleet payload when the registry row is missing, like the card', () => {
    render(<NodeDetailsSheet {...baseProps({
      registryNode: null,
      node: fleetNode({ mode: 'pilot_agent', status: 'offline', stats: null, systemStats: null }),
    })} />);
    expect(screen.getByText(/Pilot disconnected/)).toBeInTheDocument();
    expect(screen.getByText(/^Pilot Agent/)).toBeInTheDocument();
  });

  it('starts on Overview again when the sheet switches to another node', async () => {
    const { rerender } = render(<NodeDetailsSheet {...baseProps()} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    rerender(<NodeDetailsSheet {...baseProps({ node: fleetNode({ id: 3, name: 'Other' }), registryNode: registryNode({ id: 3, name: 'Other' }) })} />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('marks a skipped update on the Path instead of calling the node up to date', () => {
    render(<NodeDetailsSheet {...baseProps({ updateStatus: { ...UPDATE_STATUS, updateAvailable: true, skipActive: true } })} />);
    expect(screen.getByTestId('status-path')).toHaveTextContent('update skipped');
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });
});

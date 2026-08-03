import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const useNodesMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({ useNodes: () => useNodesMock() }));

// NodeLabelPicker is a fully self-fetching reused unit (its own tests cover its
// behavior); shallow-mock it here so this file stays focused on the sheet.
vi.mock('@/components/blueprints/NodeLabelPicker', () => ({
  NodeLabelPicker: ({ nodeId, canEdit }: { nodeId: number; canEdit: boolean }) => (
    <div data-testid="node-label-picker">labels for {nodeId} · editable={String(canEdit)}</div>
  ),
}));

import { NodeDetailsSheet } from '../NodeDetailsSheet';
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

function baseProps(overrides: Partial<React.ComponentProps<typeof NodeDetailsSheet>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    node: fleetNode(),
    registryNode: registryNode(),
    updateStatus: UPDATE_STATUS,
    networkingSignal: { exposed: false, unknown: false, drift: false },
    canManageNode: false,
    onOpenNetworking: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useNodesMock.mockReturnValue({ nodeMeta: new Map(), refreshNodeMeta: vi.fn() });
});
afterEach(() => vi.clearAllMocks());

describe('NodeDetailsSheet', () => {
  it('renders all sections from the node, registry, and update-status data', () => {
    render(<NodeDetailsSheet {...baseProps()} />);
    expect(screen.getByRole('heading', { name: 'Edge' })).toBeInTheDocument();
    expect(screen.getByText('Connectivity')).toBeInTheDocument();
    expect(screen.getByText('Capacity')).toBeInTheDocument();
    expect(screen.getByText(/Compose workload/)).toBeInTheDocument();
    expect(screen.getByText('Compatibility')).toBeInTheDocument();
    expect(screen.getByText('Governance')).toBeInTheDocument();
    expect(screen.getByText('42 ms')).toBeInTheDocument();
    expect(screen.getByTestId('node-label-picker')).toHaveTextContent('labels for 2 · editable=false');
  });

  it('renders cordon reason and date as visible text, not tooltip-only', () => {
    render(
      <NodeDetailsSheet
        {...baseProps({
          node: fleetNode({ cordoned: true, cordoned_reason: 'Host maintenance', cordoned_at: Date.UTC(2026, 6, 1) }),
        })}
      />,
    );
    expect(screen.getByText('Host maintenance')).toBeInTheDocument();
    expect(screen.getByText(new Date(Date.UTC(2026, 6, 1)).toLocaleString())).toBeInTheDocument();
  });

  it('shows token-configured as a yes/no badge and never renders a raw token value', () => {
    render(<NodeDetailsSheet {...baseProps({ registryNode: registryNode({ has_token: true }) })} />);
    expect(screen.getByText('Token configured')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.queryByText(/eyJ|Bearer /)).not.toBeInTheDocument();
  });

  it('reuses the existing networking handler instead of rendering networking detail inline', async () => {
    const onOpenNetworking = vi.fn();
    const user = userEvent.setup();
    render(
      <NodeDetailsSheet
        {...baseProps({
          onOpenNetworking,
          networkingSignal: { exposed: false, unknown: false, drift: true },
        })}
      />,
    );
    const badge = screen.getByText(/Networking/);
    await user.click(badge);
    expect(onOpenNetworking).toHaveBeenCalledWith(2);
    // No inline network detail (IPAM, subnet, etc.) is rendered by this sheet.
    expect(screen.queryByText(/subnet/i)).not.toBeInTheDocument();
  });

  it('shows a skeleton for capabilities until nodeMeta resolves, then renders the count', () => {
    useNodesMock.mockReturnValue({ nodeMeta: new Map(), refreshNodeMeta: vi.fn() });
    const { rerender } = render(<NodeDetailsSheet {...baseProps()} />);
    expect(screen.queryByText(/capabilities advertised/)).not.toBeInTheDocument();

    useNodesMock.mockReturnValue({
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

  it('converts FleetNode seconds-based timestamps correctly, not decades off', () => {
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
    // "just now" appears for both Last successful contact and Pilot heartbeat.
    // If the seconds value were passed straight to formatTimeAgo (which expects
    // ms), this would instead render something like "20647d ago".
    expect(screen.getAllByText('just now').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/d ago/)).not.toBeInTheDocument();
  });

  it('omits Last successful contact for the local node instead of showing Never', () => {
    render(<NodeDetailsSheet {...baseProps({ node: fleetNode({ type: 'local', last_successful_contact: null }) })} />);
    expect(screen.queryByText('Last successful contact')).not.toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });

  it('renders Update status as Unknown, never a confident Up to date, when updateStatus is absent', () => {
    render(<NodeDetailsSheet {...baseProps({ updateStatus: undefined })} />);
    const updateStatusLabel = screen.getByText('Update status');
    const updateStatusField = updateStatusLabel.parentElement as HTMLElement;
    expect(within(updateStatusField).getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
  });

  it('still renders Up to date when updateStatus confirms no update is available', () => {
    render(<NodeDetailsSheet {...baseProps({ updateStatus: { ...UPDATE_STATUS, updateAvailable: false } })} />);
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });
});

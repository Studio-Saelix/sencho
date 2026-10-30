/**
 * Mobile Fleet has no update capability at all before this change (it only
 * polled /fleet/overview). These tests confirm it now shows the persistent
 * "Integration image" marker for any role, exposes the dev-build update
 * action only to admins as a sibling of the card's own <button> (never
 * nested inside it), and routes through the same shared confirm dialog and
 * update trigger desktop uses (no parallel API implementation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { FleetNode, NodeUpdateStatus } from '@/components/FleetView/types';

const apiFetchMock = vi.fn();
const useAuthMock = vi.fn();
const useNodesMock = vi.fn();

vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => useNodesMock() }));
vi.mock('@/lib/nodesApi', () => ({ cordonNode: vi.fn(), uncordonNode: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { MobileFleet } from '../MobileFleet';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function makeNode(overrides: Partial<FleetNode> = {}): FleetNode {
  return {
    id: 1, name: 'Local', type: 'local', status: 'online',
    stats: { active: 1, managed: 1, unmanaged: 0, exited: 0, total: 1 },
    systemStats: { cpu: { usage: '10.0', cores: 4 }, memory: { total: 100, used: 20, free: 80, usagePercent: '20.0' }, disk: { total: 100, used: 10, free: 90, usagePercent: '10.0' } },
    stacks: ['web'], cordoned: false, cordoned_at: null, cordoned_reason: null,
    ...overrides,
  } as FleetNode;
}

function makeUpdateStatus(overrides: Partial<NodeUpdateStatus> = {}): NodeUpdateStatus {
  return {
    nodeId: 1, name: 'Local', type: 'local', version: '1.0.0', latestVersion: '1.1.0',
    online: true,
    updateAvailable: false, updateStatus: null,
    ...overrides,
  };
}

function setupFetch(nodes: FleetNode[], statuses: NodeUpdateStatus[]) {
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === '/fleet/overview') return okJson(nodes);
    if (url === '/fleet/update-status') return okJson({ nodes: statuses });
    if (url.startsWith('/fleet/nodes/')) return okJson({ message: 'ok' });
    return okJson({});
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  useAuthMock.mockReturnValue({ isAdmin: true, can: vi.fn(() => true) });
  useNodesMock.mockReturnValue({ nodes: [], activeNode: null, hasCapability: vi.fn(() => false) });
});
afterEach(() => vi.clearAllMocks());

describe('MobileFleet dev-build capability', () => {
  it('shows the Integration image marker for a viewer (non-admin)', async () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
    setupFetch([makeNode()], [makeUpdateStatus({ isDevImage: true, devBuildUpdateAvailable: false })]);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    expect(await screen.findByText(/integration/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update dev build/i })).not.toBeInTheDocument();
  });

  it('does not show the marker for a non-dev node', async () => {
    setupFetch([makeNode()], [makeUpdateStatus({ isDevImage: false })]);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    await screen.findByText('Local');
    expect(screen.queryByText(/integration/i)).not.toBeInTheDocument();
  });

  it('shows the dev-build update action as a sibling of the card, not nested inside its button, for an admin', async () => {
    setupFetch([makeNode()], [makeUpdateStatus({ isDevImage: true, devBuildUpdateAvailable: true })]);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    const updateButton = await screen.findByRole('button', { name: /Update dev build/i });
    const cardButton = screen.getByRole('button', { name: /Local/i });
    expect(updateButton).not.toBe(cardButton);
    // A <button> cannot legally contain another <button>; assert the update
    // action is not a DOM descendant of the card's own button.
    expect(cardButton.contains(updateButton)).toBe(false);
  });

  it('hides the dev-build update action for a non-admin while keeping the marker', async () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
    setupFetch([makeNode()], [makeUpdateStatus({ isDevImage: true, devBuildUpdateAvailable: true })]);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    await screen.findByText(/integration/i);
    expect(screen.queryByRole('button', { name: /Update dev build/i })).not.toBeInTheDocument();
  });

  it('hides the dev-build update action when no build is available', async () => {
    setupFetch([makeNode()], [makeUpdateStatus({ isDevImage: true, devBuildUpdateAvailable: false })]);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    await screen.findByText(/integration/i);
    expect(screen.queryByRole('button', { name: /Update dev build/i })).not.toBeInTheDocument();
  });

  it('hides the dev-build update action while an update is already in flight', async () => {
    setupFetch([makeNode()], [makeUpdateStatus({ isDevImage: true, devBuildUpdateAvailable: true, updateStatus: 'updating' })]);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    await screen.findByText(/integration/i);
    expect(screen.queryByRole('button', { name: /Update dev build/i })).not.toBeInTheDocument();
  });

  it('hides the dev-build update action for an offline node', async () => {
    setupFetch([makeNode({ status: 'offline' })], [makeUpdateStatus({ isDevImage: true, devBuildUpdateAvailable: true })]);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    await screen.findByText(/integration/i);
    expect(screen.queryByRole('button', { name: /Update dev build/i })).not.toBeInTheDocument();
  });

  it('tapping the update action opens the shared confirm dialog with dev copy', async () => {
    setupFetch([makeNode()], [makeUpdateStatus({ isDevImage: true, devBuildUpdateAvailable: true })]);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    const updateButton = await screen.findByRole('button', { name: /Update dev build/i });
    fireEvent.click(updateButton);

    expect(await screen.findByText('LOCAL · DEV UPDATE')).toBeInTheDocument();
    expect(screen.getByText(/image reference is not rewritten/i)).toBeInTheDocument();
  });

  it('confirming the dialog triggers the update with targetVersion omitted and shows the reconnect overlay', async () => {
    setupFetch([makeNode()], [makeUpdateStatus({ isDevImage: true, devBuildUpdateAvailable: true, latestVersion: '9.9.9' })]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ startedAt: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )));

    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Update dev build/i }));
    await screen.findByText('LOCAL · DEV UPDATE');

    apiFetchMock.mockClear();
    apiFetchMock.mockImplementation(async () => okJson({ message: 'ok' }));
    fireEvent.click(screen.getByRole('button', { name: /Update & restart/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/fleet/nodes/1/update',
        expect.objectContaining({ method: 'POST', localOnly: true }),
      );
    });
    const call = apiFetchMock.mock.calls.find(([url]) => url === '/fleet/nodes/1/update');
    expect(call![1]).not.toHaveProperty('body');
    expect(await screen.findByText(/restarting/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe('MobileFleet node identity', () => {
  const edge = (overrides: Partial<FleetNode> = {}) =>
    makeNode({ id: 2, name: 'Edge', type: 'remote', ...overrides });

  it('pins Local, Proxy and Pilot with the same labels as the desktop card', async () => {
    setupFetch(
      [makeNode(), edge({ mode: 'proxy' }), edge({ id: 3, name: 'Tunnel', mode: 'pilot_agent' })],
      [],
    );
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    expect(await screen.findByText('★ Local')).toBeInTheDocument();
    expect(screen.getByText('Proxy')).toBeInTheDocument();
    expect(screen.getByText('Pilot')).toBeInTheDocument();
  });

  it('shows no state word on a healthy node and no separate you-are-here chip', async () => {
    setupFetch([makeNode(), edge()], []);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    await screen.findByText('★ Local');
    expect(screen.queryByText(/^online$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/you are here/i)).not.toBeInTheDocument();
  });

  it('prefers the registry connection mode over the fleet payload', async () => {
    useNodesMock.mockReturnValue({
      nodes: [{ id: 2, name: 'Edge', type: 'remote', mode: 'proxy' }],
      activeNode: null,
      hasCapability: vi.fn(() => false),
    });
    setupFetch([edge({ mode: 'pilot_agent' })], []);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    expect(await screen.findByText('Proxy')).toBeInTheDocument();
    expect(screen.queryByText('Pilot')).not.toBeInTheDocument();
  });

  it('says offline and cordoned together for an offline cordoned node, keeping its pin', async () => {
    setupFetch([edge({ mode: 'pilot_agent', status: 'offline', cordoned: true })], []);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    expect(await screen.findByText('offline · cordoned')).toHaveClass('text-destructive');
    expect(screen.getByText('Pilot')).toBeInTheDocument();
  });

  it('names the connection, not local or remote, in the node detail meta line', async () => {
    // The detail screen mounts NodeDetailsSheet, which reads nodeMeta from the node context.
    useNodesMock.mockReturnValue({ nodes: [], activeNode: null, nodeMeta: new Map(), hasCapability: vi.fn(() => false) });
    setupFetch([edge({ mode: 'pilot_agent' })], []);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Edge/ }));
    expect(await screen.findByText(/^pilot · 1 stacks/)).toBeInTheDocument();
  });

  it('prefers the registry connection mode in the node detail meta line', async () => {
    useNodesMock.mockReturnValue({
      nodes: [{ id: 2, name: 'Edge', type: 'remote', mode: 'proxy' }],
      activeNode: null,
      nodeMeta: new Map(),
      hasCapability: vi.fn(() => false),
    });
    setupFetch([edge({ mode: 'pilot_agent' })], []);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Edge/ }));
    expect(await screen.findByText(/^proxy · 1 stacks/)).toBeInTheDocument();
  });

  it('marks an online node over the threshold critical, and a cordoned healthy node cordoned', async () => {
    const hot = { cpu: { usage: '97.0', cores: 4 } };
    setupFetch(
      [
        makeNode({ systemStats: { ...makeNode().systemStats!, ...hot } }),
        edge({ mode: 'proxy', cordoned: true }),
      ],
      [],
    );
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    expect(await screen.findByText('critical')).toHaveClass('text-warning');
    expect(screen.getByText('cordoned')).toHaveClass('text-warning');
    expect(screen.queryByText(/offline/)).not.toBeInTheDocument();
    // Only the cordoned node is online and not critical, so only its dot announces Online.
    expect(screen.getAllByRole('img', { name: 'Online' })).toHaveLength(1);
  });

  it('gives a healthy node dot an accessible status, since it carries no state word', async () => {
    setupFetch([edge({ mode: 'proxy' })], []);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    expect(await screen.findByRole('img', { name: 'Online' })).toBeInTheDocument();
  });

  it('gives no accessible online status to an offline node', async () => {
    setupFetch([edge({ mode: 'proxy', status: 'offline' })], []);
    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    await screen.findByText('offline');
    expect(screen.queryByRole('img', { name: 'Online' })).not.toBeInTheDocument();
  });
});

describe('MobileFleet crowded node row', () => {
  const hot = { cpu: { usage: '97.0', cores: 4 } };

  // The row wraps its metadata instead of shrinking the name, whatever adds
  // width: the pin, an exception word, the active or integration chip, or a
  // name that already fills the card. jsdom has no layout, so the contract is
  // asserted on the classes that decide it: the name keeps its content width
  // (shrink-0) and only ellipsizes when it alone is wider than the row
  // (max-w-full), while the row is a wrapping flex line.
  const cases: Array<{
    label: string;
    name: string;
    pin: string;
    node: Partial<FleetNode>;
    active?: boolean;
    devImage?: boolean;
  }> = [
    {
      label: 'the Local pin',
      name: 'sencho-test-01',
      pin: '★ Local',
      node: { type: 'local' },
    },
    {
      label: 'the Proxy pin',
      name: 'sencho-test-01',
      pin: 'Proxy',
      node: { type: 'remote', mode: 'proxy' },
    },
    {
      label: 'the Pilot pin and two exception words',
      name: 'sencho-test-01',
      pin: 'Pilot',
      node: { type: 'remote', mode: 'pilot_agent', status: 'offline', cordoned: true },
    },
    {
      label: 'a critical cordoned node',
      name: 'sencho-test-01',
      pin: 'Proxy',
      node: { type: 'remote', mode: 'proxy', cordoned: true, systemStats: { ...makeNode().systemStats!, ...hot } },
    },
    {
      label: 'the active and integration chips',
      name: 'sencho-test-01',
      pin: 'Proxy',
      node: { type: 'remote', mode: 'proxy' },
      active: true,
      devImage: true,
    },
    {
      label: 'a name that fills the card',
      name: 'sencho-test-01-primary-eu-west',
      pin: 'Pilot',
      node: { type: 'remote', mode: 'pilot_agent', status: 'offline', cordoned: true },
    },
  ];

  it.each(cases)('keeps the name legible with $label', async ({ name, pin, node, active, devImage }) => {
    const fleetNode = makeNode({ id: 2, name, type: 'remote', ...node });
    if (active) {
      useNodesMock.mockReturnValue({
        nodes: [{ id: 2, name, type: 'remote', mode: 'proxy' }],
        activeNode: { id: 2, name },
        hasCapability: vi.fn(() => false),
      });
    }
    setupFetch([fleetNode], devImage ? [makeUpdateStatus({ nodeId: 2, isDevImage: true })] : []);

    render(<MobileFleet headerActions={null} onInspectNode={vi.fn()} onInspectStack={vi.fn()} />);

    const nodeName = await screen.findByText(name);
    expect(nodeName).toHaveClass('shrink-0', 'max-w-full', 'truncate');
    expect(nodeName).not.toHaveClass('min-w-24', 'flex-1');
    expect(nodeName.parentElement).toHaveClass('flex-wrap');
    // The pin and every qualifier wrap as one block below the name, so a
    // crowded row never strands the pin on a line of its own.
    const meta = nodeName.nextElementSibling;
    expect(meta).toHaveClass('flex-wrap', 'min-w-0');
    expect(meta).toContainElement(screen.getByText(pin));
  });
});

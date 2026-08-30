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

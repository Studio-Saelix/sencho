import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Node } from '@/context/NodeContext';

// NodeManager pulls in several contexts and a child action hook. Mock them so
// the test renders the panel in isolation and can drive the role/permission
// inputs that gate the write affordances.
const useAuthMock = vi.fn();
const { experimentalState, apiFetchMock, nodesRef } = vi.hoisted(() => ({
  experimentalState: { experimental: false, experimentalReady: true },
  apiFetchMock: vi.fn(),
  nodesRef: { current: [] as unknown[] },
}));

const testNode: Node = {
  id: 2,
  name: 'Edge',
  type: 'remote',
  mode: 'pilot_agent',
  compose_dir: '/app/compose',
  is_default: false,
  status: 'online',
  created_at: 0,
  api_url: '',
  pilot_last_seen: Date.now(),
};

nodesRef.current = [testNode];

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: nodesRef.current, refreshNodes: vi.fn(() => Promise.resolve()), refreshNodeMeta: vi.fn() }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/hooks/useExperimental', () => ({ useExperimental: () => experimentalState }));
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/hooks/useFleetSyncStatus', () => ({
  useFleetSyncStatus: () => ({ statuses: [], refresh: vi.fn() }),
}));
vi.mock('../settings/MastheadStatsContext', () => ({ useMastheadStats: vi.fn() }));
vi.mock('../nodes/useNodeActions', () => ({
  useNodeActions: () => ({
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    openDelete: vi.fn(),
    NodeActionModals: null,
  }),
}));
vi.mock('../blueprints/NodeLabelPicker', () => ({ NodeLabelPicker: () => null }));

import { NodeManager } from '../NodeManager';

/** can() that grants only the named action regardless of resource scope. */
function canFor(...granted: string[]) {
  return (action: string) => granted.includes(action);
}

beforeEach(() => {
  apiFetchMock.mockImplementation(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
});

afterEach(() => {
  vi.clearAllMocks();
  nodesRef.current = [testNode];
  experimentalState.experimental = false;
  experimentalState.experimentalReady = true;
});

describe('NodeManager write-affordance gating', () => {
  it('hides every write affordance from a viewer but still shows the node table', () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: canFor() });
    render(<NodeManager />);

    // Read-only surface stays visible.
    expect(screen.getByText('Edge')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Add node/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Generate Node Token')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit node' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete node' })).not.toBeInTheDocument();
  });

  it('shows every affordance to an admin', () => {
    useAuthMock.mockReturnValue({ isAdmin: true, can: canFor('node:manage') });
    render(<NodeManager />);

    expect(screen.getByRole('button', { name: /Add node/i })).toBeInTheDocument();
    expect(screen.getByText('Generate Node Token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit node' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete node' })).toBeInTheDocument();
    // Bootstrap is experimental, so an admin sees it only when the flag is on.
    expect(screen.queryByRole('button', { name: 'Bootstrap new Linux server' })).not.toBeInTheDocument();
  });

  it('shows Bootstrap to an admin when the experimental flag is on', () => {
    experimentalState.experimental = true;
    useAuthMock.mockReturnValue({ isAdmin: true, can: canFor('node:manage') });
    render(<NodeManager />);

    expect(screen.getByRole('button', { name: 'Bootstrap new Linux server' })).toBeInTheDocument();
  });

  it('hides Bootstrap while the experimental flag is still loading', () => {
    experimentalState.experimental = true;
    experimentalState.experimentalReady = false;
    useAuthMock.mockReturnValue({ isAdmin: true, can: canFor('node:manage') });
    render(<NodeManager />);

    expect(screen.queryByRole('button', { name: 'Bootstrap new Linux server' })).not.toBeInTheDocument();
  });

  it('hides Bootstrap from a node-admin even when the experimental flag is on', () => {
    experimentalState.experimental = true;
    useAuthMock.mockReturnValue({ isAdmin: false, can: canFor('node:manage') });
    render(<NodeManager />);

    expect(screen.queryByRole('button', { name: 'Bootstrap new Linux server' })).not.toBeInTheDocument();
  });

  it('lets a node-admin manage nodes but hides the admin-only token card', () => {
    // node-admin: holds node:manage but is not a global admin.
    useAuthMock.mockReturnValue({ isAdmin: false, can: canFor('node:manage') });
    render(<NodeManager />);

    expect(screen.getByRole('button', { name: /Add node/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit node' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete node' })).toBeInTheDocument();
    // Generate Node Token mirrors requireAdmin, so a node-admin must not see it.
    expect(screen.queryByText('Generate Node Token')).not.toBeInTheDocument();
  });
});

const pinnedRemote: Node = { ...testNode, sealingKeyFingerprint: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=' };
const localNode: Node = { ...testNode, id: 1, name: 'Local', type: 'local', mode: 'proxy', is_default: true };

describe('NodeManager sealing key affordance', () => {
  it('with the experimental flag off, keeps the Seal line and its one-click reset', async () => {
    nodesRef.current = [localNode, pinnedRemote];
    useAuthMock.mockReturnValue({ isAdmin: true, can: canFor('node:manage') });
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) =>
      Promise.resolve({ ok: init?.method === 'DELETE' && path === '/nodes/2/sealing-key', json: () => Promise.resolve({}) }));
    render(<NodeManager />);

    expect(screen.getByText('Seal abcdefghijkl…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sealing key/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reset seal pin' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/nodes/2/sealing-key', { method: 'DELETE', localOnly: true }));
    // One click, no confirmation dialog.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('with the flag on, offers Sealing key on local and remote rows instead of the Seal line', () => {
    nodesRef.current = [localNode, pinnedRemote];
    experimentalState.experimental = true;
    experimentalState.experimentalReady = true;
    useAuthMock.mockReturnValue({ isAdmin: true, can: canFor('node:manage') });
    render(<NodeManager />);

    expect(screen.getAllByRole('button', { name: /Sealing key/ })).toHaveLength(2);
    expect(screen.queryByText(/^Seal /)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset seal pin' })).not.toBeInTheDocument();
  });

  it('with the flag on, opens the sheet for the row and reads that node', async () => {
    nodesRef.current = [localNode, pinnedRemote];
    experimentalState.experimental = true;
    experimentalState.experimentalReady = true;
    useAuthMock.mockReturnValue({ isAdmin: true, can: canFor('node:manage') });
    apiFetchMock.mockImplementation((path: string) =>
      path === '/nodes/1/sealing-key'
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ kind: 'local', fingerprint: 'LOCALFP' }) })
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    render(<NodeManager />);

    await userEvent.click(screen.getAllByRole('button', { name: /Sealing key/ })[0]);
    expect(await screen.findByText('LOCALFP')).toBeInTheDocument();
  });

  it('with the flag on, reads the remote row it opened', async () => {
    nodesRef.current = [localNode, pinnedRemote];
    experimentalState.experimental = true;
    experimentalState.experimentalReady = true;
    useAuthMock.mockReturnValue({ isAdmin: true, can: canFor('node:manage') });
    apiFetchMock.mockImplementation((path: string) =>
      path === '/nodes/2/sealing-key'
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ kind: 'remote', readiness: 'ready', pinned: null, presented: { fingerprint: 'REMOTEFP' } }) })
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    render(<NodeManager />);

    await userEvent.click(screen.getAllByRole('button', { name: /Sealing key/ })[1]);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/nodes/2/sealing-key', { localOnly: true }));
  });

  it('with the flag on, hides the trigger from a session that cannot manage the node', () => {
    nodesRef.current = [localNode, pinnedRemote];
    experimentalState.experimental = true;
    experimentalState.experimentalReady = true;
    useAuthMock.mockReturnValue({ isAdmin: false, can: canFor() });
    render(<NodeManager />);

    expect(screen.queryByRole('button', { name: /Sealing key/ })).not.toBeInTheDocument();
  });
});

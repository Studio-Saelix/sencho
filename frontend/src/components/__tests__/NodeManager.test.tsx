import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Node } from '@/context/NodeContext';

// NodeManager pulls in several contexts and a child action hook. Mock them so
// the test renders the panel in isolation and can drive the role/permission
// inputs that gate the write affordances.
const useAuthMock = vi.fn();
const useLicenseMock = vi.fn();

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

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: [testNode], refreshNodeMeta: vi.fn() }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => useLicenseMock() }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })),
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
  useLicenseMock.mockReturnValue({ isPaid: false });
});
afterEach(() => vi.clearAllMocks());

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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const useLicenseMock = vi.fn();
const useAuthMock = vi.fn();
const useNodesMock = vi.fn();

vi.mock('@/context/LicenseContext', () => ({ useLicense: () => useLicenseMock() }));
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
  return { node, onNavigate: vi.fn() };
}

beforeEach(() => {
  useNodesMock.mockReturnValue({ nodes: [] });
  useAuthMock.mockReturnValue({ isAdmin: true });
  useLicenseMock.mockReturnValue({ isPaid: false, license: null });
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

  it('hides the actions menu for a non-admiral user', () => {
    useLicenseMock.mockReturnValue({ isPaid: true, license: { variant: 'skipper' } });
    render(<NodeCard {...baseProps(onlineNode())} />);
    expect(screen.queryByRole('button', { name: 'Node actions' })).not.toBeInTheDocument();
  });

  it('exposes the actions menu (cordon entry point) for an admiral user', () => {
    useLicenseMock.mockReturnValue({ isPaid: true, license: { variant: 'admiral' } });
    render(<NodeCard {...baseProps(onlineNode())} />);
    // The actions menu only renders when cordon (admiral-only here) is available.
    expect(screen.getByRole('button', { name: 'Node actions' })).toBeInTheDocument();
  });
});

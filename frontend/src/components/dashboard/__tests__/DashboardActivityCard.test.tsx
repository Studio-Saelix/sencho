import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as NodeContext from '@/context/NodeContext';
import * as AuthContext from '@/context/AuthContext';
import { DashboardActivityCard } from '../DashboardActivityCard';

vi.mock('@/context/NodeContext');
vi.mock('@/context/AuthContext');
vi.mock('../FleetHeartbeat', () => ({ FleetHeartbeat: () => <div data-testid="fleet-heartbeat" /> }));
vi.mock('../StackRestartMap', () => ({ StackRestartMap: () => <div data-testid="stack-restart-map" /> }));

function setup(opts: { remote: boolean; nodeRead: boolean }) {
  vi.mocked(NodeContext.useNodes).mockReturnValue({
    nodes: opts.remote ? [{ type: 'remote' }, { type: 'local' }] : [{ type: 'local' }],
  } as unknown as ReturnType<typeof NodeContext.useNodes>);
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    can: (p: string) => opts.nodeRead && p === 'node:read',
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
}

describe('DashboardActivityCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the fleet heartbeat for a multi-node fleet when the user has node:read', () => {
    setup({ remote: true, nodeRead: true });
    render(<DashboardActivityCard />);
    expect(screen.getByTestId('fleet-heartbeat')).toBeInTheDocument();
  });

  it('falls back to the restart map for a multi-node fleet without node:read (deployer)', () => {
    setup({ remote: true, nodeRead: false });
    render(<DashboardActivityCard />);
    expect(screen.getByTestId('stack-restart-map')).toBeInTheDocument();
    expect(screen.queryByTestId('fleet-heartbeat')).not.toBeInTheDocument();
  });

  it('shows the restart map for a single-node setup regardless of node:read', () => {
    setup({ remote: false, nodeRead: true });
    render(<DashboardActivityCard />);
    expect(screen.getByTestId('stack-restart-map')).toBeInTheDocument();
  });
});

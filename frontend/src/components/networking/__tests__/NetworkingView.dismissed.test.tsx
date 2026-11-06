/**
 * The dismissed count on Networking opens one sheet from both tabs that show it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true, can: () => true }),
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: { id: 1, name: 'local', type: 'local' } }),
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useDeveloperMode', () => ({ useDeveloperMode: () => false }));
vi.mock('@/hooks/useNetworkingDismissals', () => ({
  useNetworkingDismissals: () => ({ dismissals: [], dismiss: vi.fn(), restore: vi.fn(), isPending: () => false }),
}));

import { NetworkingView } from '../NetworkingView';

function overview(findings: object[]): Response {
  return new Response(JSON.stringify({
    schemaVersion: 3,
    runtimeAvailable: true,
    overview: {
      networkCount: 0, exposedStackCount: 0, unknownExposureStackCount: 0, missingExternalCount: 0,
      networkCollisionCount: 0, renderFailedStacks: [], needsActionCount: 0, reviewCount: 0, driftCount: 0,
    },
    networks: [],
    findings,
    recentActivity: [],
  }), { status: 200 });
}

const acknowledged = {
  id: 'f1', kind: 'unknown-exposure', severity: 'medium', title: 'Port exposure unclear for stack app-1', message: 'm',
  stack: 'app-1', evidence: [], recommendedActions: [], sources: [], doctorFindings: [],
  fingerprint: 'fp1', count: 1, dismissPolicy: 'any', acknowledged: true,
};

beforeEach(() => apiFetchMock.mockReset());

describe('NetworkingView dismissed sheet', () => {
  it('opens from the Overview count, crumbed to Overview', async () => {
    apiFetchMock.mockResolvedValue(overview([acknowledged]));
    const user = userEvent.setup();
    render(<NetworkingView />);

    await user.click(await screen.findByRole('button', { name: '1 dismissed' }));
    expect(await screen.findByText('Dismissed findings')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Port exposure unclear for stack app-1')).toBeInTheDocument();
    expect(screen.getByText('acknowledged in Compose Doctor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('shows no count when nothing is dismissed', async () => {
    apiFetchMock.mockResolvedValue(overview([]));
    render(<NetworkingView />);
    await screen.findByText(/no networking issues detected/i);
    expect(screen.queryByRole('button', { name: /dismissed/ })).toBeNull();
  });
});

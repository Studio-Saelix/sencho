/**
 * The Cloudflare account is a tab of the Networking strip, not a block above it:
 * the tab exists only for an Admin with the experimental flag on, its label
 * carries a dot when the connection needs attention, and the network toolbar
 * steps aside on it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const flags = vi.hoisted(() => ({ experimental: true }));
vi.mock('@/hooks/useExperimental', () => ({
  useExperimental: () => ({ experimental: flags.experimental, experimentalReady: true }),
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

const T = Date.UTC(2026, 10, 19);

function respond(account: object) {
  apiFetchMock.mockImplementation((path: string) => Promise.resolve(new Response(JSON.stringify(
    path === '/public-exposure/account' ? account : {
      schemaVersion: 3,
      runtimeAvailable: true,
      overview: {
        networkCount: 0, exposedStackCount: 0, unknownExposureStackCount: 0, missingExternalCount: 0,
        networkCollisionCount: 0, renderFailedStacks: [], needsActionCount: 0, reviewCount: 0, driftCount: 0,
      },
      networks: [],
      findings: [],
      recentActivity: [],
    },
  ), { status: 200 })));
}

const connected = (outcome: string) => ({
  connected: true, provider: 'cloudflare-tunnel', accountId: 'a1'.repeat(16), accountName: 'Example',
  scopes: { zoneRead: 'confirmed', tunnel: 'unconfirmed' }, lastCheck: { outcome, at: T, detail: null },
  verifiedAt: T, connectedBy: 'admin', connectedAt: T, zonesVisible: 0, zones: [], nodeEndpointCount: 0,
});

beforeEach(() => { apiFetchMock.mockReset(); flags.experimental = true; });

describe('NetworkingView Cloudflare tab', () => {
  it('has no tab and makes no account request without the experimental flag', async () => {
    flags.experimental = false;
    respond({ connected: false });
    render(<NetworkingView />);

    await screen.findByRole('tab', { name: /Findings/ });
    expect(screen.queryByRole('tab', { name: /Cloudflare/ })).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalledWith('/public-exposure/account', expect.anything());
  });

  it('shows the account inside the tab, with no dot for an account that is not connected yet, and hides the network toolbar', async () => {
    respond({ connected: false });
    const user = userEvent.setup();
    render(<NetworkingView />);

    expect(await screen.findByRole('button', { name: 'Create network' })).toBeInTheDocument();
    expect(screen.queryByTestId('cloudflare-account-card')).toBeNull();

    await user.click(await screen.findByRole('tab', { name: /Cloudflare/ }));
    expect(await screen.findByTestId('cloudflare-account-card')).toBeInTheDocument();
    expect(screen.queryByTestId('cloudflare-tab-attention')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create network' })).toBeNull();
  });

  it('marks the tab label when the connection needs attention', async () => {
    respond(connected('token_invalid'));
    render(<NetworkingView />);

    expect(await screen.findByTestId('cloudflare-tab-attention')).toBeInTheDocument();
  });
});

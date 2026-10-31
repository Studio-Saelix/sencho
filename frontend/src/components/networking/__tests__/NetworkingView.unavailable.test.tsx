/**
 * Networking against an unreachable node.
 *
 * The page used to end a failed read with a toast and then draw its cards from
 * an empty overview, which reads as a clean node with zero networks. A node that
 * missed its read deadline now says so, with a retry, and shows no counts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: false, can: () => false }),
}));

const nodeState: { activeNode: { id: number; name: string; type: string } | null } = {
  activeNode: { id: 7, name: 'edge-1', type: 'remote' },
};
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: nodeState.activeNode }),
}));

vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useDeveloperMode', () => ({ useDeveloperMode: () => false }));
vi.mock('@/hooks/useNetworkingDismissals', () => ({
  useNetworkingDismissals: () => ({
    dismissals: [],
    dismiss: vi.fn(),
    restore: vi.fn(),
    isPending: () => false,
  }),
}));

import { NetworkingView } from '../NetworkingView';

/** The 504 the gateway sends when an interactive read misses its deadline. */
function readDeadline(): Response {
  return new Response(JSON.stringify({ error: 'did not answer', code: 'remote_read_timeout' }), {
    status: 504,
    headers: { 'x-sencho-read-timeout': '1' },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  nodeState.activeNode = { id: 7, name: 'edge-1', type: 'remote' };
});

describe('NetworkingView unavailable state', () => {
  it('names the node that did not answer instead of drawing empty counts', async () => {
    apiFetchMock.mockResolvedValue(readDeadline());

    render(<NetworkingView />);

    expect(await screen.findByText(/networking did not load/i)).toBeInTheDocument();
    expect(screen.getByText(/"edge-1" did not answer in time/i)).toBeInTheDocument();
    // No cards, no zero counts: the page never draws what it did not read.
    expect(screen.queryByText(/needs action/i)).toBeNull();
  });

  it('retries the overview when the operator asks again', async () => {
    apiFetchMock.mockResolvedValue(readDeadline());
    const user = userEvent.setup();

    render(<NetworkingView />);
    await screen.findByText(/networking did not load/i);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('still reports an older node that does not serve the page as unsupported', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));

    render(<NetworkingView />);

    expect(await screen.findByText(/not available on this node/i)).toBeInTheDocument();
    expect(screen.queryByText(/networking did not load/i)).toBeNull();
  });

  it('classifies a thrown 401 instead of reporting a generic transport failure', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), {
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });
    apiFetchMock.mockRejectedValue(unauthorized);

    render(<NetworkingView />);

    expect(await screen.findByText(/networking did not load/i)).toBeInTheDocument();
    expect(screen.getByText(/do not have access to this data/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed before the node answered/i)).toBeNull();
  });
});

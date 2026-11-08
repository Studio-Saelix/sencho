/**
 * The dismissed count on Networking opens one sheet from both tabs that show it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true, can: () => true }),
}));
const nodes = vi.hoisted(() => ({ activeId: 1 }));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: { id: nodes.activeId, name: 'local', type: 'local' } }),
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
  stack: 'app-1', evidence: [], recommendedActions: [], sources: [],
  doctorFindings: [{ ruleId: 'rule-a', message: 'm', acknowledgement: { id: 9 } }],
  fingerprint: 'fp1', count: 1, dismissPolicy: 'any', acknowledged: true,
};

beforeEach(() => { apiFetchMock.mockReset(); nodes.activeId = 1; });

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

  it('opens from the Findings count, crumbed to Findings', async () => {
    apiFetchMock.mockResolvedValue(overview([acknowledged]));
    const user = userEvent.setup();
    render(<NetworkingView />);

    await user.click(await screen.findByRole('tab', { name: /Findings/ }));
    await user.click(await screen.findByRole('button', { name: '1 dismissed' }));
    expect(within(await screen.findByRole('dialog')).getByText('Findings')).toBeInTheDocument();
    expect(screen.getByText('Port exposure unclear for stack app-1')).toBeInTheDocument();
  });

  it('restores an acknowledged finding from the sheet and says it is updating while the list is re-read', async () => {
    let finishRead: (response: Response) => void = () => {};
    let reads = 0;
    apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === 'DELETE' || path !== '/networking/overview') return Promise.resolve(new Response(null, { status: 204 }));
      reads += 1;
      return reads === 1 ? Promise.resolve(overview([acknowledged])) : new Promise<Response>(resolve => { finishRead = resolve; });
    });
    const user = userEvent.setup();
    render(<NetworkingView />);

    await user.click(await screen.findByRole('button', { name: '1 dismissed' }));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(apiFetchMock).toHaveBeenCalledWith('/stacks/app-1/preflight/acknowledgements/9', expect.objectContaining({ method: 'DELETE' }));
    expect(await screen.findByText('Updating the list…')).toBeInTheDocument();
    expect(screen.queryByText('Nothing is dismissed.')).toBeNull();
    finishRead(overview([]));
    expect(await screen.findByText('Nothing is dismissed.')).toBeInTheDocument();
  });

  it.each([
    ['an HTTP error', () => Promise.resolve(new Response('{}', { status: 502 })), /retry/i],
    ['a thrown error', () => Promise.reject(new Error('network down')), /retry/i],
  ])('does not reopen the sheet by itself after %s on a re-read recovers', async (_label, failure, retry) => {
    let reads = 0;
    apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === 'DELETE' || path !== '/networking/overview') return Promise.resolve(new Response(null, { status: 204 }));
      reads += 1;
      return reads === 2 ? failure() : Promise.resolve(overview([acknowledged]));
    });
    const user = userEvent.setup();
    render(<NetworkingView />);

    await user.click(await screen.findByRole('button', { name: '1 dismissed' }));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    await user.click(await screen.findByRole('button', { name: retry }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: '1 dismissed' })).toBeInTheDocument();
  });

  it('closes the sheet when the node turns out not to support Networking', async () => {
    let reads = 0;
    apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === 'DELETE' || path !== '/networking/overview') return Promise.resolve(new Response(null, { status: 204 }));
      reads += 1;
      return Promise.resolve(reads === 2 ? new Response('', { status: 404 }) : overview([acknowledged]));
    });
    const user = userEvent.setup();
    render(<NetworkingView />);

    await user.click(await screen.findByRole('button', { name: '1 dismissed' }));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    await screen.findByText('Networking is not available on this node');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the sheet when the active node changes', async () => {
    apiFetchMock.mockImplementation((path: string) => Promise.resolve(path === '/networking/overview' ? overview([acknowledged]) : new Response(null, { status: 204 })));
    const user = userEvent.setup();
    const view = render(<NetworkingView />);

    await user.click(await screen.findByRole('button', { name: '1 dismissed' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    nodes.activeId = 2;
    view.rerender(<NetworkingView />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows no count when nothing is dismissed', async () => {
    apiFetchMock.mockResolvedValue(overview([]));
    render(<NetworkingView />);
    await screen.findByText(/no networking issues detected/i);
    expect(screen.queryByRole('button', { name: /dismissed/ })).toBeNull();
  });
});

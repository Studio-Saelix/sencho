/**
 * The workplace's list-to-application round trip: a Blueprint row opens its
 * application sheet over the list (which stays mounted), and closing it returns
 * to the same list without refetching it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { blueprintDetailResponse, portfolioRow } from '../application/applicationFixtures';
import { GitOpsWorkplaceView } from './GitOpsWorkplaceView';
import { closeGitOpsApplication } from './portfolioNavigation';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

// The application view reads the session's permissions for its authority
// actions; this suite drives navigation, not authorization.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: () => false }),
}));

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ hasCapability: () => false, nodeMeta: new Map() }),
}));

// The Git source host mounts with the workplace; this suite never opens it.
vi.mock('./GitOpsGitSourceHost', () => ({ GitOpsGitSourceHost: () => null }));

const mockFetch = vi.mocked(apiFetch);

const list: GitOpsPortfolioResponse = {
  schemaVersion: 1,
  generatedAt: Date.now(),
  summary: {
    applications: 1, attentionRequired: 0, failed: 0, inProgress: 0, converged: 1,
    convergedQualified: 0, unknown: 0, drifted: 0, byReason: {},
    attentionByNode: {},
  },
  coverage: [{ nodeId: 1, nodeName: 'local', state: 'ok' }],
  attentionQueue: [],
  attentionQueueTruncated: false,
  applications: [portfolioRow({ id: 'bp:3', name: 'shop', targetMode: 'blueprint', nodeId: null, stackName: null, blueprintId: 3 })],
  nextCursor: null,
  truncated: false,
};

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  mockFetch.mockReset();
  window.history.replaceState({}, '', '/');
});

describe('GitOpsWorkplaceView', () => {
  it('opens a row as a sheet over the list and closes back to it without refetching', async () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/gitops');
    mockFetch.mockImplementation(async (url: string) => (
      url.startsWith('/gitops/applications/') ? ok(blueprintDetailResponse()) : ok(list)
    ));
    render(<GitOpsWorkplaceView />);

    fireEvent.click(await screen.findByRole('button', { name: 'shop' }));
    expect(await screen.findByTestId('gitops-application-detail')).toBeInTheDocument();
    // The list stays mounted under the sheet (hidden from assistive tech while it is modal).
    expect(screen.getAllByRole('button', { name: 'shop', hidden: true }).length).toBeGreaterThan(0);
    const listFetches = mockFetch.mock.calls.filter(([url]) => !String(url).startsWith('/gitops/applications/')).length;

    act(() => closeGitOpsApplication());
    await waitFor(() => expect(screen.queryByTestId('gitops-application-detail')).toBeNull());
    expect(window.location.search).toBe('');
    expect(mockFetch.mock.calls.filter(([url]) => !String(url).startsWith('/gitops/applications/')).length).toBe(listFetches);
  });

  it('tells an empty portfolio apart from a filtered-out one', async () => {
    mockFetch.mockResolvedValue(ok({
      ...list,
      summary: { ...list.summary, applications: 0, converged: 0 },
      applications: [],
    }));
    render(<GitOpsWorkplaceView />);
    expect(await screen.findByText(/No GitOps applications yet/)).toBeInTheDocument();
  });

  it('clears a deep-linked filter that has no visible control', async () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/gitops?source=failed');
    mockFetch.mockResolvedValue(ok(list));
    render(<GitOpsWorkplaceView />);

    await waitFor(() => expect(String(mockFetch.mock.calls[0]?.[0])).toContain('source=failed'));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));

    await waitFor(() => expect(String(mockFetch.mock.calls.at(-1)?.[0])).not.toContain('source='));
    expect(window.location.search).toBe('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('shows a stack scope as a removable chip', async () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/gitops?stack=web&nodeId=1');
    mockFetch.mockResolvedValue(ok(list));
    render(<GitOpsWorkplaceView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove stack filter' }));

    await waitFor(() => expect(String(mockFetch.mock.calls.at(-1)?.[0])).not.toContain('stack='));
    expect(String(mockFetch.mock.calls.at(-1)?.[0])).toContain('nodeId=1');
    expect(window.location.search).toBe('?nodeId=1');
  });

  it('offers Retry when the portfolio cannot be read, and reads it again', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'boom' }) } as unknown as Response);
    mockFetch.mockResolvedValue(ok(list));
    render(<GitOpsWorkplaceView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('GITOPS')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('says refreshing in the masthead while a newer answer is coming, with no separate indicator', async () => {
    mockFetch.mockResolvedValueOnce(ok(list));
    render(<GitOpsWorkplaceView />);
    await screen.findByText(/node reporting · updated/);

    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));
    act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } })); });

    expect(await screen.findByText(/node reporting · refreshing/)).toBeInTheDocument();
    expect(screen.queryByText('Refreshing')).toBeNull();
  });
});

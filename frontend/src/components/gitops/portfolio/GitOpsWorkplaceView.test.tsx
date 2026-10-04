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
import { SENCHO_NAVIGATE_EVENT } from '@/lib/events';
import { clearBlueprintIntent, peekBlueprintIntent } from '@/lib/blueprintIntent';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

// The application sheet and the queue read the session's permissions. The suite is
// read-only by default (`allowed` is false); a test that needs an action opts in.
const session = vi.hoisted(() => ({ allowed: false, fleet: false }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: () => session.allowed }),
}));

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ hasCapability: () => session.fleet, nodeMeta: new Map() }),
}));

// The Git source host mounts with the workplace; this suite never opens it.
vi.mock('./GitOpsGitSourceHost', () => ({ GitOpsGitSourceHost: () => null }));

// The Blueprint sheets are real hosts here; only their heavy bodies are stood in for.
vi.mock('@/components/blueprints/BlueprintDetail', () => ({
  BlueprintDetail: ({ blueprintId }: { blueprintId: number }) => <div data-testid="blueprint-detail">{blueprintId}</div>,
}));
vi.mock('@/components/blueprints/BlueprintEditor', () => ({
  BlueprintEditor: () => <div data-testid="blueprint-editor" />,
}));
vi.mock('@/lib/blueprintsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blueprintsApi')>()),
  listAllNodeLabels: vi.fn(async () => ({})),
}));

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
  session.allowed = false;
  session.fleet = false;
  clearBlueprintIntent();
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

  it('reads the portfolio again after Retry in the queue, without waiting for a server announcement', async () => {
    session.allowed = true;
    const failing = portfolioRow({ attention: ['source_failed'], posture: 'failed', availableActions: ['retry'] });
    const withQueue: GitOpsPortfolioResponse = {
      ...list,
      summary: { ...list.summary, attentionRequired: 1, failed: 1, converged: 0 },
      attentionQueue: [failing],
      applications: [failing],
    };
    mockFetch.mockImplementation(async (url: string) => (
      String(url).includes('/git-source/retry') ? ok({}) : ok(withQueue)
    ));
    render(<GitOpsWorkplaceView />);
    const listReads = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith('/gitops/applications')).length;
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await waitFor(() => expect(retry).toBeEnabled());
    const before = listReads();

    fireEvent.click(retry);

    await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/stacks/bookstack/git-source/retry'))).toBe(true));
    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
  });

  it('declares a Blueprint over the portfolio without leaving GitOps', async () => {
    session.allowed = true;
    session.fleet = true;
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/gitops');
    mockFetch.mockResolvedValue(ok(list));
    const navigated: unknown[] = [];
    const onNavigate = (e: Event) => navigated.push((e as CustomEvent).detail);
    window.addEventListener(SENCHO_NAVIGATE_EVENT, onNavigate);
    try {
      render(<GitOpsWorkplaceView />);
      fireEvent.click(await screen.findByRole('button', { name: /new blueprint/i }));
      expect(await screen.findByTestId('blueprint-editor')).toBeInTheDocument();
    } finally {
      window.removeEventListener(SENCHO_NAVIGATE_EVENT, onNavigate);
    }
    expect(navigated).toEqual([]);
    expect(peekBlueprintIntent()).toBeNull();
  });

  it('hands a Blueprint application sheet over to the Blueprint sheet, in place', async () => {
    session.allowed = true;
    session.fleet = true;
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/gitops');
    mockFetch.mockImplementation(async (url: string) => (
      url.startsWith('/gitops/applications/') ? ok(blueprintDetailResponse()) : ok(list)
    ));
    render(<GitOpsWorkplaceView />);

    fireEvent.click(await screen.findByRole('button', { name: 'shop' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Blueprint' }));

    expect(await screen.findByTestId('blueprint-detail')).toHaveTextContent('3');
    await waitFor(() => expect(screen.queryByTestId('gitops-application-detail')).toBeNull());
    expect(peekBlueprintIntent()).toBeNull();
  });
});

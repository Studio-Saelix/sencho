import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { detailResponse, portfolioRow } from '@/components/gitops/application/applicationFixtures';
import { GITOPS_GIT_SOURCE_EVENT } from '../gitops/portfolio/portfolioNavigation';
import { MobileGitOps } from './MobileGitOps';

const session = vi.hoisted(() => ({ canEdit: true }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

// The application view reads the session's permissions for its authority
// actions; this suite drives the phone shell, not authorization.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: (action: string) => action === 'stack:edit' && session.canEdit }),
}));

// The Git source sheet has its own suite; here only the request to open it matters.
vi.mock('../gitops/portfolio/GitOpsGitSourceHost', () => ({ GitOpsGitSourceHost: () => null }));

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodeMeta: new Map<number, { capabilities: string[] }>() }),
}));

vi.mock('../gitops/portfolio/useWorkplaceCapabilities', () => ({
  useWorkplaceCapabilities: () => ({ canConnectStack: false, canCreateBlueprint: false, canOpenFleet: false }),
}));

const mockFetch = vi.mocked(apiFetch);

const emptyList = {
  schemaVersion: 1,
  generatedAt: 0,
  summary: {
    applications: 0, attentionRequired: 0, failed: 0, inProgress: 0, converged: 0,
    convergedQualified: 0, unknown: 0, drifted: 0, byReason: {},
  },
  coverage: [],
  attentionQueue: [],
  attentionQueueTruncated: false,
  applications: [],
  nextCursor: null,
  truncated: false,
};

afterEach(() => {
  session.canEdit = true;
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.warning).mockReset();
  vi.mocked(toast.error).mockReset();
  mockFetch.mockReset();
  window.history.replaceState({}, '', '/');
});

describe('MobileGitOps', () => {
  it('shows the application view for a linked application, keeping the shell actions reachable', async () => {
    window.history.replaceState({}, '', '/nodes/local/gitops?application=1%3Aapp-1');
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.startsWith('/gitops/applications/') ? detailResponse() : emptyList),
    }) as unknown as Response);

    render(<MobileGitOps headerActions={<button type="button">More</button>} />);

    expect(await screen.findByRole('heading', { name: 'bookstack' })).toBeInTheDocument();
    expect(screen.getByTestId('gitops-application-view')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('marks a truncated portfolio partial even when every node answered', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...emptyList,
        summary: { ...emptyList.summary, applications: 1, unknown: 1 },
        coverage: [{ nodeId: 1, nodeName: 'local', state: 'ok' as const }],
        applications: [portfolioRow({
          id: '1:app-1',
          name: 'bookstack',
          posture: 'unknown',
          evidence: { partial: true, unreachableNodes: [], unknown: true },
        })],
        truncated: true,
      }),
    }) as unknown as Response);

    render(<MobileGitOps headerActions={null} />);

    // The count alone would read as a complete answer, so the omission has to
    // say itself wherever the other partial signals would have said it.
    expect(await screen.findByText(/partial/)).toBeInTheDocument();
  });

  const withRows = (rows: ReturnType<typeof portfolioRow>[]) => mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => (init?.method === 'POST'
      ? { outcome: 'pending_review', reason: 'A candidate is staged and requires review.', nextAction: 'review' }
      : { ...emptyList, summary: { ...emptyList.summary, applications: rows.length }, applications: rows }),
  }) as unknown as Response);

  it('retries a failed source from the row without opening anything', async () => {
    withRows([portfolioRow({ id: '1:app-1', name: 'bookstack', attention: ['source_failed'], availableActions: ['retry'] })]);
    const opened = vi.fn();
    window.addEventListener(GITOPS_GIT_SOURCE_EVENT, opened);

    render(<MobileGitOps headerActions={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      '/stacks/bookstack/git-source/retry',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(opened).not.toHaveBeenCalled();
    window.removeEventListener(GITOPS_GIT_SOURCE_EVENT, opened);
  });

  it('toasts and re-enables the step when the retry is refused', async () => {
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => ({
      ok: init?.method !== 'POST',
      status: init?.method === 'POST' ? 409 : 200,
      json: async () => (init?.method === 'POST'
        ? { error: 'refused' }
        : { ...emptyList, summary: { ...emptyList.summary, applications: 1 }, applications: [portfolioRow({ id: '1:app-1', name: 'bookstack', attention: ['source_failed'], availableActions: ['retry'] })] }),
    }) as unknown as Response);

    render(<MobileGitOps headerActions={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('refused')));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveAttribute('aria-busy', 'true'));
  });

  it('warns on a Retry the server refused with 200 and still refreshes the row', async () => {
    const refreshed = vi.fn();
    window.addEventListener('sencho:state-invalidate', refreshed);
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => (init?.method === 'POST'
        ? {
            outcome: 'failed_previous_intact',
            reason: 'The fetch stage failed (AUTH). The previously accepted generation is unchanged.',
            nextAction: 'retry',
          }
        : { ...emptyList, summary: { ...emptyList.summary, applications: 1 }, applications: [portfolioRow({ id: '1:app-1', name: 'bookstack', attention: ['source_failed'], availableActions: ['retry'] })] }),
    }) as unknown as Response);

    render(<MobileGitOps headerActions={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'bookstack: retry failed, the previous deployment was left as it was. The fetch stage failed (AUTH). The previously accepted generation is unchanged.',
    ));
    expect(toast.success).not.toHaveBeenCalled();
    expect(refreshed).toHaveBeenCalled();
    window.removeEventListener('sencho:state-invalidate', refreshed);
  });

  it('warns on a Resume the server refused with 200', async () => {
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => (init?.method === 'POST'
        ? {
            outcome: 'suspended',
            reason: 'Reconciliation is suspended: paused for maintenance',
            nextAction: 'resume',
          }
        : { ...emptyList, summary: { ...emptyList.summary, applications: 1 }, applications: [portfolioRow({ id: '1:app-1', name: 'bookstack', attention: ['source_suspended'], availableActions: ['resume'] })] }),
    }) as unknown as Response);

    render(<MobileGitOps headerActions={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'bookstack: the source did not resume. Reconciliation is suspended: paused for maintenance',
    ));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('falls back to opening the Git source when the session cannot edit the stack', async () => {
    session.canEdit = false;
    withRows([portfolioRow({ id: '1:app-1', name: 'bookstack', attention: ['source_failed'], availableActions: ['retry'] })]);

    render(<MobileGitOps headerActions={null} />);

    expect(await screen.findByRole('button', { name: 'Open Git source' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('opens the update review in place for a waiting update', async () => {
    withRows([portfolioRow({ id: '1:app-1', name: 'bookstack', attention: ['source_review_pending'] })]);
    const opened = vi.fn();
    window.addEventListener(GITOPS_GIT_SOURCE_EVENT, opened);

    render(<MobileGitOps headerActions={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review update' }));

    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail.intent).toBe('review');
    window.removeEventListener(GITOPS_GIT_SOURCE_EVENT, opened);
  });

  it('offers no step on an application that needs nothing', async () => {
    withRows([portfolioRow({ id: '1:app-1', name: 'bookstack', attention: [] })]);
    render(<MobileGitOps headerActions={null} />);
    await screen.findByText('bookstack');
    expect(screen.queryByRole('button', { name: /Retry|Resume|Review|Open/ })).not.toBeInTheDocument();
  });
});

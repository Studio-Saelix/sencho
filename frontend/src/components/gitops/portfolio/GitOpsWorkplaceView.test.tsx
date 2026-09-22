/**
 * The workplace's list-to-application round trip: a row opens the application
 * view in place, and returning (through the real history Back) restores the
 * list from hook state without refetching it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { detailResponse, portfolioRow } from '../application/applicationFixtures';
import { GitOpsWorkplaceView } from './GitOpsWorkplaceView';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

const list: GitOpsPortfolioResponse = {
  schemaVersion: 1,
  generatedAt: Date.now(),
  summary: {
    applications: 1, attentionRequired: 0, failed: 0, inProgress: 0, converged: 1,
    convergedQualified: 0, unknown: 0, drifted: 0, byReason: {},
  },
  coverage: [{ nodeId: 1, nodeName: 'local', state: 'ok' }],
  attentionQueue: [],
  attentionQueueTruncated: false,
  applications: [portfolioRow()],
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
  it('opens a row in place and returns to the list without refetching it', async () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/gitops');
    mockFetch.mockImplementation(async (url: string) => (
      url.startsWith('/gitops/applications/') ? ok(detailResponse()) : ok(list)
    ));
    render(<GitOpsWorkplaceView />);

    fireEvent.click(await screen.findByRole('button', { name: 'bookstack' }));
    expect(await screen.findByTestId('gitops-application-view')).toBeInTheDocument();
    const listFetches = mockFetch.mock.calls.filter(([url]) => !String(url).startsWith('/gitops/applications/')).length;

    fireEvent.click(screen.getByRole('button', { name: /all applications/i }));
    await waitFor(() => expect(screen.queryByTestId('gitops-application-view')).toBeNull());
    expect(screen.getByRole('button', { name: 'bookstack' })).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(mockFetch.mock.calls.filter(([url]) => !String(url).startsWith('/gitops/applications/')).length).toBe(listFetches);
  });
});

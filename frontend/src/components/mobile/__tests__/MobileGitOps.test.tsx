/**
 * Phone portfolio: the search field keeps every keystroke while the fetch is
 * debounced, and server pages are navigated, not appended.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { portfolioRow } from '../../gitops/application/applicationFixtures';
import { MobileGitOps } from '../MobileGitOps';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

const list: GitOpsPortfolioResponse = {
  schemaVersion: 1,
  generatedAt: Date.now(),
  summary: {
    applications: 60, attentionRequired: 0, failed: 0, inProgress: 0, converged: 60,
    convergedQualified: 0, unknown: 0, drifted: 0, byReason: {},
  },
  coverage: [{ nodeId: 1, nodeName: 'local', state: 'ok' }],
  attentionQueue: [],
  attentionQueueTruncated: false,
  applications: [portfolioRow()],
  nextCursor: 'next-page',
  truncated: false,
};

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  mockFetch.mockReset();
  window.history.replaceState({}, '', '/');
});

describe('MobileGitOps', () => {
  it('keeps typed search text while the query is debounced', async () => {
    mockFetch.mockResolvedValue(ok(list));
    render(<MobileGitOps />);
    const input = await screen.findByRole('searchbox', { name: 'Search GitOps applications' });

    fireEvent.change(input, { target: { value: 'b' } });
    fireEvent.change(input, { target: { value: 'bo' } });
    expect(input).toHaveValue('bo');

    await waitFor(() => expect(String(mockFetch.mock.calls.at(-1)?.[0])).toContain('q=bo'));
    expect(input).toHaveValue('bo');
  });

  it('pages forward and back instead of appending', async () => {
    mockFetch.mockResolvedValue(ok(list));
    render(<MobileGitOps />);

    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(String(mockFetch.mock.calls.at(-1)?.[0])).toContain('cursor=next-page'));
    expect(screen.getByText('Page 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(screen.getByText('Page 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });
});

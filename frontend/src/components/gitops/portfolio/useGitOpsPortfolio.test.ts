/**
 * Behavioural tests for the GitOps portfolio data hook.
 *
 * These pin the contract the workplace relies on: a failed refresh keeps the
 * last good page and marks it stale rather than blanking it, a rejected cursor
 * recovers to page 1 instead of stranding the operator, and the URL write
 * preserves the router's history marker. URL parsing is covered in the same
 * file so the read and write halves of the filter contract stay together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { filtersFromSearch, useGitOpsPortfolio } from '@/components/gitops/portfolio/useGitOpsPortfolio';
import {
  applicationIdFromSearch,
  closeGitOpsApplication,
  openGitOpsApplication,
  openGitOpsWorkplace,
  peekPendingPortfolioScope,
} from '@/components/gitops/portfolio/portfolioNavigation';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

function response(overrides: Partial<GitOpsPortfolioResponse> = {}): GitOpsPortfolioResponse {
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    summary: {
      applications: 1,
      attentionRequired: 0,
      failed: 0,
      inProgress: 0,
      converged: 1,
      convergedQualified: 0,
      unknown: 0,
      drifted: 0,
      byReason: {},
    attentionByNode: {},
    },
    coverage: [],
    attentionQueue: [],
    attentionQueueTruncated: false,
    applications: [],
    nextCursor: null,
    truncated: false,
    ...overrides,
  };
}

function ok(body: GitOpsPortfolioResponse): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function fail(status: number, error: string): Response {
  return { ok: false, status, json: async () => ({ error }) } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('useGitOpsPortfolio', () => {
  it('never lets a search debounce replace the URL of an application opened meanwhile', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops');
    mockFetch.mockResolvedValue(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    vi.useFakeTimers();
    try {
      act(() => result.current.setQuery('web'));
      act(() => openGitOpsApplication('1:a'));
      act(() => { vi.advanceTimersByTime(1000); });
    } finally {
      vi.useRealTimers();
    }

    expect(applicationIdFromSearch(window.location.search)).toBe('1:a');
    // The search still applies to the list the operator returns to.
    expect(result.current.filters.q).toBe('web');

    // Closing the view reconciles the restored list URL with that search.
    await act(async () => {
      closeGitOpsApplication();
      await new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    });
    await waitFor(() => expect(window.location.search).toBe('?q=web'));
    expect(window.history.state).toMatchObject({ senchoIdx: 1 });
  });

  it('loads the portfolio on mount', async () => {
    mockFetch.mockResolvedValue(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    // Initial load is `loading`, never the refresh pill.
    expect(result.current.refreshing).toBe(false);
  });

  it('keeps the last good page and flags it stale when a later refresh fails', async () => {
    mockFetch
      .mockResolvedValueOnce(ok(response()))
      .mockResolvedValueOnce(fail(500, 'boom'));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    result.current.refresh();
    await waitFor(() => expect(result.current.staleSince).not.toBeNull());
    // The rows survive the failure: a triage surface shows last-known state
    // and says so rather than blanking.
    expect(result.current.data).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('recovers from a rejected page cursor by returning to page 1', async () => {
    mockFetch
      .mockResolvedValueOnce(ok(response({ nextCursor: 'cursor-2' })))
      .mockResolvedValueOnce(fail(400, 'Invalid page cursor. Restart from the first page.'))
      .mockResolvedValueOnce(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    result.current.nextPage();
    // The 400 resets pagination and the hook refetches page 1 with no cursor.
    await waitFor(() => expect(result.current.pageLoaded).toBe(1));
    await waitFor(() => {
      const lastUrl = String(mockFetch.mock.calls.at(-1)![0]);
      expect(lastUrl).not.toContain('cursor=');
    });
    // The second call was the page-2 request that carried the rejected cursor.
    expect(String(mockFetch.mock.calls[1]![0])).toContain('cursor=cursor-2');
  });

  it('surfaces an initial-load failure as the page error, with no data', async () => {
    mockFetch.mockResolvedValue(fail(500, 'hub exploded'));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.error).toBe('hub exploded'));
    expect(result.current.data).toBeNull();
  });

  it('preserves the router history marker when syncing the URL', async () => {
    window.history.replaceState({ senchoIdx: 2 }, '', '/nodes/local/gitops');
    mockFetch.mockResolvedValue(ok(response()));
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    result.current.setFilters({ attention: '1' });
    expect(replaceState).toHaveBeenCalled();
    const [, , url] = replaceState.mock.calls.at(-1)!;
    expect(String(url)).toContain('attention=1');
    // The state argument is passed through, not nulled: the router stores its
    // back/forward index there.
    expect(replaceState.mock.calls.at(-1)![0]).toBe(window.history.state);
  });
});

describe('stack-scoped entry (openGitOpsWorkplace)', () => {
  const lastUrl = () => String(mockFetch.mock.calls.at(-1)?.[0]);

  it('opens a mounting workplace on the scope and writes it once the router is on the GitOps path', async () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/web');
    mockFetch.mockResolvedValue(ok(response()));
    // The indicator fires before the workplace mounts, as a view switch does.
    act(() => openGitOpsWorkplace({ nodeId: 3, stack: 'web' }));
    // The router moves onto the GitOps path in the same commit as the mount.
    window.history.pushState({ senchoIdx: 1 }, '', '/nodes/local/gitops');
    const { result } = renderHook(() => useGitOpsPortfolio());

    expect(result.current.filters).toEqual({ nodeId: 3, stack: 'web' });
    await waitFor(() => expect(lastUrl()).toContain('stack=web'));
    expect(lastUrl()).toContain('nodeId=3');
    await waitFor(() => expect(window.location.search).toBe('?stack=web&nodeId=3'));
    expect(peekPendingPortfolioScope()).toBeNull();
  });

  it('waits for the router to reach the GitOps path before writing the scope', async () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/web');
    mockFetch.mockResolvedValue(ok(response()));
    act(() => openGitOpsWorkplace({ nodeId: 3, stack: 'web' }));
    renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(lastUrl()).toContain('stack=web'));
    // Still on the page being left: the scope must not attach to it.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(window.location.search).toBe('');

    // The lazy view's route lands later; the write follows it.
    window.history.pushState({ senchoIdx: 1 }, '', '/nodes/local/gitops');
    await waitFor(() => expect(window.location.search).toBe('?stack=web&nodeId=3'));
  });

  it('survives StrictMode effect replay on a scoped mount', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops');
    mockFetch.mockResolvedValue(ok(response()));
    act(() => openGitOpsWorkplace({ nodeId: 3, stack: 'web' }));
    const { result } = renderHook(() => useGitOpsPortfolio(), { wrapper: StrictMode });
    expect(result.current.filters).toEqual({ nodeId: 3, stack: 'web' });
    await waitFor(() => expect(window.location.search).toBe('?stack=web&nodeId=3'));
  });

  it('replaces the question of an already mounted workplace', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops?attention=1&q=api');
    mockFetch.mockResolvedValue(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    act(() => openGitOpsWorkplace({ nodeId: 2, stack: 'db' }));

    expect(result.current.filters).toEqual({ nodeId: 2, stack: 'db' });
    await waitFor(() => expect(lastUrl()).toContain('stack=db'));
    expect(window.location.search).toBe('?stack=db&nodeId=2');
  });

  it('writes the scope to the list URL once an open application view closes', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops?attention=1');
    mockFetch.mockResolvedValue(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    act(() => openGitOpsApplication('1:a'));

    act(() => openGitOpsWorkplace({ nodeId: 2, stack: 'db' }));
    // The application URL is left alone while the view owns it.
    expect(applicationIdFromSearch(window.location.search)).toBe('1:a');

    // The real close path: Back pops the pushed application entry.
    await act(async () => {
      closeGitOpsApplication();
      await new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    });
    await waitFor(() => expect(window.location.search).toBe('?stack=db&nodeId=2'));
    expect(result.current.filters).toEqual({ nodeId: 2, stack: 'db' });
  });

  it('adopts a list entry the user reaches with Back instead of overwriting it', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops?attention=1');
    mockFetch.mockResolvedValue(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    act(() => {
      window.history.replaceState(window.history.state, '', '/nodes/local/gitops?mode=direct');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(window.location.search).toBe('?mode=direct');
    await waitFor(() => expect(result.current.filters).toEqual({ mode: 'direct' }));
  });

  it('drops a scope whose navigation never mounted the workplace', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops?attention=1');
    mockFetch.mockResolvedValue(ok(response()));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    openGitOpsWorkplace({ nodeId: 3, stack: 'web' });
    clock.mockReturnValue(now + 60_000);
    const { result } = renderHook(() => useGitOpsPortfolio());
    expect(result.current.filters).toEqual({ attention: '1' });
  });

  it('opens on one Blueprint application from its detail sheet', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops?attention=1');
    mockFetch.mockResolvedValue(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    act(() => openGitOpsWorkplace({ blueprintId: 7 }));
    expect(result.current.filters).toEqual({ blueprintId: 7 });
    await waitFor(() => expect(lastUrl()).toContain('blueprintId=7'));
    expect(window.location.search).toBe('?blueprintId=7');
  });

  it('opens on the applications needing attention on one node from a Fleet card', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops');
    mockFetch.mockResolvedValue(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    act(() => openGitOpsWorkplace({ nodeId: 4, attention: true }));
    expect(result.current.filters).toEqual({ nodeId: 4, attention: '1' });
    await waitFor(() => expect(lastUrl()).toMatch(/attention=1.*nodeId=4/));
  });

  it('keeps the current question when opened without a scope', async () => {
    window.history.replaceState({ senchoIdx: 1 }, '', '/nodes/local/gitops?attention=1');
    mockFetch.mockResolvedValue(ok(response()));
    const { result } = renderHook(() => useGitOpsPortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    act(() => openGitOpsWorkplace());
    expect(result.current.filters).toEqual({ attention: '1' });
  });
});

describe('filtersFromSearch (URL round-trip)', () => {
  it('round-trips a Blueprint scope', () => {
    expect(filtersFromSearch('?blueprintId=7')).toEqual({ blueprintId: 7 });
    expect(filtersFromSearch('?blueprintId=-1')).toEqual({});
  });

  it('parses an empty query as no filters', async () => {
    const { filtersFromSearch } = await import('@/components/gitops/portfolio/useGitOpsPortfolio');
    expect(filtersFromSearch('')).toEqual({});
    expect(filtersFromSearch('?')).toEqual({});
  });

  it('round-trips the triage filters the issue names', async () => {
    const { filtersFromSearch } = await import('@/components/gitops/portfolio/useGitOpsPortfolio');
    expect(filtersFromSearch('?q=immich&attention=1&mode=direct&evidence=unreachable&drift=runtime'))
      .toEqual({ q: 'immich', attention: '1', mode: 'direct', evidence: 'unreachable', drift: 'runtime' });
  });

  it('parses a node filter only when it is a usable node id', async () => {
    const { filtersFromSearch } = await import('@/components/gitops/portfolio/useGitOpsPortfolio');
    expect(filtersFromSearch('?nodeId=2')).toEqual({ nodeId: 2 });
    expect(filtersFromSearch('?nodeId=abc')).toEqual({});
    expect(filtersFromSearch('?nodeId=-1')).toEqual({});
  });

  it('rejects unknown enum values rather than widening the question', async () => {
    const { filtersFromSearch } = await import('@/components/gitops/portfolio/useGitOpsPortfolio');
    expect(filtersFromSearch('?mode=hybrid')).toEqual({});
    expect(filtersFromSearch('?evidence=missing')).toEqual({});
    expect(filtersFromSearch('?attention=yes').attention).toBeUndefined();
  });
});

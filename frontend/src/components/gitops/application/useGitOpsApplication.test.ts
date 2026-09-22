/**
 * The application view's data contract: the id is encoded into one hub-local
 * read, a failed refresh keeps the last state flagged stale, an application
 * that stops being readable leaves the view rather than lingering, and a
 * gitops invalidation refetches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { useGitOpsApplication } from './useGitOpsApplication';
import { detailResponse } from './applicationFixtures';
import type { GitOpsPortfolioDetailResponse } from '@/types/gitopsPortfolio';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

function ok(body: GitOpsPortfolioDetailResponse): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function fail(status: number, error: string): Response {
  return { ok: false, status, json: async () => ({ error }) } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useGitOpsApplication', () => {
  it('reads the encoded id from the hub, never through the node proxy', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    const { result } = renderHook(() => useGitOpsApplication('2:legacy:media stack'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledWith('/gitops/applications/2%3Alegacy%3Amedia%20stack', { localOnly: true });
    expect(result.current.data?.application.name).toBe('bookstack');
    expect(result.current.error).toBeNull();
  });

  it.each([404, 403])('reports %i as not readable, without distinguishing absent from forbidden', async (status) => {
    mockFetch.mockResolvedValueOnce(fail(status, 'Application not found'));
    const { result } = renderHook(() => useGitOpsApplication('1:gone'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'not_readable' });
    expect(result.current.data).toBeNull();
  });

  it('reports a malformed id as an invalid link, not as a missing application', async () => {
    mockFetch.mockResolvedValueOnce(fail(400, 'Application id is not a portfolio id'));
    const { result } = renderHook(() => useGitOpsApplication('nonsense'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'invalid_link' });
  });

  it('tells a node too old to answer apart from a node that did not answer', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 502, json: async () => ({ error: 'Owning node cannot answer GitOps portfolio reads', code: 'node_unsupported' }),
    } as unknown as Response);
    const { result } = renderHook(() => useGitOpsApplication('2:app'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'unsupported', message: 'Owning node cannot answer GitOps portfolio reads' });
  });

  it('reports a 502 without the unsupported code as unreachable', async () => {
    mockFetch.mockResolvedValueOnce(fail(502, 'Bad Gateway'));
    const { result } = renderHook(() => useGitOpsApplication('2:app'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'unreachable', message: 'Bad Gateway' });
  });

  it('reports a server failure and a thrown first load as failed, with no data', async () => {
    mockFetch.mockResolvedValueOnce(fail(500, 'boom'));
    const first = renderHook(() => useGitOpsApplication('1:a'));
    await waitFor(() => expect(first.result.current.error).toEqual({ kind: 'failed', message: 'boom' }));

    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const second = renderHook(() => useGitOpsApplication('1:b'));
    await waitFor(() => expect(second.result.current.error).toEqual({ kind: 'failed', message: 'network down' }));
    expect(second.result.current.data).toBeNull();
  });

  it('rejects a successful answer it cannot read instead of rendering a blank view', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ schemaVersion: 2 }) } as unknown as Response);
    const { result } = renderHook(() => useGitOpsApplication('1:a'));
    await waitFor(() => expect(result.current.error?.kind).toBe('failed'));
    expect(result.current.data).toBeNull();
  });

  it('never lets a slow earlier answer overwrite a newer one', async () => {
    let resolveFirst: (r: Response) => void = () => {};
    mockFetch.mockReturnValueOnce(new Promise<Response>(resolve => { resolveFirst = resolve; }));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));

    mockFetch.mockResolvedValueOnce(ok(detailResponse({ name: 'new' })));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.application.name).toBe('new'));

    await act(async () => resolveFirst(ok(detailResponse({ name: 'old' }))));
    expect(result.current.data?.application.name).toBe('new');
  });

  it('reports an unreachable owning node as unreachable, with the server message', async () => {
    mockFetch.mockResolvedValueOnce(fail(503, 'Owning node is unreachable'));
    const { result } = renderHook(() => useGitOpsApplication('2:app'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'unreachable', message: 'Owning node is unreachable' });
  });

  it('keeps the last state and flags it stale when a refresh fails', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    mockFetch.mockRejectedValueOnce(new Error('network down'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.staleSince).not.toBeNull());
    expect(result.current.data?.application.id).toBe('1:app-1');
    expect(result.current.error).toBeNull();
  });

  it('drops the state when a refresh says the application is no longer readable', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    mockFetch.mockResolvedValueOnce(fail(404, 'Application not found'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toEqual({ kind: 'not_readable' }));
    expect(result.current.data).toBeNull();
    expect(result.current.staleSince).toBeNull();
  });

  it('refetches on a gitops invalidation and ignores other scopes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch.mockResolvedValue(ok(detailResponse()));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'stacks' } }));
      vi.advanceTimersByTime(300);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } }));
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } }));
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});

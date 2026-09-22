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

  it.each([404, 403, 400])('reports %i as not readable, without distinguishing absent from forbidden', async (status) => {
    mockFetch.mockResolvedValueOnce(fail(status, 'Application not found'));
    const { result } = renderHook(() => useGitOpsApplication('1:gone'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'not_readable' });
    expect(result.current.data).toBeNull();
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

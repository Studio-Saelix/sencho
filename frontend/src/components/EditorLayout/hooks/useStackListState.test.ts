import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const useNodesMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => useNodesMock(),
}));

const useImageUpdatesMock = vi.fn();
vi.mock('@/hooks/useImageUpdates', () => ({
  useImageUpdates: (...args: unknown[]) => useImageUpdatesMock(...args),
}));

import { useStackListState } from './useStackListState';
import { __resetStackStatusesFetchForTests } from '@/lib/stackStatusesFetch';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(): Response {
  return new Response('not found', { status: 404 });
}

beforeEach(() => {
  __resetStackStatusesFetchForTests();
  apiFetchMock.mockReset();
  useNodesMock.mockReset();
  useImageUpdatesMock.mockReset();
  useNodesMock.mockReturnValue({
    activeNode: { id: 1, name: 'Local', type: 'local' },
    nodes: [{ id: 1, name: 'Local', type: 'local' }],
  });
  useImageUpdatesMock.mockReturnValue({
    stackUpdates: {},
    refresh: vi.fn(),
    sidebarIndicators: true,
  });
});

describe('useStackListState.refreshStacks failure classification', () => {
  it('rejects a malformed (non-array) successful /stacks response as an error, not confirmed-empty', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson({}));
      return Promise.resolve(notFound());
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });

    expect(result.current.stacksLoadStatus).toBe('error');
    expect(result.current.files).toEqual([]);
  });

  it('surfaces a recoverable error on a background failure after the list was already confirmed empty', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      return Promise.resolve(notFound());
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.stacksLoadStatus).toBe('success');
    expect(result.current.files).toEqual([]);

    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(new Response('fail', { status: 500 }));
      return Promise.resolve(notFound());
    });

    await act(async () => {
      await result.current.refreshStacks(true);
    });

    expect(result.current.stacksLoadStatus).toBe('error');
  });

  it('preserves a non-empty list on a background failure (soft-refresh semantics unchanged)', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.stacksLoadStatus).toBe('success');
    expect(result.current.files).toEqual(['web.yml']);

    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(new Response('fail', { status: 500 }));
      return Promise.resolve(notFound());
    });

    await act(async () => {
      await result.current.refreshStacks(true);
    });

    expect(result.current.stacksLoadStatus).toBe('success');
    expect(result.current.files).toEqual(['web.yml']);
    expect(result.current.stacksLoadError).toBe('Could not load stacks (500)');
  });

  it('keeps a list that just loaded non-empty when the follow-up statuses fetch throws in the same background refresh', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      return Promise.resolve(notFound());
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.files).toEqual([]);

    // A background refresh discovers a real stack, but decoding the
    // follow-up /stacks/statuses call throws. The just-committed non-empty
    // list must survive: only the closure-stale `files` from before this
    // call was empty, not the list this attempt just fetched.
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.reject(new Error('network error'));
      return Promise.resolve(notFound());
    });

    await act(async () => {
      await result.current.refreshStacks(true);
    });

    expect(result.current.files).toEqual(['web.yml']);
  });
});

describe('useStackListState Updates chip confirmed-only', () => {
  async function loadStacks() {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') {
        return Promise.resolve(okJson(['ok.yml', 'partial.yml', 'failed.yml']));
      }
      if (endpoint === '/stacks/statuses') {
        return Promise.resolve(okJson({
          'ok.yml': { status: 'running' },
          'partial.yml': { status: 'running' },
          'failed.yml': { status: 'running' },
        }));
      }
      return Promise.resolve(notFound());
    });

    useImageUpdatesMock.mockReturnValue({
      stackUpdates: {
        'ok.yml': { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1 },
        'partial.yml': { hasUpdate: true, checkStatus: 'partial', lastError: 'timeout', checkedAt: 1 },
        'failed.yml': { hasUpdate: true, checkStatus: 'failed', lastError: 'unreachable', checkedAt: 1 },
      },
      refresh: vi.fn(),
      sidebarIndicators: true,
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    return result;
  }

  it('counts only ok+true stacks under Updates', async () => {
    const result = await loadStacks();
    expect(result.current.filterCounts.updates).toBe(1);
  });

  it('filters the Updates chip to confirmed stacks only', async () => {
    const result = await loadStacks();
    await act(async () => {
      result.current.setFilterChip('updates');
    });
    expect(result.current.chipFilteredFiles).toEqual(['ok.yml']);
  });
});

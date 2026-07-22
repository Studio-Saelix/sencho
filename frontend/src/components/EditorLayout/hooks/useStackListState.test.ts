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

import { useStackListState } from './useStackListState';

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
  apiFetchMock.mockReset();
  useNodesMock.mockReset();
  useNodesMock.mockReturnValue({
    activeNode: { id: 1, name: 'Local', type: 'local' },
    nodes: [{ id: 1, name: 'Local', type: 'local' }],
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
});

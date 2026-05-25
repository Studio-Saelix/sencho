import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const useAuthMock = vi.fn();
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils');
  return {
    ...actual,
    visibilityInterval: () => () => {},
  };
});

import { useMeshDataPlane } from '../useMeshDataPlane';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function statusJson(status: number, payload: unknown = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  useAuthMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useMeshDataPlane', () => {
  it('does not fetch /mesh/status when the session is non-Admiral', async () => {
    useAuthMock.mockReturnValue({ permissions: { isAdmiral: false } });
    const { result } = renderHook(() => useMeshDataPlane());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('fetches once on mount and surfaces the localDataPlane payload for Admiral', async () => {
    useAuthMock.mockReturnValue({ permissions: { isAdmiral: true } });
    apiFetchMock.mockResolvedValue(okJson({
      localDataPlane: { ok: true, reason: null, lastChecked: 1000 },
    }));

    const { result } = renderHook(() => useMeshDataPlane());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(apiFetchMock).toHaveBeenCalledWith('/mesh/status', expect.objectContaining({ localOnly: true }));
    expect(result.current.status).toEqual({ ok: true, reason: null, lastChecked: 1000 });
    expect(result.current.loading).toBe(false);
  });

  it('keeps status null on a 403 response without raising an error', async () => {
    useAuthMock.mockReturnValue({ permissions: { isAdmiral: true } });
    apiFetchMock.mockResolvedValue(statusJson(403, { error: 'forbidden' }));

    const { result } = renderHook(() => useMeshDataPlane());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.status).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('falls back to null when the response omits localDataPlane', async () => {
    useAuthMock.mockReturnValue({ permissions: { isAdmiral: true } });
    apiFetchMock.mockResolvedValue(okJson({ nodes: [] }));

    const { result } = renderHook(() => useMeshDataPlane());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.status).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

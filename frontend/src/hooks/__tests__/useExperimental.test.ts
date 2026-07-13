import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useExperimental,
  __resetExperimentalCacheForTests,
} from '../useExperimental';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

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
  __resetExperimentalCacheForTests();
  apiFetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useExperimental', () => {
  it('stays unready then settles to true when /meta eventually returns experimental', async () => {
    let resolve!: (value: Response) => void;
    apiFetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));

    const { result } = renderHook(() => useExperimental());
    expect(result.current.experimentalReady).toBe(false);
    expect(result.current.experimental).toBe(false);

    await act(async () => {
      resolve(okJson({ experimental: true }));
    });

    await waitFor(() => expect(result.current.experimentalReady).toBe(true));
    expect(result.current.experimental).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledWith('/meta', expect.objectContaining({ localOnly: true }));
  });

  it('settles fail-closed on non-OK /meta', async () => {
    apiFetchMock.mockResolvedValue(statusJson(500, { error: 'boom' }));
    const { result } = renderHook(() => useExperimental());
    await waitFor(() => expect(result.current.experimentalReady).toBe(true));
    expect(result.current.experimental).toBe(false);
  });

  it('settles false for malformed payloads that omit experimental true', async () => {
    apiFetchMock.mockResolvedValue(okJson({ experimental: 'yes' }));
    const { result } = renderHook(() => useExperimental());
    await waitFor(() => expect(result.current.experimentalReady).toBe(true));
    expect(result.current.experimental).toBe(false);
  });

  it('settles fail-closed when the request throws', async () => {
    apiFetchMock.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useExperimental());
    await waitFor(() => expect(result.current.experimentalReady).toBe(true));
    expect(result.current.experimental).toBe(false);
  });

  it('dedupes concurrent callers onto one /meta fetch and shares the cache', async () => {
    apiFetchMock.mockResolvedValue(okJson({ experimental: true }));
    const a = renderHook(() => useExperimental());
    const b = renderHook(() => useExperimental());
    await waitFor(() => expect(a.result.current.experimentalReady).toBe(true));
    await waitFor(() => expect(b.result.current.experimentalReady).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(a.result.current.experimental).toBe(true);
    expect(b.result.current.experimental).toBe(true);

    const c = renderHook(() => useExperimental());
    expect(c.result.current.experimentalReady).toBe(true);
    expect(c.result.current.experimental).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
});

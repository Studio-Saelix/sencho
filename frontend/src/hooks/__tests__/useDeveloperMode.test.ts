import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { useDeveloperMode } from '../useDeveloperMode';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function settingsResponse(developerMode: string) {
  return { ok: true, status: 200, json: async () => ({ developer_mode: developerMode }) };
}

beforeEach(() => {
  mockedFetch.mockReset();
  // Failures are logged, not thrown; silence the expected console noise.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDeveloperMode', () => {
  it('enables when the active node has developer_mode on', async () => {
    mockedFetch.mockResolvedValue(settingsResponse('1'));
    const { result } = renderHook(() => useDeveloperMode(1));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('discards a delayed node A response after switching to node B', async () => {
    mockedFetch.mockImplementation((_url: string, opts?: { nodeId?: number | null }) => {
      if (opts?.nodeId === 1) {
        // Node A: developer mode on, but its response is slow.
        return new Promise((resolve) => setTimeout(() => resolve(settingsResponse('1')), 50));
      }
      // Node B: developer mode off, fast.
      return Promise.resolve(settingsResponse('0'));
    });

    const { result, rerender } = renderHook(({ id }) => useDeveloperMode(id), {
      initialProps: { id: 1 as number | undefined },
    });
    rerender({ id: 2 });

    await waitFor(() => expect(result.current).toBe(false));
    // Node A's late response must not flip node B to enabled.
    await new Promise((r) => setTimeout(r, 80));
    expect(result.current).toBe(false);
  });

  it('returns false when the settings fetch rejects', async () => {
    mockedFetch.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useDeveloperMode(1));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('returns false on a non-ok settings response', async () => {
    mockedFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useDeveloperMode(1));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('refetches when a developer_mode settings change is broadcast', async () => {
    let dev = '0';
    mockedFetch.mockImplementation(() => Promise.resolve(settingsResponse(dev)));
    const { result } = renderHook(() => useDeveloperMode(1));
    await waitFor(() => expect(result.current).toBe(false));

    dev = '1';
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_SETTINGS_CHANGED, { detail: { changedKeys: ['developer_mode'] } }),
      );
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('ignores a settings change that does not touch developer_mode', async () => {
    mockedFetch.mockResolvedValue(settingsResponse('0'));
    const { result } = renderHook(() => useDeveloperMode(1));
    await waitFor(() => expect(result.current).toBe(false));

    const callsBefore = mockedFetch.mock.calls.length;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_SETTINGS_CHANGED, { detail: { changedKeys: ['log_retention_days'] } }),
      );
    });
    expect(mockedFetch.mock.calls.length).toBe(callsBefore);
  });
});

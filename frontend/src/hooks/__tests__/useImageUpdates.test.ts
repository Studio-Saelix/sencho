import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { useImageUpdates } from '../useImageUpdates';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

describe('useImageUpdates', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('loads the rich detail map from /image-updates/detail', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/detail') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            web: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 5 },
            api: { hasUpdate: false, checkStatus: 'failed', lastError: 'Registry unreachable', checkedAt: 6 },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });

    const { result } = renderHook(() => useImageUpdates(1));

    await waitFor(() => expect(result.current.stackUpdates.web).toBeDefined());
    expect(result.current.stackUpdates.web.hasUpdate).toBe(true);
    expect(result.current.stackUpdates.api.checkStatus).toBe('failed');
    expect(result.current.stackUpdates.api.lastError).toBe('Registry unreachable');
  });

  it('falls back to the boolean map when /detail 404s (older remote node)', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/detail') {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      if (url === '/image-updates') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ web: true, api: false }) });
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    });

    const { result } = renderHook(() => useImageUpdates(1));

    await waitFor(() => expect(result.current.stackUpdates.web).toBeDefined());
    // Boolean map is synthesized into the rich shape with checkStatus 'ok'.
    expect(result.current.stackUpdates.web).toEqual({ hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 0 });
    expect(result.current.stackUpdates.api.hasUpdate).toBe(false);
  });

  it('clears stack updates when status reports checks disabled', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/status') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            checking: false,
            intervalMinutes: 120,
            lastCheckedAt: null,
            nextCheckAt: null,
            manualCooldownMinutes: 2,
            manualCooldownRemainingMs: 0,
            mode: 'interval',
            cronExpression: null,
            enabled: false,
          }),
        });
      }
      if (url === '/image-updates/detail') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            web: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 5 },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    });

    const { result } = renderHook(() => useImageUpdates(1));

    await waitFor(() => expect(result.current.checksEnabled).toBe(false));
    expect(result.current.stackUpdates).toEqual({});
  });

  it('retains disabled hub observations and reads overlay status without remote routing', async () => {
    mockedFetch.mockImplementation((url: string) => Promise.resolve({
      ok: true, status: 200,
      json: async () => url.includes('/overlay-status')
        ? { enabled: false, sidebarIndicators: true, scannerOwner: 'hub', capability: 'remote-image-inspect-v1' }
        : { web: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 5 } },
    }));
    const { result } = renderHook(() => useImageUpdates(2, true));
    await waitFor(() => expect(result.current.stackUpdates.web).toBeDefined());
    expect(result.current.checksEnabled).toBe(false);
    expect(result.current.sidebarIndicators).toBe(true);
    expect(mockedFetch).toHaveBeenCalledWith('/image-updates/overlay-status?targetNodeId=2', { nodeId: null });
    expect(mockedFetch).not.toHaveBeenCalledWith('/image-updates/status', expect.anything());
    expect(mockedFetch).toHaveBeenCalledWith('/image-updates/detail', { nodeId: 2 });
  });

  it('respects a target-owned response when remote inspection is no longer supported', async () => {
    mockedFetch.mockImplementation((url: string) => Promise.resolve({
      ok: true, status: 200,
      json: async () => url.includes('/overlay-status')
        ? { enabled: false, sidebarIndicators: false, scannerOwner: 'target', capability: null }
        : { web: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 5 } },
    }));
    const { result } = renderHook(() => useImageUpdates(2, true));
    await waitFor(() => expect(result.current.checksEnabled).toBe(false));
    expect(result.current.stackUpdates).toEqual({});
  });

  it('ignores an overlay response after switching nodes', async () => {
    let release!: (value: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    mockedFetch.mockImplementation((url: string) => Promise.resolve({
      ok: true, status: 200,
      json: () => url.includes('targetNodeId=2') ? held : Promise.resolve(
        url.includes('/overlay-status')
          ? { enabled: true, sidebarIndicators: false, scannerOwner: 'hub', capability: 'remote-image-inspect-v1' }
          : { current: { hasUpdate: false, checkStatus: 'ok', lastError: null, checkedAt: 6 } },
      ),
    }));
    const { result, rerender } = renderHook(({ id }) => useImageUpdates(id, true), { initialProps: { id: 2 } });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/image-updates/overlay-status?targetNodeId=2', { nodeId: null }));
    rerender({ id: 3 });
    await waitFor(() => expect(result.current.stackUpdates.current).toBeDefined());
    await act(async () => release({ enabled: false, sidebarIndicators: true, scannerOwner: 'hub', capability: 'remote-image-inspect-v1' }));
    expect(result.current.checksEnabled).toBe(true);
    expect(result.current.sidebarIndicators).toBe(false);
    expect(mockedFetch).not.toHaveBeenCalledWith('/image-updates/detail', { nodeId: 2 });
  });

  it('refreshes when SENCHO_SETTINGS_CHANGED includes image_update_checks_enabled', async () => {
    let statusCalls = 0;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/status') {
        statusCalls += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            checking: false,
            intervalMinutes: 120,
            lastCheckedAt: null,
            nextCheckAt: Date.now() + 60_000,
            manualCooldownMinutes: 2,
            manualCooldownRemainingMs: 0,
            mode: 'interval',
            cronExpression: null,
            enabled: true,
            sidebarIndicators: true,
          }),
        });
      }
      if (url === '/image-updates/detail') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    });

    renderHook(() => useImageUpdates(1));
    await waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(1));
    const before = statusCalls;
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED, {
        detail: { changedKeys: ['image_update_checks_enabled'] },
      }));
    });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(before));
  });
});

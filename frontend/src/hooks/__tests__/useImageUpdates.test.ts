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

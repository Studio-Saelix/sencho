import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
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
});

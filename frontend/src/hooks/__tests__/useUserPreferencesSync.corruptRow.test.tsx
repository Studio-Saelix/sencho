/**
 * Corrupt-row reconciliation through the real sync owner hook path (not just
 * the bus primitives): a GET that returns a corrupt row must adopt the calm
 * defaults locally (the pre-edit values never render) and repair the row with
 * a conditional PUT carrying the corrupt row's revision, so a concurrent
 * writer cannot be clobbered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (path: string, opts?: unknown) => apiFetch(path, opts) }));

const authState = { user: null as { userId: number } | null, appStatus: 'loading' as 'loading' | 'authenticated' | 'unauthenticated' };
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
}));

import { useUserPreferencesSync } from '../useUserPreferencesSync';
import { currentThemeState } from '@/hooks/use-theme';

function jsonResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => body,
        clone() { return this as Response; },
    } as unknown as Response;
}

function recordedCalls(): Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> {
  return apiFetch.mock.calls.map(([path, opts]) => ({
    method: (opts as RequestInit | undefined)?.method ?? 'GET',
    path: path as string,
    body: JSON.parse(((opts as RequestInit | undefined)?.body as string | undefined) ?? 'null'),
  }));
}

function SyncOwner(): null {
  useUserPreferencesSync();
  return null;
}

describe('useUserPreferencesSync: corrupt-row repair through the hook path', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    localStorage.clear();
    authState.user = { userId: 9 };
    authState.appStatus = 'authenticated';
  });

  afterEach(() => {
    cleanup();
  });

  it('hydrates defaults and sends a conditional repair PUT on the corrupt revision', async () => {
    // Leave a stale cached theme so the assertion proves the corrupt row
    // (not the cache) decides what renders.
    localStorage.setItem('sencho.appearance.theme', JSON.stringify({ theme: 'oled' }));
    apiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (String(path) === '/user-preferences' && (opts?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, {
          preferences: {
            appearance: { corrupt: true, schemaVersion: 1, revision: 6, updatedAt: 1 },
            navigation: { corrupt: true, schemaVersion: 1, revision: 6, updatedAt: 1 },
          },
        });
      }
      return jsonResponse(200, { domain: 'x', schemaVersion: 1, revision: 7, updatedAt: 1 });
    });

    render(<SyncOwner />);
    await act(async () => {
      await vi.waitFor(() => {
        expect(recordedCalls().some((c) => c.method === 'PUT')).toBe(true);
      });
    });

    const put = recordedCalls().find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put?.path).toBe('/user-preferences/appearance');
    // Conditional on the corrupt row's own revision: never an unguarded write.
    expect(put?.body).toMatchObject({ expectedRevision: 6, theme: 'dim' });

    // Defaults are live locally (the module state the UI renders from); the
    // stale cache key is wiped by the ownership claim because this test's
    // browser has no prior owner marker.
    expect(currentThemeState().theme).toBe('dim');

    // No migration was attempted (a corrupt row is repaired, not re-created).
    expect(recordedCalls().filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

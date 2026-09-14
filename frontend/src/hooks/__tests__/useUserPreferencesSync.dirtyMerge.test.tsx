import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (path: string, opts?: unknown) => apiFetch(path, opts) }));

const authState = { user: null as { userId: number } | null, appStatus: 'loading' as 'loading' | 'authenticated' | 'unauthenticated' };
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
}));

import { useUserPreferencesSync } from '../useUserPreferencesSync';
import { applyThemeState } from '@/hooks/use-theme';
import {
  bumpGeneration,
  currentGeneration,
  getUnsavedEpisode,
  notifyPreferenceWrite,
  resetPreferenceSync,
} from '@/lib/preferences/preferenceEvents';
import { setCurrentSyncUser, setHydratingDomains } from '@/lib/preferences/syncBus';

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  clone: () => MockResponse;
}

function jsonResponse(status: number, body: unknown): MockResponse {
  const response: MockResponse = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    clone: () => response,
  };
  return response;
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

/** Drain microtasks and the 400ms write debounce without fake timers. */
async function flushDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 450));
}

describe('useUserPreferencesSync: dirty-field merge against a late hydration GET', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    localStorage.clear();
    // use-theme keeps module state across tests in this file, and its setState
    // skips no-op writes: without forcing the state back to the app default,
    // a test whose edit matches the previous test's final theme would never
    // re-write the raw cache this file asserts on.
    applyThemeState({ theme: 'dim' });
    setCurrentSyncUser(9);
    authState.user = { userId: 9 };
    authState.appStatus = 'authenticated';
    setHydratingDomains(new Set());
    resetPreferenceSync();
  });

  afterEach(() => {
    cleanup();
  });

  it('a user edit landing before the hydration GET response survives the merge and the PUT carries its local value', async () => {
    // Server truth: OLED theme. The user has already switched to light while
    // the GET was in flight; the merge must keep the server's untouched
    // fields but re-apply the dirty theme on top.
    let resolveGet: ((r: MockResponse) => void) | undefined;
    apiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (String(path) === '/user-preferences' && (opts?.method ?? 'GET') === 'GET') {
        return new Promise<MockResponse>((resolve) => { resolveGet = resolve; });
      }
      if (opts?.method === 'PUT') {
        return jsonResponse(200, { domain: 'appearance', schemaVersion: 1, revision: 2, updatedAt: 1 });
      }
      return jsonResponse(200, { preferences: {} });
    });

    render(<SyncOwner />);
    // The hydration GET is hanging; the user edits the theme meanwhile.
    applyThemeState({ theme: 'light' });
    notifyPreferenceWrite('appearance', ['theme']);

    // The queued PUT fires after the debounce while the GET is still pending;
    // the known revision is null, so the bus GETs a baseline first. Let those
    // baseline calls go out now so only the hydration GET remains pending.
    await act(async () => {
      await flushDebounce();
    });
    apiFetch.mockClear();

    // Now the hydration GET resolves with the server document.
    await act(async () => {
      resolveGet?.(jsonResponse(200, {
        preferences: {
          appearance: {
            schemaVersion: 1, revision: 1, updatedAt: 1,
            data: {
              theme: 'oled', accent: 'cyan', uiFont: 'Geist', monoFont: 'Geist Mono',
              visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
              density: 'comfortable', logChipColorMode: 'unified',
              borderBoost: 0, glow: 0.16, contrast: 0, typeScale: 1,
              reducedEffects: true, reducedMotion: true, readability: false,
            },
          },
          navigation: null,
        },
      }));
      await vi.waitFor(() => {
        expect(recordedCalls().some((c) => c.method === 'PUT')).toBe(true);
      });
    });

    const calls = recordedCalls();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    // The merged PUT carries the dirty field's LOCAL value (light), not the
    // server's (oled); untouched fields keep the server values.
    expect(put?.body).toMatchObject({ expectedRevision: 1, theme: 'light', accent: 'cyan', visualStyle: 'calm' });
    // Local state keeps the user's edit too.
    expect(JSON.parse(localStorage.getItem('sencho.appearance.theme') as string)).toMatchObject({ theme: 'light' });
  });

  it('a 409 on the merged PUT reconciles against the returned current and re-PUTs on its revision', async () => {
    // Same merge scenario as above, but the server's merged PUT conflicts:
    // another writer advanced the row to revision 2. The owner must GET the
    // fresh state (reconcile), then re-PUT the merged document conditionally
    // on revision 2, still carrying the dirty local theme.
    let resolveGet: ((r: MockResponse) => void) | undefined;
    const serverDoc = {
      theme: 'oled', accent: 'cyan', uiFont: 'Geist', monoFont: 'Geist Mono',
      visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
      density: 'comfortable', logChipColorMode: 'unified',
      borderBoost: 0, glow: 0.16, contrast: 0, typeScale: 1,
      reducedEffects: true, reducedMotion: true, readability: false,
    };
    apiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (String(path) === '/user-preferences' && (opts?.method ?? 'GET') === 'GET') {
        return new Promise<MockResponse>((resolve) => { resolveGet = resolve; });
      }
      if (opts?.method === 'PUT') {
        // Only the merged PUT (expectedRevision 1) conflicts; the reconciled
        // retry on revision 2 succeeds, so exactly one conflict is exercised.
        const rev = JSON.parse((opts?.body as string)).expectedRevision;
        if (rev === 1) {
          return jsonResponse(409, { error: 'CONFLICT', current: { schemaVersion: 1, revision: 2, updatedAt: 1, data: serverDoc } });
        }
        return jsonResponse(200, { domain: 'appearance', schemaVersion: 1, revision: 3, updatedAt: 2 });
      }
      return jsonResponse(200, { preferences: { appearance: { schemaVersion: 1, revision: 2, updatedAt: 1, data: serverDoc }, navigation: null } });
    });

    render(<SyncOwner />);
    applyThemeState({ theme: 'light' });
    notifyPreferenceWrite('appearance', ['theme']);
    await act(async () => {
      await flushDebounce();
    });
    apiFetch.mockClear();

    // The hydration GET resolves; the queued PUT then goes out and 409s.
    await act(async () => {
      resolveGet?.(jsonResponse(200, {
        preferences: { appearance: { schemaVersion: 1, revision: 1, updatedAt: 1, data: serverDoc }, navigation: null },
      }));
      await vi.waitFor(() => {
        expect(recordedCalls().some((c) => c.method === 'PUT')).toBe(true);
      });
    });

    // One conflict is not a failure: the owner reconciled instead.
    expect(getUnsavedEpisode()).toBeNull();
    await act(async () => {
      await vi.waitFor(() => {
        const puts = recordedCalls().filter((c) => c.method === 'PUT');
        expect(puts.length).toBe(2);
        // The retried PUT is conditional on the conflicted row's revision.
        expect(puts[1].body).toMatchObject({ expectedRevision: 2, theme: 'light', accent: 'cyan' });
      });
    });
    expect(getUnsavedEpisode()).toBeNull();
  });

  it('two consecutive 409s stop retrying and surface the unsaved episode with dirty fields kept', async () => {
    let resolveGet: ((r: MockResponse) => void) | undefined;
    const serverDoc = {
      theme: 'oled', accent: 'cyan', uiFont: 'Geist', monoFont: 'Geist Mono',
      visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
      density: 'comfortable', logChipColorMode: 'unified',
      borderBoost: 0, glow: 0.16, contrast: 0, typeScale: 1,
      reducedEffects: true, reducedMotion: true, readability: false,
    };
    apiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (String(path) === '/user-preferences' && (opts?.method ?? 'GET') === 'GET') {
        return new Promise<MockResponse>((resolve) => { resolveGet = resolve; });
      }
      if (opts?.method === 'PUT') {
        return jsonResponse(409, { error: 'CONFLICT', current: { schemaVersion: 1, revision: 2, updatedAt: 1, data: serverDoc } });
      }
      return jsonResponse(200, { preferences: { appearance: { schemaVersion: 1, revision: 2, updatedAt: 1, data: serverDoc }, navigation: null } });
    });

    render(<SyncOwner />);
    applyThemeState({ theme: 'light' });
    notifyPreferenceWrite('appearance', ['theme']);
    await act(async () => {
      await flushDebounce();
    });
    apiFetch.mockClear();

    await act(async () => {
      resolveGet?.(jsonResponse(200, {
        preferences: { appearance: { schemaVersion: 1, revision: 1, updatedAt: 1, data: serverDoc }, navigation: null },
      }));
      await vi.waitFor(() => {
        // Exactly two PUT attempts: the second conflict stops the loop and
        // surfaces the failure instead of retrying forever.
        expect(recordedCalls().filter((c) => c.method === 'PUT').length).toBe(2);
      });
    });

    expect(getUnsavedEpisode()).not.toBeNull();
    // The dirty field was re-marked so a later reconciliation re-applies it;
    // the local cache still holds the user's edit.
    expect(JSON.parse(localStorage.getItem('sencho.appearance.theme') as string)).toMatchObject({ theme: 'light' });
  });

  it('an identity transition before the hydration GET resolves discards the in-flight result', async () => {
    // The GET hangs past a logout: its response must be dropped (no merge,
    // no PUT) so the next account's hydration is never polluted.
    let resolveGet: ((r: MockResponse) => void) | undefined;
    apiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (String(path) === '/user-preferences' && (opts?.method ?? 'GET') === 'GET') {
        return new Promise<MockResponse>((resolve) => { resolveGet = resolve; });
      }
      return jsonResponse(200, { preferences: { appearance: null, navigation: null } });
    });

    render(<SyncOwner />);
    apiFetch.mockClear();
    const generationBefore = currentGeneration();
    act(() => {
      bumpGeneration(); // logout path
    });
    await act(async () => {
      resolveGet?.(jsonResponse(200, {
        preferences: {
          appearance: { schemaVersion: 1, revision: 1, updatedAt: 1, data: serverDocFor() },
          navigation: null,
        },
      }));
      // Wait out a real tick so a missing generation guard would have had
      // time to dispatch the follow-up PUT.
      await vi.waitFor(() => {
        expect(recordedCalls()).toHaveLength(0);
      });
    });

    expect(recordedCalls()).toHaveLength(0);
    expect(currentGeneration()).toBeGreaterThan(generationBefore);
  });
});

/** A full appearance server document for response bodies. */
function serverDocFor(): Record<string, unknown> {
  return {
    theme: 'oled', accent: 'cyan', uiFont: 'Geist', monoFont: 'Geist Mono',
    visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
    density: 'comfortable', logChipColorMode: 'unified',
    borderBoost: 0, glow: 0.16, contrast: 0, typeScale: 1,
    reducedEffects: true, reducedMotion: true, readability: false,
  };
}

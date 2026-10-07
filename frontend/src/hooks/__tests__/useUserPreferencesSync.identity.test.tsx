/**
 * Identity guards at the hook level. The sync owner must never let one
 * account's queued edits, revisions, or cached values leak into another
 * account's session:
 * - A different account claims the browser: the cache is wiped and the owner
 *   marker is re-stamped before hydration.
 * - A failed write keeps its unsaved episode only for the account that
 *   captured it; an identity transition clears the whole bus (queue,
 *   failures, known revisions) so a Retry can never replay under a new
 *   account.
 * - While auth is resolving (loading), the owner touches nothing: a normal
 *   boot must not erase cached values.
 * - A resolved-unauthenticated state keeps the cache and its owner marker (a
 *   same-account re-login still owns them); the marker mismatch at the next
 *   login is what wipes a different account's values.
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
import {
  bumpGeneration,
  resetPreferenceSync,
  subscribeToUnsaved,
  getUnsavedEpisode,
  currentGeneration,
} from '@/lib/preferences/preferenceEvents';
import {
  inspectQueue,
  retryDomain,
  setCurrentSyncUser,
  setHydratingDomains,
  queueReset,
} from '@/lib/preferences/syncBus';
import {
  PREFERENCES_OWNER_KEY,
  defaultAppearanceDocument,
  hydrateAppearanceDocument,
} from '@/lib/preferences/preferencesDocuments';

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

function SyncOwner(): null {
  useUserPreferencesSync();
  return null;
}

describe('useUserPreferencesSync: identity guards', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    localStorage.clear();
    setCurrentSyncUser(null);
    authState.user = null;
    authState.appStatus = 'loading';
    setHydratingDomains(new Set());
    resetPreferenceSync();
  });

  afterEach(() => {
    cleanup();
  });

  it('a different account claims the browser: cache wiped, marker re-stamped, prior queue dropped', async () => {
    // Account 7 left cached values and a queued reset in the bus.
    localStorage.setItem('sencho.appearance.theme', JSON.stringify({ theme: 'oled' }));
    localStorage.setItem(PREFERENCES_OWNER_KEY, JSON.stringify({ userId: 7, schema: 1 }));
    setCurrentSyncUser(7);
    queueReset('appearance');

    // Account 3 signs in; hydration for account 3 sees the (empty) server.
    apiFetch.mockImplementation(async () => jsonResponse(200, {
      preferences: { appearance: null, navigation: null },
    }));

    authState.user = { userId: 3 };
    authState.appStatus = 'authenticated';
    render(<SyncOwner />);
    await act(async () => {
      await vi.waitFor(() => {
        expect(apiFetch.mock.calls.some(([path]) => String(path) === '/user-preferences')).toBe(true);
      });
    });

    // The stale cache was wiped before hydration; the marker now names 3.
    expect(localStorage.getItem('sencho.appearance.theme')).toBeNull();
    expect(JSON.parse(localStorage.getItem(PREFERENCES_OWNER_KEY) as string)).toMatchObject({ userId: 3 });
    // The old account's queued operation was discarded by the queue reset:
    // no DELETE may fire for appearance under the new account.
    const calls = apiFetch.mock.calls.filter(([, opts]) => (opts as RequestInit | undefined)?.method === 'DELETE');
    expect(calls).toHaveLength(0);
    // Hydration ran for the new account (a GET went out).
    expect(apiFetch.mock.calls.some(([path]) => String(path) === '/user-preferences')).toBe(true);
  });

  it('a different account claims a browser holding the previous account\'s live values: they are reset', async () => {
    // The previous account's hydration left its values in the live stores
    // (theme state and density class), not only in localStorage.
    hydrateAppearanceDocument({
      ...defaultAppearanceDocument(),
      theme: 'oled',
      accent: 'violet',
      density: 'compact',
      fleetTabLayout: 'compact',
    });
    localStorage.setItem(PREFERENCES_OWNER_KEY, JSON.stringify({ userId: 7, schema: 1 }));

    // Account 3 signs in with no server rows: its migration must carry
    // defaults, never account 7's live values.
    apiFetch.mockImplementation(async () => jsonResponse(200, {
      preferences: { appearance: null, navigation: null },
    }));

    authState.user = { userId: 3 };
    authState.appStatus = 'authenticated';
    render(<SyncOwner />);
    await act(async () => {
      await vi.waitFor(() => {
        expect(apiFetch.mock.calls.some(([path]) => String(path) === '/user-preferences')).toBe(true);
      });
    });

    // The live stores were reset with the cache, so nothing of account 7's
    // look can render or be written under account 3.
    expect(document.body.classList.contains('density-compact')).toBe(false);
    const migrateCall = apiFetch.mock.calls.find(
      ([path, opts]) => String(path).endsWith('/appearance/migrate') && (opts as RequestInit | undefined)?.method === 'POST',
    );
    await vi.waitFor(() => expect(migrateCall).toBeDefined());
    const body = JSON.parse(((migrateCall?.[1] as RequestInit).body) as string);
    expect(body).toMatchObject({ theme: 'dim', accent: 'cyan', density: 'comfortable', fleetTabLayout: 'flat' });
  });

  it('a failed write of the old account cannot be retried after the identity transition', async () => {
    // Account 7 queues a reset; the DELETE fails (server 500), leaving a
    // failed operation and an unsaved episode.
    setCurrentSyncUser(7);
    authState.user = { userId: 7 };
    authState.appStatus = 'authenticated';
    apiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      if ((opts?.method ?? 'GET') === 'DELETE') return jsonResponse(500, { error: 'unavailable' });
      return jsonResponse(200, { preferences: { appearance: null, navigation: null } });
    });

    const seen: Array<unknown> = [];
    const stop = subscribeToUnsaved((episode) => seen.push(episode));

    render(<SyncOwner />);
    await act(async () => {
      await vi.waitFor(() => {
        expect(apiFetch.mock.calls.some(([path]) => String(path) === '/user-preferences')).toBe(true);
      });
    });
    // The hydration itself succeeded (absent rows); the reset DELETE queued
    // during mount drains separately, so wait for its failure to settle.
    queueReset('appearance');
    await act(async () => {
      await vi.waitFor(() => {
        expect(inspectQueue('appearance').failed).toBe('reset');
        expect(getUnsavedEpisode()).not.toBeNull();
      });
    });

    // The account switches (logout bumps the generation and resets the bus;
    // this is exactly what AuthContext.noteIdentityTransition does).
    apiFetch.mockClear();
    act(() => {
      bumpGeneration();
      resetPreferenceSync();
    });

    // The failed operation, its episode, and the queue are all gone: a Retry
    // action from a stale toast has nothing to replay.
    expect(inspectQueue('appearance')).toEqual({ kind: null, failed: null, settling: false });
    expect(getUnsavedEpisode()).toBeNull();
    stop();

    // Even a direct retry call after the transition must never replay the
    // old failed DELETE: the failed operation is gone, so the most the retry
    // can do is delegate to the reconcile hook (a fresh GET for whatever
    // account is current now), never re-send the tombstone.
    apiFetch.mockImplementation(async () => jsonResponse(200, { preferences: { appearance: null, navigation: null } }));
    retryDomain('appearance');
    const deletes = apiFetch.mock.calls.filter(([, opts]) => (opts as RequestInit | undefined)?.method === 'DELETE');
    expect(deletes).toHaveLength(0);
  });

  it('auth loading touches nothing: a normal boot does not wipe the cache', () => {
    localStorage.setItem('sencho.appearance.theme', JSON.stringify({ theme: 'oled' }));
    localStorage.setItem(PREFERENCES_OWNER_KEY, JSON.stringify({ userId: 7, schema: 1 }));

    // appStatus 'loading' with a resolved user id is the mid-boot state.
    authState.user = { userId: 7 };
    authState.appStatus = 'loading';
    render(<SyncOwner />);

    expect(localStorage.getItem('sencho.appearance.theme')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(PREFERENCES_OWNER_KEY) as string)).toMatchObject({ userId: 7 });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('a marker-less upgraded profile keeps the legacy cache and migrates those values', async () => {
    // Pre-sync profile: explicit prefs written by the local-only app, and no
    // owner marker (the marker shipped with server-backed sync). The first
    // sync must treat the cache as this account's migration source, not as a
    // foreign cache to wipe. The seeded keys are the ones the document
    // builders read live from localStorage (theme fields come from the theme
    // store's module state and are covered end to end in the E2E suite).
    localStorage.setItem('sencho.appearance.density', 'compact');
    localStorage.setItem('sencho.appearance.topNavMode', 'smart');
    localStorage.setItem('sencho.appearance.topNavLabels', 'false');
    localStorage.setItem('sencho.appearance.topNavAlign', 'center');
    localStorage.setItem('sencho.log-chip-color-mode', 'per-service');
    localStorage.setItem('sencho.appearance.topNavQuickLinks', JSON.stringify(['dashboard', 'fleet']));

    // Absent server rows: the upgrade path is the migration path.
    apiFetch.mockImplementation(async () => jsonResponse(200, {
      preferences: { appearance: null, navigation: null },
    }));

    authState.user = { userId: 3 };
    authState.appStatus = 'authenticated';
    render(<SyncOwner />);
    await act(async () => {
      await vi.waitFor(() => {
        expect(apiFetch.mock.calls.some(([path]) => String(path) === '/user-preferences')).toBe(true);
      });
    });

    // The cache survived and now names this account as its owner.
    expect(localStorage.getItem('sencho.appearance.density')).toBe('compact');
    expect(localStorage.getItem('sencho.appearance.topNavMode')).toBe('smart');
    expect(localStorage.getItem('sencho.appearance.topNavLabels')).toBe('false');
    expect(localStorage.getItem('sencho.appearance.topNavAlign')).toBe('center');
    expect(localStorage.getItem('sencho.log-chip-color-mode')).toBe('per-service');
    expect(JSON.parse(localStorage.getItem(PREFERENCES_OWNER_KEY) as string)).toMatchObject({ userId: 3 });

    // Both migrate documents carry the explicit values, not defaults.
    const migrateCall = (suffix: string) => apiFetch.mock.calls.find(
      ([path, opts]) => String(path).endsWith(suffix) && (opts as RequestInit | undefined)?.method === 'POST',
    );
    await vi.waitFor(() => expect(migrateCall('/appearance/migrate')).toBeDefined());
    await vi.waitFor(() => expect(migrateCall('/navigation/migrate')).toBeDefined());
    const appearanceBody = JSON.parse(((migrateCall('/appearance/migrate')?.[1] as RequestInit).body) as string);
    expect(appearanceBody).toMatchObject({ density: 'compact', logChipColorMode: 'per-service' });
    const navigationBody = JSON.parse(((migrateCall('/navigation/migrate')?.[1] as RequestInit).body) as string);
    expect(navigationBody).toMatchObject({
      mode: 'smart', labels: false, align: 'center', quickLinks: ['dashboard', 'fleet'],
    });
  });

  it('resolved-unauthenticated keeps the cache and marker and bumps the generation', () => {
    localStorage.setItem('sencho.appearance.theme', JSON.stringify({ theme: 'oled' }));
    localStorage.setItem('sencho.appearance.density', 'compact');
    localStorage.setItem(PREFERENCES_OWNER_KEY, JSON.stringify({ userId: 7, schema: 1 }));
    const generationBefore = currentGeneration();

    authState.user = null;
    authState.appStatus = 'unauthenticated';
    render(<SyncOwner />);

    // The owner marker is what proves ownership at the next login, so signing
    // out must not destroy it: a same-account re-login may still hydrate from
    // or migrate the cache, while a different account is wiped at claim time.
    expect(localStorage.getItem('sencho.appearance.theme')).not.toBeNull();
    expect(localStorage.getItem('sencho.appearance.density')).toBe('compact');
    expect(JSON.parse(localStorage.getItem(PREFERENCES_OWNER_KEY) as string)).toMatchObject({ userId: 7 });
    expect(currentGeneration()).toBeGreaterThan(generationBefore);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

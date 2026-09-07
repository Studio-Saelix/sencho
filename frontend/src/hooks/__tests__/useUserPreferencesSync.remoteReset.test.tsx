/**
 * Remote-reset precedence between two independent clients. The local
 * sequence counter orders only this client's own queued operations; a reset
 * performed in ANOTHER browser is ordered by the observable server revision
 * in the GET envelope. A pending edit based on an older revision must be
 * DISCARDED (no resurrect PUT) when reconciliation observes the tombstone;
 * only an edit made after adopting the tombstone survives as a conditional
 * PUT on the tombstone's revision.
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
import { applyThemeState } from '@/hooks/use-theme';
import {
  adoptKnownRevision,
  inspectQueue,
  setHydratingDomains,
  setCurrentSyncUser,
} from '@/lib/preferences/syncBus';
import { notifyPreferenceWrite } from '@/lib/preferences/preferenceEvents';

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

/** Drain the 400ms write debounce without fake timers: real waits inside act. */
async function flushDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 450));
}

/** Simulate client A: an edit enqueued, then the adoption of revision 2. */
function editThenAdoptStaleBaseline(): void {
  applyThemeState({ theme: 'oled' });
  notifyPreferenceWrite('appearance', ['theme']);
  adoptKnownRevision('appearance', 2);
}

describe('useUserPreferencesSync: remote-reset precedence (two clients)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    localStorage.clear();
    setCurrentSyncUser(9);
    authState.user = { userId: 9 };
    authState.appStatus = 'authenticated';
    setHydratingDomains(new Set());
  });

  afterEach(() => {
    cleanup();
  });

  it('discards a pending edit based on an older revision when a remote tombstone is observed', async () => {
    // Client A edits theme while offline (no server round trip yet), then
    // boots: its GET observes that client B reset the domain at revision 5
    // (schemaVersion 0 tombstone). The stale edit must be discarded.
    editThenAdoptStaleBaseline();
    apiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (String(path) === '/user-preferences' && (opts?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, {
          preferences: {
            appearance: { schemaVersion: 0, revision: 5, updatedAt: 1 },
            navigation: null,
          },
        });
      }
      return jsonResponse(200, { domain: 'appearance', schemaVersion: 1, revision: 6, updatedAt: 1 });
    });

    render(<SyncOwner />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No PUT of the stale pre-reset values may have gone out, and no
    // migrate either (a tombstone blocks migration).
    const calls = recordedCalls();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // The GET happened exactly once (the hydration fetch).
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);

    // The queue must be clear: the stale edit was discarded, not parked.
    expect(inspectQueue('appearance')).toEqual({ kind: null, failed: null, settling: false });

    // The tombstone was adopted: hydration applied defaults.
    expect(JSON.parse(localStorage.getItem('sencho.appearance.theme') as string)).toMatchObject({ theme: 'dim' });
  });

  it('an edit made after adopting the tombstone survives as a conditional PUT on the tombstone revision', async () => {
    // Boot against the tombstone first (clean adoption), then edit.
    apiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (String(path) === '/user-preferences' && (opts?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, {
          preferences: {
            appearance: { schemaVersion: 0, revision: 5, updatedAt: 1 },
            navigation: null,
          },
        });
      }
      if (opts?.method === 'PUT') return jsonResponse(200, { domain: 'appearance', schemaVersion: 1, revision: 6, updatedAt: 1 });
      return jsonResponse(200, { domain: 'appearance', schemaVersion: 1, revision: 6, updatedAt: 1 });
    });

    render(<SyncOwner />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(inspectQueue('appearance')).toEqual({ kind: null, failed: null, settling: false });

    // The user now edits AFTER the tombstone was adopted (revision 5 known).
    apiFetch.mockClear();
    applyThemeState({ theme: 'oled' });
    notifyPreferenceWrite('appearance', ['theme']);
    await act(async () => {
      await flushDebounce();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const put = recordedCalls().find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    // Conditional on the tombstone's revision (5): an unconditional or
    // stale-baselined write would 409 on the server.
    expect(put?.body).toMatchObject({ expectedRevision: 5, theme: 'oled' });
  });
});

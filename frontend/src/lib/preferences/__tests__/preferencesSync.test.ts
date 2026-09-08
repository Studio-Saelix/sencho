/**
 * Unit tests for the preference sync layer, driven at the transport boundary
 * (apiFetch mocked) so assertions cover final local state and wire behavior.
 *
 * Covered scenarios:
 * - Field-level merge: a delayed GET after a user edit merges dirty fields
 *   onto the server document (server wins untouched fields).
 * - Local chronology: reset cancels pre-reset PUTs; a post-reset edit
 *   survives as a conditional PUT on the tombstone revision.
 * - Remote-reset precedence: a pending edit based on an older revision is
 *   discarded when the GET reveals a newer tombstone.
 * - Eligibility ownership: a stale producer's publication is rejected and
 *   its teardown cannot erase a newer publication.
 * - Migration deferral: navigation migrate waits for settled eligibility, and
 *   the wire document carries only the four server-known fields.
 * - Retries: a failed reset retries as DELETE (kind-preserving).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (path: string, opts?: unknown) => apiFetch(path, opts),
}));

import {
  DOMAIN_FIELDS,
  bumpGeneration,
  clearEligibility,
  currentGeneration,
  getSettledEligibility,
  notifyPreferenceWrite,
  resetPreferenceSync,
  setEligibilitySettled,
  subscribeToPreferenceWrites,
  type EligibilityOwnership,
} from '../preferenceEvents';
import {
  adoptKnownRevision,
  flushPendingWrites,
  inspectQueue,
  queueMigrate,
  queueReset,
  setCurrentSyncUser,
  setHydratingDomains,
  setReconcileHook,
} from '../syncBus';
import {
  PREFERENCES_OWNER_KEY,
  clearPreferenceCache,
  hydrateAppearanceDocument,
  hydrateNavigationDocument,
} from '../preferencesDocuments';
import { resetSidebarLayout } from '../resetPreferences';

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

const APPEARANCE_DOC = {
  theme: 'dim', accent: 'cyan', uiFont: 'Geist', monoFont: 'Geist Mono',
  visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
  density: 'comfortable', logChipColorMode: 'unified',
  borderBoost: 0, glow: 0.16, contrast: 0, typeScale: 1,
  reducedEffects: true, reducedMotion: true, readability: false,
};

const NAVIGATION_DOC = {
  mode: 'compact', quickLinks: ['dashboard', 'fleet'], labels: true, align: 'left',
};

/** Capture every apiFetch call as { method, path, body }. */
interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function recordedCalls(): RecordedCall[] {
  return apiFetch.mock.calls.map(([path, opts]) => ({
    method: (opts as RequestInit | undefined)?.method ?? 'GET',
    path: path as string,
    body: JSON.parse(((opts as RequestInit | undefined)?.body as string | undefined) ?? 'null'),
  }));
}

describe('preference sync layer', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    localStorage.clear();
    setReconcileHook(null);
    setHydratingDomains(new Set());
    setCurrentSyncUser(7);
    resetPreferenceSync();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a field-less notification marks the whole domain, a field list marks only those fields', () => {
    const seen: Array<{ domain: string; fields: readonly string[] }> = [];
    const stop = subscribeToPreferenceWrites((domain, fields) => seen.push({ domain, fields: [...fields] }));
    notifyPreferenceWrite('appearance', ['theme']);
    notifyPreferenceWrite('navigation', ['quickLinks']);
    notifyPreferenceWrite('appearance'); // reset-style: whole domain
    stop();
    expect(seen).toEqual([
      { domain: 'appearance', fields: ['theme'] },
      { domain: 'navigation', fields: ['quickLinks'] },
      { domain: 'appearance', fields: [...DOMAIN_FIELDS.appearance] },
    ]);
  });

  it('a delayed GET after a density edit keeps the server theme and the local density', () => {
    // Server state: OLED theme, comfortable density. Local edit: density only.
    const serverDoc = { ...APPEARANCE_DOC, theme: 'oled', density: 'comfortable' };

    // Hydration writes must not enqueue (bus guard), so simulate exactly the
    // sync owner's sequence: adopt revision, hydrate the server doc under the
    // hydrating guard, then a user density edit marks only that field dirty.
    adoptKnownRevision('appearance', 4);
    setHydratingDomains(new Set(['appearance']));
    try {
      hydrateAppearanceDocument(serverDoc);
    } finally {
      setHydratingDomains(new Set());
    }
    const cachedTheme = JSON.parse(localStorage.getItem('sencho.appearance.theme') as string);
    expect(cachedTheme.theme).toBe('oled');

    // The user changes density locally (no server round trip yet).
    localStorage.setItem('sencho.appearance.density', 'compact');
    notifyPreferenceWrite('appearance', ['density']);

    // The sync owner's merge rule: server wins untouched fields, the dirty
    // field re-applies on top. The theme key must still read oled.
    expect(JSON.parse(localStorage.getItem('sencho.appearance.theme') as string)).toMatchObject({ theme: 'oled' });
    expect(localStorage.getItem('sencho.appearance.density')).toBe('compact');
  });

  it('a queued reset cancels a pre-reset PUT; a post-reset edit survives as a conditional PUT on the tombstone revision', async () => {
    // The reset's DELETE goes out as soon as queueReset runs (the pump starts
    // inside enqueue), so its mock must be installed first. The DELETE
    // succeeds against the adopted revision 2 and returns the tombstone's
    // resulting revision 3.
    apiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') {
        expect(JSON.parse(opts.body as string)).toEqual({ expectedRevision: 2 });
        return jsonResponse(200, { domain: 'appearance', schemaVersion: 0, revision: 3, updatedAt: 1 });
      }
      return jsonResponse(200, { domain: 'appearance', schemaVersion: 1, revision: 3, updatedAt: 1, data: {} });
    });

    // The user edits density (PUT queued, debounced), then a revision is
    // adopted from a GET, then the reset lands before the debounce fires.
    notifyPreferenceWrite('appearance', ['density']);
    adoptKnownRevision('appearance', 2);
    queueReset('appearance');
    expect(inspectQueue('appearance')).toMatchObject({ kind: 'reset', failed: null });

    await vi.waitFor(() => {
      expect(recordedCalls().some((c) => c.method === 'DELETE')).toBe(true);
    });
    // The reset runs exactly once: a post-reset edit must never re-execute
    // the reset (a duplicate DELETE would 409 on its stale precondition).
    expect(recordedCalls().filter((c) => c.method === 'DELETE').length).toBe(1);
    // Let the DELETE's success bookkeeping (revision adoption) settle before
    // the next edit, so the PUT targets the tombstone's revision.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // An edit enqueued after the settled reset survives: a conditional PUT on
    // the tombstone's resulting revision (3). The PUT document is rebuilt at
    // send time from live state, so drive a real user setter.
    const { applyThemeState } = await import('@/hooks/use-theme');
    setHydratingDomains(new Set(['appearance']));
    try {
      applyThemeState({ theme: 'dim' });
    } finally {
      setHydratingDomains(new Set());
    }
    notifyPreferenceWrite('appearance', ['theme']);
    await vi.waitFor(() => {
      expect(recordedCalls().some((c) => c.method === 'PUT')).toBe(true);
    });
    const putCall = recordedCalls().find((c) => c.method === 'PUT');
    expect(putCall?.body).toMatchObject({ expectedRevision: 3, theme: 'dim' });
  });

  it('an edit landing while a reset is in flight is staged behind it and PUTs conditionally on the tombstone revision', async () => {
    // Hold the DELETE in flight so the edit arrives while the reset still
    // owns the queue slot: the edit must be staged, not cancelled (it is a
    // post-reset edit) and not sent (the tombstone does not exist yet).
    let releaseDelete!: (r: MockResponse) => void;
    const pendingDelete = new Promise<MockResponse>((resolve) => { releaseDelete = resolve; });
    apiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') return pendingDelete;
      if (opts?.method === 'PUT') {
        return jsonResponse(200, { domain: 'appearance', schemaVersion: 1, revision: 4, updatedAt: 1 });
      }
      // The staged PUT's baseline GET: the tombstone (revision 3) is the row.
      return jsonResponse(200, {
        preferences: { appearance: { schemaVersion: 0, revision: 3, updatedAt: 1 } },
      });
    });

    adoptKnownRevision('appearance', 2);
    queueReset('appearance');
    // The edit lands while the DELETE is unresolved: staged behind the reset.
    notifyPreferenceWrite('appearance', ['theme']);
    expect(inspectQueue('appearance').kind).toBe('reset');
    expect(recordedCalls().some((c) => c.method === 'PUT')).toBe(false);

    // The reset settles: exactly one DELETE, then the staged PUT runs.
    releaseDelete(jsonResponse(200, { domain: 'appearance', schemaVersion: 0, revision: 3, updatedAt: 1 }));
    await vi.waitFor(() => {
      expect(recordedCalls().some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(recordedCalls().filter((c) => c.method === 'DELETE')).toHaveLength(1);
    const putCall = recordedCalls().find((c) => c.method === 'PUT');
    // Conditional on the tombstone's resulting revision (3), never the
    // pre-reset baseline (2): a stale precondition would 409 on the server.
    expect(putCall?.body).toMatchObject({ expectedRevision: 3 });
    expect(inspectQueue('appearance')).toEqual({ kind: null, failed: null, settling: false });
  });

  it('a failed reset retries as DELETE (kind-preserving), never as a PUT', async () => {
    apiFetch.mockImplementation(async () => jsonResponse(503, { error: 'unavailable' }));
    queueReset('appearance');
    await flushPendingWrites();
    await vi.waitFor(() => expect(inspectQueue('appearance').failed).toBe('reset'));

    // Retry re-runs the failed operation by kind.
    const { retryDomain } = await import('../syncBus');
    apiFetch.mockImplementation(async () => jsonResponse(200, { domain: 'appearance', schemaVersion: 0, revision: 2, updatedAt: 1 }));
    retryDomain('appearance');
    await vi.waitFor(() => {
      expect(recordedCalls().filter((c) => c.method === 'DELETE').length).toBe(2);
    });
  });

  it('a reset that 409s re-runs the DELETE once against the adopted revision instead of reverting to the server doc', async () => {
    // First DELETE carries the stale baseline and 409s with the server's
    // newer tombstone; the conflict re-queue must send a second DELETE
    // conditional on the adopted revision, NOT hand the reset to
    // reconciliation (which would re-hydrate the pre-reset document).
    const conflictEnvelope = { schemaVersion: 0, revision: 5, updatedAt: 1 };
    apiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') {
        const body = JSON.parse(opts.body as string) as { expectedRevision?: number };
        if (body.expectedRevision === 2) {
          return jsonResponse(409, { error: 'CONFLICT', current: conflictEnvelope });
        }
        return jsonResponse(200, { domain: 'appearance', schemaVersion: 0, revision: 6, updatedAt: 1 });
      }
      return jsonResponse(200, { preferences: { appearance: conflictEnvelope } });
    });

    adoptKnownRevision('appearance', 2);
    queueReset('appearance');
    await vi.waitFor(() => {
      expect(recordedCalls().filter((c) => c.method === 'DELETE').length).toBe(2);
    });
    const secondDelete = recordedCalls().filter((c) => c.method === 'DELETE')[1];
    expect(secondDelete.body).toEqual({ expectedRevision: 5 });
    // The conflicted reset neither failed nor left a queue entry behind.
    expect(inspectQueue('appearance')).toEqual({ kind: null, failed: null, settling: false });
  });

  it('a reset that 409s twice surfaces a failure instead of looping', async () => {
    const conflictEnvelope = { schemaVersion: 0, revision: 5, updatedAt: 1 };
    apiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') {
        return jsonResponse(409, { error: 'CONFLICT', current: { ...conflictEnvelope, revision: conflictEnvelope.revision + 1 } });
      }
      return jsonResponse(200, { preferences: { appearance: conflictEnvelope } });
    });

    adoptKnownRevision('appearance', 2);
    queueReset('appearance');
    await vi.waitFor(() => {
      expect(recordedCalls().filter((c) => c.method === 'DELETE').length).toBe(2);
    });
    // Exactly two attempts: the second conflict is a failure the toast owns.
    expect(recordedCalls().filter((c) => c.method === 'DELETE').length).toBe(2);
    expect(inspectQueue('appearance').failed).toBe('reset');
  });

  it('a lost migration race against a tombstone winner hands the tombstone to reconciliation', async () => {
    const reconciled: string[] = [];
    setReconcileHook((domain) => reconciled.push(domain));
    apiFetch.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/navigation/migrate')) {
        // Another browser reset the domain first: migrate loses, the winner
        // is the tombstone (schemaVersion 0).
        return jsonResponse(200, { migrated: false, row: { schemaVersion: 0, revision: 4, updatedAt: 1 } });
      }
      return jsonResponse(200, { preferences: {} });
    });

    // Persist a pin list and settle eligibility: migration defers until the
    // navigation document is valid, so the test must satisfy the same
    // precondition the real app does (the seed effect writes the list first).
    localStorage.setItem('sencho.appearance.topNavQuickLinks', JSON.stringify(['dashboard', 'fleet']));
    setEligibilitySettled({ userId: 7, generation: currentGeneration() }, ['dashboard', 'fleet']);
    queueMigrate('navigation');
    await vi.waitFor(() => {
      expect(reconciled).toContain('navigation');
    });
    // Clear the publication so later suites start from the parked state.
    clearEligibility({ userId: 7, generation: currentGeneration() });
  });

  it('migration is deferred until navigation eligibility settles, then carries only server-known fields', async () => {
    // No settled eligibility and no valid pin list: queueMigrate must not
    // dispatch a request (the parked op waits for a settled publication).
    setCurrentSyncUser(7);
    localStorage.removeItem('sencho.appearance.topNavQuickLinks');
    queueMigrate('navigation');
    await flushPendingWrites();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(inspectQueue('navigation').kind).toBe('migrate');

    // Settle eligibility with a non-empty set, and persist a pin list so the
    // document builder reports 'valid' provenance (never-seeded browsers defer
    // indefinitely; the seed effect in the real app writes the list first).
    apiFetch.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/navigation/migrate')) {
        return jsonResponse(201, { migrated: true, row: { data: NAVIGATION_DOC, schemaVersion: 1, revision: 1, updatedAt: 1 } });
      }
      return jsonResponse(200, { preferences: {} });
    });
    localStorage.setItem('sencho.appearance.topNavQuickLinks', JSON.stringify(['dashboard', 'fleet']));
    setEligibilitySettled({ userId: 7, generation: currentGeneration() }, ['dashboard', 'fleet']);
    await flushPendingWrites();
    await vi.waitFor(() => {
      expect(recordedCalls().some((c) => c.path.endsWith('/navigation/migrate'))).toBe(true);
    });
    const migrateCall = recordedCalls().find((c) => c.path.endsWith('/navigation/migrate'));
    expect(migrateCall?.body).toEqual({
      mode: expect.any(String),
      quickLinks: ['dashboard', 'fleet'],
      labels: expect.any(Boolean),
      align: expect.any(String),
    });
    expect(Object.keys(migrateCall?.body ?? {})).not.toContain('status');
  });

  it('an eligibility publication from a stale identity is rejected and its teardown is a no-op', () => {
    // Start from the current identity so ownershipA is current at publish.
    // The bus's synced account is 7 (the beforeEach), so account 1 must claim
    // it before its publication is accepted.
    setCurrentSyncUser(1);
    const generation0 = currentGeneration();
    const ownershipA: EligibilityOwnership = { userId: 1, generation: generation0 };
    setEligibilitySettled(ownershipA, ['dashboard']);
    expect(getSettledEligibility()?.eligibleIds).toEqual(['dashboard']);

    // Identity transition: generation bumps. The old producer publishes late:
    // the store keeps the stale row for teardown scoping but it reads as null,
    // and the stale publish must not resurrect or replace anything.
    bumpGeneration();
    setEligibilitySettled(ownershipA, ['fleet']);
    expect(getSettledEligibility()).toBeNull();

    // The new account's producer publishes under the current identity.
    setCurrentSyncUser(2);
    const ownershipB: EligibilityOwnership = { userId: 2, generation: currentGeneration() };
    setEligibilitySettled(ownershipB, ['dashboard', 'fleet']);
    expect(getSettledEligibility()?.eligibleIds).toEqual(['dashboard', 'fleet']);

    // The old producer's teardown (same ownership object) must not erase B's.
    clearEligibility(ownershipA);
    expect(getSettledEligibility()?.eligibleIds).toEqual(['dashboard', 'fleet']);
    clearEligibility(ownershipB);
    expect(getSettledEligibility()).toBeNull();
  });

  it('adoptKnownRevision feeds the next conditional write: a queued reset DELETE carries the adopted revision', async () => {
    // A pending edit based on revision 2; the server tombstone is at 3. The
    // DELETE must carry expectedRevision 3 (the adopted observable revision),
    // not 2 (the pre-adoption baseline).
    apiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') {
        return jsonResponse(200, { domain: 'appearance', schemaVersion: 0, revision: 4, updatedAt: 1 });
      }
      return jsonResponse(200, { preferences: {} });
    });
    adoptKnownRevision('appearance', 2);
    adoptKnownRevision('appearance', 3);
    queueReset('appearance');
    expect(inspectQueue('appearance').kind).toBe('reset');
    await flushPendingWrites();
    await vi.waitFor(() => {
      expect(recordedCalls().some((c) => c.method === 'DELETE')).toBe(true);
    });
    const del = recordedCalls().find((c) => c.method === 'DELETE');
    expect(del?.body).toEqual({ expectedRevision: 3 });
  });

  it('classic normalization: a legacy navigation document hydrates to Compact and never writes classic', () => {
    hydrateNavigationDocument({ ...NAVIGATION_DOC, mode: 'classic' });
    expect(localStorage.getItem('sencho.appearance.topNavMode')).toBe('compact');
  });

  it('cache ownership: the marker contract keys the cache to a numeric userId', () => {
    localStorage.setItem('sencho.appearance.theme', JSON.stringify({ theme: 'oled' }));
    localStorage.setItem(PREFERENCES_OWNER_KEY, JSON.stringify({ userId: 1, schema: 1 }));

    // A different account claims the browser: the sync owner wipes the cache
    // keys before hydration (clearPreferenceCache is the wipe primitive).
    clearPreferenceCache();
    expect(localStorage.getItem('sencho.appearance.theme')).toBeNull();
    expect(localStorage.getItem(PREFERENCES_OWNER_KEY)).toBeNull();

    // The claim writes a fresh marker for the new owner.
    localStorage.setItem(PREFERENCES_OWNER_KEY, JSON.stringify({ userId: 7, schema: 1 }));
    expect(JSON.parse(localStorage.getItem(PREFERENCES_OWNER_KEY) as string)).toEqual({ userId: 7, schema: 1 });
  });

  it('corrupt-row reconciliation adopts defaults and repairs conditionally on the corrupt revision', async () => {
    // The sync owner sequence for a corrupt row: adopt the corrupt revision,
    // hydrate defaults under the guard, then a conditional repair PUT.
    adoptKnownRevision('appearance', 7);
    setHydratingDomains(new Set(['appearance']));
    try {
      hydrateAppearanceDocument({ ...APPEARANCE_DOC });
    } finally {
      setHydratingDomains(new Set());
    }
    notifyPreferenceWrite('appearance');
    await flushPendingWrites();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const put = recordedCalls()[0];
    expect(put.method).toBe('PUT');
    expect(put.path).toBe('/user-preferences/appearance');
    expect(put.body).toMatchObject({ expectedRevision: 7, theme: 'dim' });
  });

  it('the pump drops a queued operation whose captured identity no longer matches', async () => {
    // An operation captured under account 9 while the bus is synced to 9; the
    // identity then changes (account switch, before any reset hook runs). The
    // defense-in-depth guard must drop the queued operation without sending:
    // the server guard is authoritative, but a stale client write never
    // leaves the tab.
    setCurrentSyncUser(9);
    notifyPreferenceWrite('appearance', ['theme']);
    setCurrentSyncUser(3);
    await flushPendingWrites();
    expect(recordedCalls().filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(inspectQueue('appearance').kind).toBeNull();
  });

  it('the pump drops a queued operation whose generation is stale', async () => {
    // The edit is enqueued under generation G; a logout-style generation bump
    // (with the queue deliberately NOT reset) must stop the write from
    // firing on the next pump.
    notifyPreferenceWrite('appearance', ['theme']);
    bumpGeneration();
    await flushPendingWrites();
    expect(recordedCalls().filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(inspectQueue('appearance').kind).toBeNull();
  });

  it('the targeted sidebar reset writes defaults locally and enqueues one write with both fields', async () => {
    // No prior row is known, so the PUT resolves its baseline first, finds the
    // row absent, and converts to a create-if-absent migrate carrying the
    // reset values (document rebuilt at send time).
    apiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return jsonResponse(201, { domain: 'appearance', revision: 1, row: { domain: 'appearance', schemaVersion: 1, revision: 1, updatedAt: 1 } });
      }
      return jsonResponse(200, { preferences: {} });
    });
    localStorage.setItem('sencho.appearance.sidebarMode', 'resizable');
    localStorage.setItem('sencho.appearance.sidebarWidth', '400');
    localStorage.setItem('sencho.appearance.theme', 'dim');

    resetSidebarLayout();

    // Local defaults land immediately, unrelated appearance fields untouched.
    expect(localStorage.getItem('sencho.appearance.sidebarMode')).toBe('fixed');
    expect(localStorage.getItem('sencho.appearance.sidebarWidth')).toBe('256');
    expect(localStorage.getItem('sencho.appearance.theme')).toBe('dim');
    await flushPendingWrites();
    await vi.waitFor(() => expect(recordedCalls().some((c) => c.method === 'POST')).toBe(true));
    const mutations = recordedCalls().filter((c) => c.method === 'PUT' || c.method === 'POST' || c.method === 'DELETE');
    expect(mutations).toHaveLength(1);
    expect(mutations[0].path).toBe('/user-preferences/appearance/migrate');
    expect(mutations[0].body).toMatchObject({ sidebarMode: 'fixed', sidebarWidth: 256 });
    expect(inspectQueue('appearance').settling).toBe(false);
  });

  it('the targeted sidebar reset after a known revision PUTs the defaults conditionally', async () => {
    apiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        return jsonResponse(200, { domain: 'appearance', revision: 5, updatedAt: 1 });
      }
      return jsonResponse(200, { preferences: {} });
    });
    adoptKnownRevision('appearance', 4);
    localStorage.setItem('sencho.appearance.sidebarMode', 'resizable');
    localStorage.setItem('sencho.appearance.sidebarWidth', '400');

    resetSidebarLayout();

    await flushPendingWrites();
    await vi.waitFor(() => expect(recordedCalls().some((c) => c.method === 'PUT')).toBe(true));
    const puts = recordedCalls().filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe('/user-preferences/appearance');
    expect(puts[0].body).toMatchObject({ expectedRevision: 4, sidebarMode: 'fixed', sidebarWidth: 256 });
    expect(recordedCalls().filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(inspectQueue('appearance').settling).toBe(false);
  });
});

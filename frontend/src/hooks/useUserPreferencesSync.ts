/**
 * The sync owner for per-user preference documents. Mounted outside the
 * authenticated app tree (a sibling of AppContent in App.tsx) so it survives
 * auth transitions; it derives its own lifecycle from useAuth().
 *
 * Responsibilities:
 * - Cache ownership: the localStorage preference cache is keyed to the account
 *   (marker sencho.preferences.owner). A different account wipes the cache to
 *   defaults before hydration, so no account ever renders another's values.
 * - Hydration: on authentication, GET both domains and hydrate through the
 *   hooks' apply paths: live doc → per-field sanitize + apply; tombstone →
 *   defaults via the apply paths; absent → migrate via the bus; corrupt →
 *   defaults + conditional repair PUT.
 * - Reconciliation: when a GET response arrives after local edits, the
 *   server wins untouched fields; dirty (user-edited-since-hydration) fields
 *   are re-applied on top and written back conditionally. A 409 CONFLICT
 *   reconciles against `current`; a second consecutive conflict surfaces the
 *   error state instead of looping. A failed write keeps the dirty fields and
 *   raises the unsaved episode, so the merge is retried rather than lost.
 * - Remote-reset precedence: a tombstone observed at a newer revision than
 *   a pending edit's baseline wins; the stale edit is discarded and the reset
 *   adopted. Only edits made after adopting the tombstone may un-tombstone.
 * - Identity: async work captures the identity generation; results apply only
 *   if it is unchanged. Identity transitions mask the readiness publication
 *   (it stays stored for teardown scoping but reads as null) and reset the
 *   queue.
 */

import { useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { apiFetch } from '@/lib/api';
import {
  bumpGeneration,
  currentGeneration,
  setUnsavedEpisode,
  subscribeToGenerations,
  subscribeToPreferenceWrites,
  type PreferenceDomain,
} from '@/lib/preferences/preferenceEvents';
import {
  adoptKnownRevision,
  discardQueuedEdit,
  documentForDomain,
  flushPendingWrites,
  queueMigrate,
  setCurrentSyncUser,
  setHydratingDomains,
  setReconcileHook,
} from '@/lib/preferences/syncBus';
import {
  PREFERENCES_OWNER_KEY,
  buildAppearanceDocument,
  buildNavigationDocument,
  clearPreferenceCache,
  defaultAppearanceDocument,
  hydrateAppearanceDocument,
  hydrateNavigationDefaults,
  hydrateNavigationDocument,
} from '@/lib/preferences/preferencesDocuments';

interface OwnerMarker {
  userId: number;
  schema: 1;
}

const DOMAINS: PreferenceDomain[] = ['appearance', 'navigation'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function useUserPreferencesSync(): void {
  const { user, appStatus } = useAuth();
  const userId = appStatus === 'authenticated' ? user?.userId ?? null : null;

  // Per-domain sync state (refs: the sync owner renders rarely and never
  // derives render output from these).
  const dirtyRef = useRef<Record<PreferenceDomain, Set<string>>>({
    appearance: new Set(), navigation: new Set(),
  });
  const conflictCountRef = useRef<Record<PreferenceDomain, number>>({
    appearance: 0, navigation: 0,
  });

  // Clear per-domain sync state on every generation bump (identity
  // transition): the next account's hydration starts from a clean slate.
  useEffect(() => {
    return subscribeToGenerations(() => {
      for (const domain of DOMAINS) {
        dirtyRef.current[domain] = new Set();
        conflictCountRef.current[domain] = 0;
      }
    });
  }, []);

  // Dirty-field tracking: a user setter notification marks the fields the
  // write touched as locally edited (hydration writes never notify; a reset
  // notification arrives without a field list and marks the whole domain). The
  // merge rule stays server-wins-untouched: on a late GET, only these fields
  // are re-applied on top of the server document.
  useEffect(() => {
    return subscribeToPreferenceWrites((domain, fields) => {
      const dirty = dirtyRef.current[domain];
      for (const field of fields) dirty.add(field);
    });
  }, []);

  // Cache ownership + hydration effect, keyed on the resolved identity.
  useEffect(() => {
    if (appStatus === 'loading') return; // boot in flight: touch nothing

    if (userId === null) {
      // Resolved unauthenticated (logout / 401 / boot failure): the cache may
      // hold the previous account's values; drop it so a later login never
      // renders them. (Do NOT clear when merely loading.)
      setCurrentSyncUser(null);
      return;
    }

    // Claim or verify cache ownership.
    let marker: OwnerMarker | null = null;
    try {
      const raw = localStorage.getItem(PREFERENCES_OWNER_KEY);
      // The marker is our own write and only selects between "same owner" and
      // "wipe"; a malformed value behaves like a missing one.
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object'
          && typeof (parsed as { userId?: unknown }).userId === 'number') {
          marker = parsed as OwnerMarker;
        }
      }
    } catch {
      marker = null;
    }
    if (!marker || marker.userId !== userId) {
      clearPreferenceCache();
      try {
        localStorage.setItem(PREFERENCES_OWNER_KEY, JSON.stringify({ userId, schema: 1 } satisfies OwnerMarker));
      } catch {
        // ignore; private mode
      }
    }

    setCurrentSyncUser(userId);
    void hydrateAll(userId);
    // Re-hydrate only when the numeric identity changes; the generation guard
    // on in-flight work means an unrelated re-render never refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, appStatus]);

  // Flush queued writes when the tab is hidden or closing.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushPendingWrites();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  // ── hydration + reconciliation ───────────────────────────────────────────
  async function hydrateAll(userId: number): Promise<void> {
    const generation = currentGeneration();
    setHydratingDomains(new Set(DOMAINS));
    try {
      const response = await apiFetch('/user-preferences', {
        method: 'GET',
        localOnly: true,
        headers: { 'x-sencho-pref-user': String(userId) },
      });
      if (generation !== currentGeneration()) return;
      if (!response.ok) {
        console.error(`[preferences] hydration request failed with status ${response.status}`);
        raiseUnsavedForDomains(DOMAINS);
        return;
      }
      const payload = (await response.json()) as { preferences?: Record<string, unknown> };
      if (generation !== currentGeneration()) return;
      // A malformed body is a failed hydration, not an empty one: treating it
      // as `{}` would migrate defaults over rows the server does hold.
      if (!isRecord(payload) || !isRecord(payload.preferences)) {
        console.error('[preferences] hydration response was malformed; skipping reconciliation');
        raiseUnsavedForDomains(DOMAINS);
        return;
      }
      const preferences = payload.preferences;
      // Per-domain isolation: a failure reconciling one domain must not skip
      // the other domain's reconciliation.
      for (const domain of DOMAINS) {
        try {
          await reconcileDomain(domain, preferences[domain] ?? null, userId, generation);
        } catch (error) {
          console.error(`[preferences] hydration reconcile for ${domain} failed:`, error);
          reMarkDirtyAndSurface(domain, null);
        }
      }
    } catch (error) {
      console.error('[preferences] hydration failed:', error);
      raiseUnsavedForDomains(DOMAINS);
    } finally {
      setHydratingDomains(new Set());
    }
  }

  /** Reconcile one domain against an observed server row (GET response, or
   *  the `current` envelope of a 409). Behavior by row kind:
   *  - absent: migrate (create-if-absent).
   *  - live doc: dirty fields re-applied on top of the server doc; the merged
   *    result is written back conditionally. No dirty fields: hydrate the
   *    server doc as-is.
   *  - tombstone: if pending edits are based on an older revision, they
   *    are DISCARDED and the reset adopted (defaults). Only edits made after
   *    adopting the tombstone survive.
   *  - corrupt: adopt defaults + enqueue a conditional repair PUT.
   */
  async function reconcileDomain(
    domain: PreferenceDomain,
    row: unknown,
    userId: number,
    generation: number,
  ): Promise<void> {
    if (generation !== currentGeneration()) return;

    if (row === null || row === undefined) {
      // Absent: migrate local state (create-if-absent). Navigation defers
      // until eligibility settles or the hook holds a valid document (the
      // pump gate in the bus decides which).
      queueMigrate(domain);
      return;
    }

    if (!isRecord(row)) {
      console.error(`[preferences] ${domain} row had an unexpected shape; skipping reconciliation`);
      return;
    }
    const revision = typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 1
      ? row.revision
      : null;
    if (revision === null) {
      console.error(`[preferences] ${domain} row had no valid revision; skipping reconciliation`);
      return;
    }
    adoptKnownRevision(domain, revision);

    const schemaVersion = row.schemaVersion;
    const corrupt = row.corrupt === true;

    if (schemaVersion === 0 || corrupt) {
      // Tombstone or corrupt row: adopt defaults locally and clear the cache
      // keys for this domain so a reload paints defaults, not stale values.
      // Any queued PUT based on an older revision is discarded first: the
      // remote reset outranks a stale local edit, and the parked operation
      // must never send the pre-reset values back to the server.
      discardQueuedEdit(domain);
      adoptDefaults(domain);
      if (schemaVersion !== 0) {
        // Corrupt row: enqueue a conditional repair PUT (tombstones are a
        // deliberate reset; corrupt rows are damage to repair).
        await repairCorruptRow(domain, revision, userId, generation);
      }
      return;
    }

    // Live doc: merge rule depends on pending dirty fields. The local
    // document is captured BEFORE the server doc is applied, so the dirty
    // values survive hydration; the merged result is then applied once.
    // A clean load (no dirty fields) whose merged document equals the server
    // document is a pure hydration: no write back, the server already holds
    // exactly this state and a PUT would only burn a revision.
    const serverDoc = row.data;
    if (!isRecord(serverDoc)) return;
    const dirty = dirtyRef.current[domain];
    const dirtySnapshot = dirty.size === 0 ? null : new Set(dirty);
    if (domain === 'appearance') {
      const localDoc: Record<string, unknown> = { ...buildAppearanceDocument() };
      const merged = mergedDocument(serverDoc, localDoc, dirtySnapshot);
      hydrateServerDocument(domain, merged);
      dirtyRef.current[domain] = new Set();
      if (dirtySnapshot === null && shallowEqual(merged, serverDoc)) return;
      await conditionalPut(domain, merged, revision, userId, generation, dirtySnapshot);
      return;
    }
    // Navigation: an unset provenance (never persisted) has no local edits to
    // merge; treat as clean hydration of the server document.
    const navDoc = buildNavigationDocument();
    if (navDoc.status === 'valid') {
      const validDoc = { mode: navDoc.mode, quickLinks: navDoc.quickLinks, labels: navDoc.labels, align: navDoc.align };
      const merged = mergedDocument(serverDoc, validDoc, dirtySnapshot);
      hydrateServerDocument(domain, merged);
      dirtyRef.current[domain] = new Set();
      if (dirtySnapshot === null && shallowEqual(merged, serverDoc)) return;
      await conditionalPut(domain, merged, revision, userId, generation, dirtySnapshot);
      return;
    }
    hydrateServerDocument(domain, serverDoc);
    dirtyRef.current[domain] = new Set();
  }

  /** Field-wise equality for flat preference documents. Only safe because the
   *  clean path compares a shallow copy of the server document against itself,
   *  so array fields share references; do not reuse for independently parsed
   *  documents. */
  function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((key) => a[key] === b[key]);
  }

  /** Server-wins merge: untouched fields keep the server values, dirty fields
   *  re-apply the captured local values. A null dirty set is a clean
   *  hydration (the server doc as-is). */
  function mergedDocument(
    serverDoc: Record<string, unknown>,
    localDoc: Record<string, unknown>,
    dirtySnapshot: Set<string> | null,
  ): Record<string, unknown> {
    if (dirtySnapshot === null) return { ...serverDoc };
    const merged: Record<string, unknown> = { ...serverDoc };
    for (const field of dirtySnapshot) {
      if (field in localDoc) merged[field] = localDoc[field];
    }
    return merged;
  }

  /** A write outcome is unknown-but-pending until the PUT settles: if it
   *  fails before the server acknowledges the merge, the dirty fields stay
   *  dirty (a later reconciliation must re-apply them) and the failure
   *  surfaces as an unsaved episode instead of vanishing. */
  function raiseUnsavedForDomains(domainsToMark: readonly PreferenceDomain[]): void {
    for (const domain of domainsToMark) {
      if (dirtyRef.current[domain].size > 0) setUnsavedEpisode(domain);
    }
  }

  async function conditionalPut(
    domain: PreferenceDomain,
    document: Record<string, unknown>,
    expectedRevision: number,
    userId: number,
    generation: number,
    dirtySnapshot: Set<string> | null = null,
  ): Promise<void> {
    const response = await apiFetch(`/user-preferences/${domain}`, {
      method: 'PUT',
      localOnly: true,
      headers: { 'x-sencho-pref-user': String(userId) },
      body: JSON.stringify({ expectedRevision, ...document }),
    });
    if (generation !== currentGeneration()) return;
    if (response.ok) {
      conflictCountRef.current[domain] = 0;
      return;
    }
    if (response.status === 409) {
      conflictCountRef.current[domain] += 1;
      if (conflictCountRef.current[domain] >= 2) {
        // Two consecutive conflicts: stop and surface; Retry restarts from a
        // fresh GET rather than looping.
        conflictCountRef.current[domain] = 0;
        reMarkDirtyAndSurface(domain, dirtySnapshot);
        return;
      }
      const parse = async (): Promise<{ current?: unknown } | null> => {
        try {
          return (await response.json()) as { current?: unknown };
        } catch {
          return null;
        }
      };
      const payload = await parse();
      if (payload !== null && isRecord(payload.current)) {
        // The PUT failed, so the merged write never persisted: restore the
        // dirty fields before re-reconciling against `current`. Without them
        // the re-entry sees a clean document and silently hydrates the
        // server state, losing the user's edit. No episode is raised here:
        // either the re-PUT converges, or its own failure path surfaces.
        restoreDirtyFields(domain, dirtySnapshot);
        await reconcileDomain(domain, payload.current, userId, currentGeneration());
        return;
      }
      reMarkDirtyAndSurface(domain, dirtySnapshot);
      return;
    }
    console.error(`[preferences] conditional write for ${domain} failed with status ${response.status}`);
    reMarkDirtyAndSurface(domain, dirtySnapshot);
  }

  /** Restore dirty state and raise the unsaved episode after a failed write,
   *  so the user's edits are retried on the next reconciliation instead of
   *  being silently dropped. */
  function reMarkDirtyAndSurface(domain: PreferenceDomain, dirtySnapshot: Set<string> | null): void {
    restoreDirtyFields(domain, dirtySnapshot);
    if (dirtyRef.current[domain].size > 0) setUnsavedEpisode(domain);
  }

  /** Re-mark fields as locally edited without surfacing a failure. */
  function restoreDirtyFields(domain: PreferenceDomain, dirtySnapshot: Set<string> | null): void {
    if (dirtySnapshot !== null) {
      for (const field of dirtySnapshot) dirtyRef.current[domain].add(field);
    }
  }

  async function repairCorruptRow(
    domain: PreferenceDomain,
    revision: number,
    userId: number,
    generation: number,
  ): Promise<void> {
    const doc = documentForDomain(domain);
    if (doc === null) {
      // Nothing local to repair with yet (navigation unsettled): leave the
      // corrupt row; the next edit will conditionally overwrite it.
      return;
    }
    await conditionalPut(domain, doc, revision, userId, generation);
  }

  function adoptDefaults(domain: PreferenceDomain): void {
    setHydratingDomains(new Set(DOMAINS));
    try {
      if (domain === 'appearance') {
        hydrateAppearanceDocument(defaultAppearanceDocument());
      } else {
        hydrateNavigationDefaults();
      }
    } finally {
      setHydratingDomains(new Set());
    }
  }

  function hydrateServerDocument(domain: PreferenceDomain, doc: Record<string, unknown>): void {
    setHydratingDomains(new Set(DOMAINS));
    try {
      if (domain === 'appearance') {
        hydrateAppearanceDocument(doc);
      } else {
        hydrateNavigationDocument(doc);
      }
    } finally {
      setHydratingDomains(new Set());
    }
  }

  // The account the owner is currently synced for, read by the reconcile hook
  // (declared before the effect that installs the hook so the closure sees a
  // stable ref).
  const currentUserIdRef = useRef<number | null>(null);
  useEffect(() => {
    currentUserIdRef.current = userId;
  }, [userId]);

  // Conflict hook: the bus hands reconciliation to us (server base + dirty
  // fields re-applied) instead of retrying blindly. reconcileDomain reads
  // refs only, so a stable empty dependency list is correct here.
  useEffect(() => {
    setReconcileHook((domain) => {
      const userIdNow = currentUserIdRef.current;
      if (userIdNow === null) return;
      void (async () => {
        try {
          const response = await apiFetch('/user-preferences', {
            method: 'GET',
            localOnly: true,
            headers: { 'x-sencho-pref-user': String(userIdNow) },
          });
          if (!response.ok) {
            console.error(`[preferences] reconcile request failed with status ${response.status}`);
            // Dirty fields stay dirty; surface the episode so the failure is
            // visible and Retry re-enters reconciliation (retryDomain with
            // no parked operation delegates back to this hook).
            reMarkDirtyAndSurface(domain, null);
            return;
          }
          const payload = (await response.json()) as { preferences?: Record<string, unknown> };
          const row = isRecord(payload.preferences) ? payload.preferences[domain] : null;
          await reconcileDomain(domain, row ?? null, userIdNow, currentGeneration());
        } catch (error) {
          console.error('[preferences] reconcile failed:', error);
          reMarkDirtyAndSurface(domain, null);
        }
      })();
    });
    return () => setReconcileHook(null);
    // reconcileDomain closes over refs only; the hook is installed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Identity transition: bump the generation so in-flight preference work is
  // invalidated (the AuthContext already bumps; this covers direct logouts).
  useEffect(() => {
    if (appStatus === 'loading') return;
    if (userId === null) {
      bumpGeneration();
      clearPreferenceCache();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appStatus]);
}

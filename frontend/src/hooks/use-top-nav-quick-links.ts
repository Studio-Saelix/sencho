import { useCallback, useEffect, useRef, useState } from 'react';
import { isQuickLinkEligibleId } from '@/lib/navigation/appNavRegistry';
import type { ActiveView } from '@/lib/router/routeTypes';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

export const TOP_NAV_QUICK_LINKS_KEY = 'sencho.appearance.topNavQuickLinks';
export const MAX_QUICK_LINKS = 8;

/**
 * Sanitize a candidate ID list: keep registry-known eligible IDs, dedupe,
 * and cap at MAX_QUICK_LINKS. Never expands invalid input to a default set;
 * the caller decides what to seed once eligibility is known.
 */
export function sanitizeQuickLinkIds(ids: unknown): ActiveView[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: ActiveView[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string' || !isQuickLinkEligibleId(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_QUICK_LINKS) break;
  }
  return out;
}

type StoredQuickLinksState =
  | { status: 'valid'; ids: ActiveView[] }
  | { status: 'unset' }; // covers missing key, malformed JSON, and non-array JSON alike

function writeStored(ids: ActiveView[]): boolean {
  try {
    window.localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, JSON.stringify(ids));
    return true;
  } catch (err) {
    console.warn('[useTopNavQuickLinks] failed to persist quick links', err);
    return false;
  }
}

/**
 * Parse stored JSON into provenance-aware state. Missing key, malformed JSON, and non-array JSON
 * all become 'unset' (not a raw-defaults guess): the caller decides what to do once eligibility
 * is known. A valid JSON array (including []) is sanitized and returned as-is.
 */
export function parseStoredState(raw: string | null): StoredQuickLinksState {
  if (raw === null) return { status: 'unset' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { status: 'unset' };
    return { status: 'valid', ids: sanitizeQuickLinkIds(parsed) };
  } catch {
    return { status: 'unset' };
  }
}

function readStoredState(): StoredQuickLinksState {
  if (typeof window === 'undefined') return { status: 'unset' };
  try {
    return parseStoredState(window.localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY));
  } catch {
    return { status: 'unset' };
  }
}

/** An 'unset' state has no pins yet, so it reads as an empty list. */
function idsOf(state: StoredQuickLinksState): ActiveView[] {
  return state.status === 'valid' ? state.ids : [];
}

export interface TopNavQuickLinksApi {
  persistedIds: ActiveView[];
  /** True once default eligibility has settled, so Reset has something authoritative to restore. */
  canReset: boolean;
  setPersistedIds: (next: ActiveView[]) => void;
  addQuickLink: (value: ActiveView) => void;
  removeQuickLink: (value: ActiveView) => void;
  resetQuickLinks: () => void;
}

/**
 * @param defaultEligibleIds Settled, reachability-aware recommended defaults from
 * `useViewNavigationState`'s `defaultQuickLinkEligibility` (`null` while not yet settled). Used to
 * seed a first-run/never-persisted state and to drive Reset, never `navModel.quickLinkCandidates`,
 * which is current-context display filtering, not a settled default source.
 */
export function useTopNavQuickLinks(defaultEligibleIds?: readonly ActiveView[] | null): TopNavQuickLinksApi {
  const [state, setState] = useState<StoredQuickLinksState>(readStoredState);
  // Latest-value ref, updated synchronously via applyState below. addQuickLink/removeQuickLink
  // read this instead of the `state` closure: within one synchronous batch (several calls before
  // React re-renders), a closure read is stale for every call after the first. Only a ref updated
  // inline sees each call's own effect on the one before it. Same latest-value-ref pattern as
  // `activeNodeRef` in NodeContext.
  const stateRef = useRef<StoredQuickLinksState>(state);

  // The single writer for both, so the ref can never drift from the rendered state.
  const applyState = useCallback((next: StoredQuickLinksState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Same-tab settings-changed and cross-tab storage sync both route through the
  // same status-discriminated parse: a malformed write synced from another tab
  // must land as 'unset' here too, not fall back to raw unfiltered defaults.
  useEffect(() => {
    function onSettingsChanged() {
      applyState(readStoredState());
    }
    window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
  }, [applyState]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== TOP_NAV_QUICK_LINKS_KEY) return;
      applyState(parseStoredState(event.newValue));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [applyState]);

  // commit always updates in-memory state (the operator's action, or the eligibility seed,
  // still takes effect for this tab this session even if persistence failed), but only
  // dispatches SENCHO_SETTINGS_CHANGED when the write actually succeeded. Every other mounted
  // hook instance re-reads storage on that event; dispatching after a failed write would make
  // them revert to the old (or absent) stored value even though this instance's in-memory state
  // is correct.
  const commit = useCallback((next: ActiveView[]) => {
    const sanitized = sanitizeQuickLinkIds(next);
    const persisted = writeStored(sanitized);
    applyState({ status: 'valid', ids: sanitized });
    if (persisted) {
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }
  }, [applyState]);

  // Seed defaults once eligibility is settled (even a confirmed-empty list: defaultEligibleIds
  // is only ever non-null once proven, never merely "not yet failed") and no valid preference has
  // ever been saved. Fires at most once in practice: the moment it commits, storage holds a valid
  // array and this becomes a no-op on every later render. Checks `== null`, not falsiness or
  // `.length === 0`: a settled, confirmed-empty eligibility list is a real answer ("nothing
  // recommended is reachable") and must be persisted as `[]`, not treated as "not yet known."
  useEffect(() => {
    if (state.status !== 'unset') return;
    if (defaultEligibleIds == null) return;
    commit([...defaultEligibleIds]);
  }, [defaultEligibleIds, state.status, commit]);

  const resetQuickLinks = useCallback(() => {
    if (defaultEligibleIds == null) return; // guarded in the UI too; defense in depth
    commit([...defaultEligibleIds]);
  }, [commit, defaultEligibleIds]);

  const addQuickLink = useCallback((value: ActiveView) => {
    if (!isQuickLinkEligibleId(value)) return;
    const prevIds = idsOf(stateRef.current);
    if (prevIds.includes(value) || prevIds.length >= MAX_QUICK_LINKS) return;
    commit([...prevIds, value]);
  }, [commit]);

  const removeQuickLink = useCallback((value: ActiveView) => {
    commit(idsOf(stateRef.current).filter((id) => id !== value));
  }, [commit]);

  return {
    persistedIds: idsOf(state),
    canReset: defaultEligibleIds != null,
    setPersistedIds: commit,
    addQuickLink,
    removeQuickLink,
    resetQuickLinks,
  };
}

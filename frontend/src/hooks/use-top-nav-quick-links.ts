import { useCallback, useEffect, useState } from 'react';
import {
  isQuickLinkEligibleId,
  recommendedQuickLinkIds,
} from '@/lib/navigation/appNavRegistry';
import type { ActiveView } from '@/lib/router/routeTypes';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

export const TOP_NAV_QUICK_LINKS_KEY = 'sencho.appearance.topNavQuickLinks';
export const MAX_QUICK_LINKS = 4;

/**
 * Sanitize a candidate ID list: keep registry-known eligible IDs, dedupe,
 * and cap at MAX_QUICK_LINKS. Does not expand empty arrays to defaults.
 */
export function sanitizeQuickLinkIds(ids: unknown): ActiveView[] {
  if (!Array.isArray(ids)) return [...recommendedQuickLinkIds];
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

/**
 * Parse stored JSON. Missing key or malformed JSON → recommended defaults.
 * Valid JSON array (including []) is sanitized and returned as-is (empty stays empty).
 */
export function parseStoredQuickLinks(raw: string | null): ActiveView[] {
  if (raw === null) return [...recommendedQuickLinkIds];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...recommendedQuickLinkIds];
    return sanitizeQuickLinkIds(parsed);
  } catch {
    return [...recommendedQuickLinkIds];
  }
}

function readStored(): ActiveView[] {
  if (typeof window === 'undefined') return [...recommendedQuickLinkIds];
  try {
    return parseStoredQuickLinks(window.localStorage.getItem(TOP_NAV_QUICK_LINKS_KEY));
  } catch {
    return [...recommendedQuickLinkIds];
  }
}

function writeStored(ids: ActiveView[]): void {
  try {
    window.localStorage.setItem(TOP_NAV_QUICK_LINKS_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

export interface TopNavQuickLinksApi {
  persistedIds: ActiveView[];
  setPersistedIds: (next: ActiveView[]) => void;
  addQuickLink: (value: ActiveView) => void;
  removeQuickLink: (value: ActiveView) => void;
  resetQuickLinks: () => void;
}

export function useTopNavQuickLinks(): TopNavQuickLinksApi {
  const [persistedIds, setPersistedState] = useState<ActiveView[]>(readStored);

  useEffect(() => {
    function onSettingsChanged() {
      setPersistedState(readStored());
    }
    window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== TOP_NAV_QUICK_LINKS_KEY) return;
      setPersistedState(parseStoredQuickLinks(event.newValue));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const commit = useCallback((next: ActiveView[]) => {
    const sanitized = sanitizeQuickLinkIds(next);
    writeStored(sanitized);
    setPersistedState(sanitized);
    window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
  }, []);

  const setPersistedIds = useCallback((next: ActiveView[]) => {
    commit(next);
  }, [commit]);

  const addQuickLink = useCallback((value: ActiveView) => {
    setPersistedState((prev) => {
      if (prev.includes(value) || prev.length >= MAX_QUICK_LINKS) return prev;
      if (!isQuickLinkEligibleId(value)) return prev;
      const next = [...prev, value];
      writeStored(next);
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
      return next;
    });
  }, []);

  const removeQuickLink = useCallback((value: ActiveView) => {
    setPersistedState((prev) => {
      const next = prev.filter((id) => id !== value);
      writeStored(next);
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
      return next;
    });
  }, []);

  const resetQuickLinks = useCallback(() => {
    commit([...recommendedQuickLinkIds]);
  }, [commit]);

  return {
    persistedIds,
    setPersistedIds,
    addQuickLink,
    removeQuickLink,
    resetQuickLinks,
  };
}

import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { notifyPreferenceWrite } from '@/lib/preferences/preferenceEvents';

export const TOP_NAV_MODE_KEY = 'sencho.appearance.topNavMode';

export type TopNavMode = 'smart' | 'compact';

const VALID: ReadonlySet<string> = new Set(['smart', 'compact']);

/** Recommended default, and the fallback for missing, invalid, or legacy ('classic') storage. */
const DEFAULT_MODE: TopNavMode = 'compact';

export function parseTopNavMode(raw: string | null): TopNavMode {
  if (raw && VALID.has(raw)) return raw as TopNavMode;
  return DEFAULT_MODE;
}

function readStored(): TopNavMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    return parseTopNavMode(window.localStorage.getItem(TOP_NAV_MODE_KEY));
  } catch {
    return DEFAULT_MODE;
  }
}

/** Read the current nav mode without subscribing (sync layer use). */
export function currentTopNavMode(): TopNavMode {
  return readStored();
}

/** Apply a nav mode through the same path a user commit uses. Hydration-side
 *  writes do not notify the sync bus. */
export function applyTopNavMode(next: TopNavMode): void {
  try {
    window.localStorage.setItem(TOP_NAV_MODE_KEY, next);
  } catch {
    // ignore; localStorage may be unavailable
  }
  window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
}

export function useTopNavMode(): [TopNavMode, (next: TopNavMode) => void] {
  const [mode, setModeState] = useState<TopNavMode>(readStored);

  useEffect(() => {
    function onSettingsChanged() {
      setModeState(readStored());
    }
    window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== TOP_NAV_MODE_KEY) return;
      setModeState(parseTopNavMode(event.newValue));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setMode = useCallback((next: TopNavMode) => {
    applyTopNavMode(next);
    setModeState(next);
    notifyPreferenceWrite('navigation', ['mode']);
  }, []);

  return [mode, setMode];
}

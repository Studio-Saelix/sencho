import { useCallback, useState } from 'react';
import type { StackHealthScopeMode } from './stackHealthTypes';

export const RECENT_ALERTS_SCOPE_KEY = 'sencho.dashboard.recentAlertsScope';

export function parseRecentAlertsScopePreference(raw: string | null): StackHealthScopeMode {
  if (raw === 'this-node' || raw === 'all-nodes') return raw;
  return 'this-node';
}

function readStored(): StackHealthScopeMode {
  try {
    return parseRecentAlertsScopePreference(localStorage.getItem(RECENT_ALERTS_SCOPE_KEY));
  } catch {
    return 'this-node';
  }
}

/**
 * Read once and never reset by an active-node change, so switching nodes cannot
 * clobber the operator's choice.
 */
export function useRecentAlertsScopePreference(): [
  StackHealthScopeMode,
  (next: StackHealthScopeMode) => void,
] {
  const [scope, setScopeState] = useState<StackHealthScopeMode>(readStored);

  const setScope = useCallback((next: StackHealthScopeMode) => {
    try {
      localStorage.setItem(RECENT_ALERTS_SCOPE_KEY, next);
    } catch {
      // localStorage may be unavailable (private mode, quota)
    }
    setScopeState(next);
  }, []);

  return [scope, setScope];
}

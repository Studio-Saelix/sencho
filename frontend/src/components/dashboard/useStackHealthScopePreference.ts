import { useCallback, useState } from 'react';
import type { StackHealthScopeMode } from './stackHealthTypes';

export const STACK_HEALTH_SCOPE_KEY = 'sencho.dashboard.stackHealthScope';

export function parseStackHealthScopePreference(raw: string | null): StackHealthScopeMode {
  if (raw === 'this-node' || raw === 'all-nodes') return raw;
  return 'this-node';
}

function readStored(): StackHealthScopeMode {
  try {
    return parseStackHealthScopePreference(localStorage.getItem(STACK_HEALTH_SCOPE_KEY));
  } catch {
    return 'this-node';
  }
}

export function useStackHealthScopePreference(): [
  StackHealthScopeMode,
  (next: StackHealthScopeMode) => void,
] {
  const [scope, setScopeState] = useState<StackHealthScopeMode>(readStored);

  const setScope = useCallback((next: StackHealthScopeMode) => {
    try {
      localStorage.setItem(STACK_HEALTH_SCOPE_KEY, next);
    } catch {
      // localStorage may be unavailable (private mode, quota)
    }
    setScopeState(next);
  }, []);

  return [scope, setScope];
}

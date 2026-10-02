import { useCallback, useState } from 'react';

export type ReadinessViewMode = 'table' | 'cards';

const STORAGE_KEY = 'sencho-readiness-view';
const DEFAULT_MODE: ReadinessViewMode = 'table';

function loadMode(): ReadinessViewMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'table' || stored === 'cards') return stored;
  } catch { /* storage unavailable: fall back to the default view */ }
  return DEFAULT_MODE;
}

/** Browser-only preference for how the Update page lists pending updates. */
export function useReadinessViewMode() {
  const [mode, setModeState] = useState<ReadinessViewMode>(loadMode);

  const setMode = useCallback((next: ReadinessViewMode) => {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch { /* non-fatal: the choice just will not survive a reload */ }
  }, []);

  return { mode, setMode };
}

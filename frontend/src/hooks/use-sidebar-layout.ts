import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { notifyPreferenceWrite } from '@/lib/preferences/preferenceEvents';

/**
 * Sidebar layout preference: desktop sidebar mode (fixed/resizable) and the
 * preferred stacks-sidebar width. Follows the use-density hook contract
 * exactly: localStorage is the pre-paint cache, apply* writes through the
 * same path hydration uses (no bus notify), and only the user-facing setters
 * notify the sync bus.
 */
export type SidebarMode = 'fixed' | 'resizable';

export const SIDEBAR_MODE_KEY = 'sencho.appearance.sidebarMode';
export const SIDEBAR_WIDTH_KEY = 'sencho.appearance.sidebarWidth';

export const SIDEBAR_MODES = ['fixed', 'resizable'] as const;

/** Bounds for the preferred desktop sidebar width, in px. */
export const SIDEBAR_WIDTH = { min: 224, max: 440, default: 256 } as const;
export const SIDEBAR_WIDTH_DEFAULT = SIDEBAR_WIDTH.default;

export function isSidebarMode(value: unknown): value is SidebarMode {
  return value === 'fixed' || value === 'resizable';
}

/**
 * The single width sanitizer for stored/hydrated/committed values: a valid
 * integer survives clamped into bounds, anything else falls back to the
 * default (fractional or malformed values must never poison the document).
 * Live drag values are rounded by the resize pane before reaching this.
 */
export function sanitizeSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return SIDEBAR_WIDTH.default;
  }
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, value));
}

function readStoredMode(): SidebarMode {
  if (typeof window === 'undefined') return 'fixed';
  try {
    const raw = window.localStorage.getItem(SIDEBAR_MODE_KEY);
    return isSidebarMode(raw) ? raw : 'fixed';
  } catch {
    return 'fixed';
  }
}

function parseStoredWidth(raw: string | null): number {
  if (raw === null || raw.trim() === '') return SIDEBAR_WIDTH.default;
  return sanitizeSidebarWidth(Number(raw));
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_WIDTH.default;
  try {
    return parseStoredWidth(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  } catch {
    return SIDEBAR_WIDTH.default;
  }
}

/** Read the current mode without subscribing (sync layer use). */
export function currentSidebarMode(): SidebarMode {
  return readStoredMode();
}

/** Read the current preferred width without subscribing (sync layer use). */
export function currentSidebarWidth(): number {
  return readStoredWidth();
}

/** Guarded localStorage write shared by every path in this module: skips the
 *  identical-value write and tolerates an unavailable store (private mode,
 *  quota). Reports whether a new value actually landed. */
function writeStoredValue(key: string, value: string): boolean {
  try {
    if (window.localStorage.getItem(key) !== value) {
      window.localStorage.setItem(key, value);
      return true;
    }
    return false;
  } catch {
    // ignore; localStorage may be unavailable (private mode, quota)
    return false;
  }
}

/** Apply a mode through the same path a user commit uses (state for mounted
 *  instances arrives via the settings-changed event; localStorage is written
 *  here). Hydration-side writes do not notify the sync bus. */
export function applySidebarModeValue(next: SidebarMode): void {
  const changed = writeStoredValue(SIDEBAR_MODE_KEY, next);
  if (changed) window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
}

/** Apply a preferred width (already sanitized) without notifying the bus. */
export function applySidebarWidthValue(next: number): void {
  const changed = writeStoredValue(SIDEBAR_WIDTH_KEY, String(next));
  if (changed) window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
}

interface SidebarLayoutState {
  sidebarMode: SidebarMode;
  sidebarWidth: number;
  setSidebarMode: (next: SidebarMode) => void;
  setSidebarWidth: (next: number) => void;
}

export function useSidebarLayout(): SidebarLayoutState {
  const [sidebarMode, setModeState] = useState<SidebarMode>(readStoredMode);
  const [sidebarWidth, setWidthState] = useState<number>(readStoredWidth);

  // Persist-on-change, matching the use-density contract: the hook's own state
  // is the write source, so a setter state change lands in localStorage even
  // when no apply* path was involved. Guarded, so a re-read (same value) is a
  // no-op write. A setter write that actually changes storage also broadcasts
  // the settings-changed event so other mounted instances (e.g. the Settings
  // page while the shell separator commits) re-read; this is the setter-side
  // counterpart of the apply* broadcasts above.
  useEffect(() => {
    if (writeStoredValue(SIDEBAR_MODE_KEY, sidebarMode)) {
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }
  }, [sidebarMode]);

  useEffect(() => {
    if (writeStoredValue(SIDEBAR_WIDTH_KEY, String(sidebarWidth))) {
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }
  }, [sidebarWidth]);

  useEffect(() => {
    function onSettingsChanged() {
      setModeState(readStoredMode());
      setWidthState(readStoredWidth());
    }
    window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      // Cross-tab sync trusts event.newValue: the fired event already carries
      // the other tab's write (and a synthetic event in tests updates nothing).
      if (event.key === SIDEBAR_MODE_KEY) {
        if (isSidebarMode(event.newValue)) setModeState(event.newValue);
        return;
      }
      if (event.key === SIDEBAR_WIDTH_KEY) {
        setWidthState(parseStoredWidth(event.newValue));
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Mode and width are independent fields on purpose: switching to Fixed must
  // retain (but not apply) the saved width; switching back to Resizable
  // re-applies it. A mode write never touches the width field.
  const setSidebarMode = useCallback((next: SidebarMode) => {
    setModeState(next);
    notifyPreferenceWrite('appearance', ['sidebarMode']);
  }, []);

  const setSidebarWidth = useCallback((next: number) => {
    const sanitized = sanitizeSidebarWidth(next);
    setWidthState(sanitized);
    notifyPreferenceWrite('appearance', ['sidebarWidth']);
  }, []);

  return { sidebarMode, sidebarWidth, setSidebarMode, setSidebarWidth };
}

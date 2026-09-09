import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { notifyPreferenceWrite, type PreferenceField } from '@/lib/preferences/preferenceEvents';

export type PaneMode = 'fixed' | 'resizable';

export interface PaneWidthBounds {
  min: number;
  max: number;
  default: number;
}

interface PaneLayoutDefinition {
  modeKey: string;
  widthKey: string;
  width: PaneWidthBounds;
  modeField: PreferenceField;
  widthField: PreferenceField;
}

interface PaneLayoutState {
  mode: PaneMode;
  width: number;
  setMode: (next: PaneMode) => void;
  setWidth: (next: number) => void;
}

export function isPaneMode(value: unknown): value is PaneMode {
  return value === 'fixed' || value === 'resizable';
}

function writeStoredValue(key: string, value: string): boolean {
  try {
    if (window.localStorage.getItem(key) === value) return false;
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function createPaneLayoutPreference(definition: PaneLayoutDefinition) {
  function sanitizeWidth(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      return definition.width.default;
    }
    return Math.min(definition.width.max, Math.max(definition.width.min, value));
  }

  function currentMode(): PaneMode {
    if (typeof window === 'undefined') return 'fixed';
    try {
      const raw = window.localStorage.getItem(definition.modeKey);
      return isPaneMode(raw) ? raw : 'fixed';
    } catch {
      return 'fixed';
    }
  }

  function parseStoredWidth(raw: string | null): number {
    if (raw === null || raw.trim() === '') return definition.width.default;
    return sanitizeWidth(Number(raw));
  }

  function currentWidth(): number {
    if (typeof window === 'undefined') return definition.width.default;
    try {
      return parseStoredWidth(window.localStorage.getItem(definition.widthKey));
    } catch {
      return definition.width.default;
    }
  }

  function applyMode(next: PaneMode): void {
    if (writeStoredValue(definition.modeKey, next)) {
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }
  }

  function applyWidth(next: number): void {
    if (writeStoredValue(definition.widthKey, String(next))) {
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }
  }

  function usePaneLayout(): PaneLayoutState {
    const [mode, setModeState] = useState<PaneMode>(currentMode);
    const [width, setWidthState] = useState<number>(currentWidth);

    useEffect(() => {
      if (writeStoredValue(definition.modeKey, mode)) {
        window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
      }
    }, [mode]);

    useEffect(() => {
      if (writeStoredValue(definition.widthKey, String(width))) {
        window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
      }
    }, [width]);

    useEffect(() => {
      function onSettingsChanged() {
        setModeState(currentMode());
        setWidthState(currentWidth());
      }
      window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
      return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    }, []);

    useEffect(() => {
      function onStorage(event: StorageEvent) {
        if (event.key === definition.modeKey) {
          if (isPaneMode(event.newValue)) setModeState(event.newValue);
          return;
        }
        if (event.key === definition.widthKey) {
          setWidthState(parseStoredWidth(event.newValue));
        }
      }
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setMode = useCallback((next: PaneMode) => {
      setModeState(next);
      notifyPreferenceWrite('appearance', [definition.modeField]);
    }, []);

    const setWidth = useCallback((next: number) => {
      setWidthState(sanitizeWidth(next));
      notifyPreferenceWrite('appearance', [definition.widthField]);
    }, []);

    return { mode, width, setMode, setWidth };
  }

  return { sanitizeWidth, currentMode, currentWidth, applyMode, applyWidth, usePaneLayout };
}

import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { notifyPreferenceWrite } from '@/lib/preferences/preferenceEvents';

export const LOG_CHIP_COLOR_KEY = 'sencho.log-chip-color-mode';
export type LogChipColorMode = 'unified' | 'per-service';

function readStored(): LogChipColorMode {
    if (typeof window === 'undefined') return 'unified';
    try {
        return window.localStorage.getItem(LOG_CHIP_COLOR_KEY) === 'per-service' ? 'per-service' : 'unified';
    } catch {
        return 'unified';
    }
}

export function isLogChipColorModeExport(v: unknown): v is LogChipColorMode {
    return v === 'unified' || v === 'per-service';
}

/** Read the current mode without subscribing (sync layer use). */
export function currentLogChipColorMode(): LogChipColorMode {
    return readStored();
}

/** Apply a value through the same path a user commit uses. Hydration writes
 *  do not notify the sync bus. */
export function applyLogChipColorMode(next: LogChipColorMode): void {
    try {
        window.localStorage.setItem(LOG_CHIP_COLOR_KEY, next);
    } catch {
        // ignore; localStorage may be unavailable (private mode, quota)
    }
    window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
}

export function useLogChipColorMode(): [LogChipColorMode, (next: LogChipColorMode) => void] {
    const [mode, setModeState] = useState<LogChipColorMode>(readStored);

    useEffect(() => {
        function onSettingsChanged() {
            setModeState(readStored());
        }
        window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
        return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    }, []);

    useEffect(() => {
        function onStorage(event: StorageEvent) {
            if (event.key !== LOG_CHIP_COLOR_KEY) return;
            setModeState(event.newValue === 'per-service' ? 'per-service' : 'unified');
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setMode = useCallback((next: LogChipColorMode) => {
        applyLogChipColorMode(next);
        setModeState(next);
        notifyPreferenceWrite('appearance', ['logChipColorMode']);
    }, []);

    return [mode, setMode];
}

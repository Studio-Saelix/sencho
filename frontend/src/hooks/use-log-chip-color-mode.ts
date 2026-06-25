import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

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
        try {
            window.localStorage.setItem(LOG_CHIP_COLOR_KEY, next);
        } catch {
            // ignore; localStorage may be unavailable (private mode, quota)
        }
        setModeState(next);
        window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }, []);

    return [mode, setMode];
}

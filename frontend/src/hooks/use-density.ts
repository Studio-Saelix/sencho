import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { notifyPreferenceWrite } from '@/lib/preferences/preferenceEvents';

export type Density = 'comfortable' | 'compact';

const STORAGE_KEY = 'sencho.appearance.density';
const DEFAULT_DENSITY: Density = 'comfortable';

export function isDensity(value: unknown): value is Density {
    return value === 'comfortable' || value === 'compact';
}

function readStoredDensity(): Density {
    if (typeof window === 'undefined') return DEFAULT_DENSITY;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return isDensity(raw) ? raw : DEFAULT_DENSITY;
    } catch {
        return DEFAULT_DENSITY;
    }
}

function applyDensityClass(density: Density) {
    if (typeof document === 'undefined') return;
    const body = document.body;
    if (!body) return;
    body.classList.toggle('density-compact', density === 'compact');
}

export function initializeDensity() {
    applyDensityClass(readStoredDensity());
}

/** Read the current density without subscribing (sync layer use). */
export function currentDensityValue(): Density {
    return readStoredDensity();
}

/** Apply a density through the same path a user commit uses (state for mounted
 *  instances arrives via the settings-changed event; DOM + localStorage are
 *  written here). Hydration-side writes do not notify the sync bus. */
export function applyDensityValue(next: Density) {
    applyDensityClass(next);
    try {
        if (window.localStorage.getItem(STORAGE_KEY) !== next) {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    } catch {
        // ignore; localStorage may be unavailable (private mode, quota)
    }
    window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
}

export function useDensity(): [Density, (next: Density) => void] {
    const [density, setDensityState] = useState<Density>(readStoredDensity);

    useEffect(() => {
        applyDensityClass(density);
        try {
            if (window.localStorage.getItem(STORAGE_KEY) !== density) {
                window.localStorage.setItem(STORAGE_KEY, density);
            }
        } catch {
            // ignore; localStorage may be unavailable (private mode, quota)
        }
    }, [density]);

    useEffect(() => {
        function onSettingsChanged() {
            setDensityState(readStoredDensity());
        }
        window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
        return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    }, []);

    useEffect(() => {
        function onStorage(event: StorageEvent) {
            if (event.key !== STORAGE_KEY) return;
            if (isDensity(event.newValue)) setDensityState(event.newValue);
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setDensity = useCallback((next: Density) => {
        setDensityState(next);
        notifyPreferenceWrite('appearance', ['density']);
    }, []);

    return [density, setDensity];
}

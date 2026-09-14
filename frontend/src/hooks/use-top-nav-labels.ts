import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { notifyPreferenceWrite } from '@/lib/preferences/preferenceEvents';

export const TOP_NAV_LABELS_KEY = 'sencho.appearance.topNavLabels';

// Default on (opt-out): the desktop top nav keeps its text labels unless the
// user has explicitly turned them off, so current behavior is preserved. Only a
// stored 'false' switches the bar to icon-only.
function readStored(): boolean {
    if (typeof window === 'undefined') return true;
    try {
        return window.localStorage.getItem(TOP_NAV_LABELS_KEY) !== 'false';
    } catch {
        return true;
    }
}

/** Read the current labels flag without subscribing (sync layer use). */
export function currentTopNavLabels(): boolean {
    return readStored();
}

/** Apply a labels value through the same path a user commit uses. Hydration
 *  writes do not notify the sync bus. */
export function applyTopNavLabels(next: boolean): void {
    try {
        window.localStorage.setItem(TOP_NAV_LABELS_KEY, next ? 'true' : 'false');
    } catch {
        // ignore; localStorage may be unavailable (private mode, quota)
    }
    window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
}

export function useTopNavLabels(): [boolean, (next: boolean) => void] {
    const [showLabels, setShowLabelsState] = useState<boolean>(readStored);

    useEffect(() => {
        function onSettingsChanged() {
            setShowLabelsState(readStored());
        }
        window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
        return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    }, []);

    useEffect(() => {
        function onStorage(event: StorageEvent) {
            if (event.key !== TOP_NAV_LABELS_KEY) return;
            // Opt-out: anything other than an explicit 'false' (including a
            // cleared key) means labels are shown.
            setShowLabelsState(event.newValue !== 'false');
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setShowLabels = useCallback((next: boolean) => {
        applyTopNavLabels(next);
        setShowLabelsState(next);
        notifyPreferenceWrite('navigation', ['labels']);
    }, []);

    return [showLabels, setShowLabels];
}

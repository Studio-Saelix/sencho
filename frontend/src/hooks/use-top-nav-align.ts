import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

export const TOP_NAV_ALIGN_KEY = 'sencho.appearance.topNavAlign';

export type TopNavAlign = 'left' | 'center';

// Horizontal placement of the desktop top nav when it is icon-only (labels off).
// 'left' (the default) keeps the bar tucked against the left edge; 'center'
// centers the icon cluster. Only an explicit 'center' centers it, so a missing
// or unknown value stays left.
function readStored(): TopNavAlign {
    if (typeof window === 'undefined') return 'left';
    try {
        return window.localStorage.getItem(TOP_NAV_ALIGN_KEY) === 'center' ? 'center' : 'left';
    } catch {
        return 'left';
    }
}

export function useTopNavAlign(): [TopNavAlign, (next: TopNavAlign) => void] {
    const [align, setAlignState] = useState<TopNavAlign>(readStored);

    useEffect(() => {
        function onSettingsChanged() {
            setAlignState(readStored());
        }
        window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
        return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    }, []);

    useEffect(() => {
        function onStorage(event: StorageEvent) {
            if (event.key !== TOP_NAV_ALIGN_KEY) return;
            setAlignState(event.newValue === 'center' ? 'center' : 'left');
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setAlign = useCallback((next: TopNavAlign) => {
        try {
            window.localStorage.setItem(TOP_NAV_ALIGN_KEY, next);
        } catch {
            // ignore; localStorage may be unavailable (private mode, quota)
        }
        setAlignState(next);
        window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }, []);

    return [align, setAlign];
}

import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { notifyPreferenceWrite } from '@/lib/preferences/preferenceEvents';

/** How the Fleet tab strip is laid out. `grouped` is the default. */
export type FleetTabLayout = 'grouped' | 'flat' | 'compact';

export const FLEET_TAB_LAYOUT_KEY = 'sencho.fleet.tab-layout';
export const DEFAULT_FLEET_TAB_LAYOUT: FleetTabLayout = 'grouped';

export function isFleetTabLayout(value: unknown): value is FleetTabLayout {
    return value === 'grouped' || value === 'flat' || value === 'compact';
}

/** Read the current layout without subscribing (sync layer use). */
export function currentFleetTabLayout(): FleetTabLayout {
    if (typeof window === 'undefined') return DEFAULT_FLEET_TAB_LAYOUT;
    try {
        const raw = window.localStorage.getItem(FLEET_TAB_LAYOUT_KEY);
        return isFleetTabLayout(raw) ? raw : DEFAULT_FLEET_TAB_LAYOUT;
    } catch {
        // localStorage can be unavailable (private mode, blocked site data).
        return DEFAULT_FLEET_TAB_LAYOUT;
    }
}

/** Apply a value through the same path a user commit uses. Hydration writes
 *  do not notify the sync bus. */
export function applyFleetTabLayoutValue(next: FleetTabLayout): void {
    try {
        window.localStorage.setItem(FLEET_TAB_LAYOUT_KEY, next);
    } catch {
        // ignore; localStorage may be unavailable (private mode, quota)
    }
    window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
}

export function useFleetTabLayout(): [FleetTabLayout, (next: FleetTabLayout) => void] {
    const [layout, setLayoutState] = useState<FleetTabLayout>(currentFleetTabLayout);

    useEffect(() => {
        function onSettingsChanged() {
            setLayoutState(currentFleetTabLayout());
        }
        window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
        return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    }, []);

    useEffect(() => {
        function onStorage(event: StorageEvent) {
            if (event.key !== FLEET_TAB_LAYOUT_KEY) return;
            setLayoutState(isFleetTabLayout(event.newValue) ? event.newValue : DEFAULT_FLEET_TAB_LAYOUT);
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setLayout = useCallback((next: FleetTabLayout) => {
        applyFleetTabLayoutValue(next);
        setLayoutState(next);
        notifyPreferenceWrite('appearance', ['fleetTabLayout']);
    }, []);

    return [layout, setLayout];
}

import { useState, useEffect, useCallback } from 'react';
import type { FleetPreferences } from '../types';

const PREFS_KEY = 'sencho-fleet-preferences';

const DEFAULT_PREFS: FleetPreferences = {
    sortBy: 'name', sortDir: 'asc', filterStatus: 'all', filterType: 'all', filterCritical: false, filterNetworking: 'all',
};

function loadPreferences(): FleetPreferences {
    try {
        const stored = localStorage.getItem(PREFS_KEY);
        if (stored) return { ...DEFAULT_PREFS, ...(JSON.parse(stored) as Partial<FleetPreferences>) };
    } catch { /* corrupted or missing — use defaults */ }
    return { ...DEFAULT_PREFS };
}

function savePreferences(prefs: FleetPreferences) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* non-fatal: localStorage unavailable or quota exceeded */ }
}

export function useFleetPreferences() {
    const [prefs, setPrefs] = useState<FleetPreferences>(loadPreferences);

    const updatePrefs = useCallback((update: Partial<FleetPreferences>) => {
        setPrefs(prev => ({ ...prev, ...update }));
    }, []);

    useEffect(() => {
        savePreferences(prefs);
    }, [prefs]);

    return { prefs, updatePrefs };
}

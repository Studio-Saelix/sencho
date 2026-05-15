import { useCallback, useEffect, useState } from 'react';
import type { LayoutMode, SavedPositions } from '@/lib/fleet-topology-layout';

const PREFS_KEY = 'sencho-topology-preferences';

export interface TopologyPreferences {
    mode: LayoutMode;
    positions: SavedPositions;
}

const DEFAULT_PREFS: TopologyPreferences = {
    mode: 'hub',
    positions: {},
};

function isLayoutMode(value: unknown): value is LayoutMode {
    return value === 'hub' || value === 'grouped' || value === 'free';
}

function isSavedPositions(value: unknown): value is SavedPositions {
    if (!value || typeof value !== 'object') return false;
    for (const v of Object.values(value as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') return false;
        const p = v as { x?: unknown; y?: unknown };
        if (typeof p.x !== 'number' || typeof p.y !== 'number') return false;
    }
    return true;
}

function loadPreferences(): TopologyPreferences {
    try {
        const stored = localStorage.getItem(PREFS_KEY);
        if (!stored) return { ...DEFAULT_PREFS };
        const parsed = JSON.parse(stored) as Partial<TopologyPreferences>;
        return {
            mode: isLayoutMode(parsed.mode) ? parsed.mode : DEFAULT_PREFS.mode,
            positions: isSavedPositions(parsed.positions) ? parsed.positions : {},
        };
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

function savePreferences(prefs: TopologyPreferences) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
        /* non-fatal: localStorage unavailable or quota exceeded */
    }
}

export function useTopologyPreferences() {
    const [prefs, setPrefs] = useState<TopologyPreferences>(loadPreferences);

    useEffect(() => {
        savePreferences(prefs);
    }, [prefs]);

    const setMode = useCallback((mode: LayoutMode) => {
        setPrefs(prev => (prev.mode === mode ? prev : { ...prev, mode }));
    }, []);

    const setPositions = useCallback((positions: SavedPositions) => {
        setPrefs(prev => ({ ...prev, positions }));
    }, []);

    const updatePositions = useCallback(
        (updater: (current: SavedPositions) => SavedPositions) => {
            setPrefs(prev => ({ ...prev, positions: updater(prev.positions) }));
        },
        [],
    );

    return { prefs, setMode, setPositions, updatePositions };
}

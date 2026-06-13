import { useCallback, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** Settings field values are flat primitives, compared shallowly with `!==`. */
type SettingsValue = string | number | boolean | null | undefined;
type SettingsFields = Record<string, SettingsValue>;

/**
 * Tracks dirty state for a flat settings-fields object against a saved baseline.
 *
 * The baseline lives in state (not a ref) so adopting a new baseline re-renders
 * and re-runs the dirty calculation. Load and save-success are deliberately
 * separate operations: a section's fields stay editable while a save is in
 * flight, so the save path must move only the baseline and leave the current
 * values alone, or an edit made between clicking Save and the PATCH resolving
 * would be discarded.
 */
export interface SettingsDirty<T extends SettingsFields> {
    settings: T;
    setSettings: Dispatch<SetStateAction<T>>;
    dirtyCount: number;
    hasChanges: boolean;
    /** Load / node-switch: adopt `next` as both the current values and the saved baseline. */
    reset: (next: T) => void;
    /** Save success: adopt the submitted snapshot as the saved baseline only,
     *  preserving edits made while the PATCH was in flight. Pass a snapshot
     *  captured before the request, not live settings read after the await. */
    markSaved: (submitted: T) => void;
}

export function useSettingsDirty<T extends SettingsFields>(initial: T): SettingsDirty<T> {
    const [settings, setSettings] = useState<T>(initial);
    const [baseline, setBaseline] = useState<T>(initial);

    const dirtyCount = useMemo(() => {
        let n = 0;
        for (const key of Object.keys(settings) as (keyof T)[]) {
            if (settings[key] !== baseline[key]) n += 1;
        }
        return n;
    }, [settings, baseline]);

    const reset = useCallback((next: T) => {
        setSettings({ ...next });
        setBaseline({ ...next });
    }, []);

    const markSaved = useCallback((submitted: T) => {
        setBaseline({ ...submitted });
    }, []);

    return { settings, setSettings, dirtyCount, hasChanges: dirtyCount > 0, reset, markSaved };
}

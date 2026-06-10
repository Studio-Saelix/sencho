import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

export const DEPLOY_FEEDBACK_KEY = 'sencho.deploy-feedback.enabled';

// Default on (opt-out): the live deploy/update output panel shows unless the
// user has explicitly turned it off, so update progress and the stalled-output
// warning are visible without a setting hunt. Only a stored 'false' disables it.
function readStored(): boolean {
    if (typeof window === 'undefined') return true;
    try {
        return window.localStorage.getItem(DEPLOY_FEEDBACK_KEY) !== 'false';
    } catch {
        return true;
    }
}

export function useDeployFeedbackEnabled(): [boolean, (next: boolean) => void] {
    const [enabled, setEnabledState] = useState<boolean>(readStored);

    useEffect(() => {
        function onSettingsChanged() {
            setEnabledState(readStored());
        }
        window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
        return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    }, []);

    useEffect(() => {
        function onStorage(event: StorageEvent) {
            if (event.key !== DEPLOY_FEEDBACK_KEY) return;
            // Opt-out: anything other than an explicit 'false' (including a
            // cleared key) means enabled.
            setEnabledState(event.newValue !== 'false');
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setEnabled = useCallback((next: boolean) => {
        try {
            window.localStorage.setItem(DEPLOY_FEEDBACK_KEY, next ? 'true' : 'false');
        } catch {
            // ignore; localStorage may be unavailable (private mode, quota)
        }
        setEnabledState(next);
        window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }, []);

    return [enabled, setEnabled];
}

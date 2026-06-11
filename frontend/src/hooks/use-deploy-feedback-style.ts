import { useCallback, useEffect, useState } from 'react';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

export const DEPLOY_FEEDBACK_STYLE_KEY = 'sencho.deploy-feedback.style';

export type DeployFeedbackStyle = 'modal' | 'inline';

// How the live deploy/update progress surfaces while it streams. 'modal' (the
// default) is the centered overlay; 'inline' is the quiet in-page banner on the
// stack detail with the full log behind its "View output" button. Only an
// explicit 'inline' selects the banner; anything else stays on the modal, so a
// missing or unknown value is safe.
// Read the persisted style synchronously. Exported so non-React callers (the
// deploy-feedback context at deploy time) can read the current value directly
// rather than depend on a reactive snapshot that an event might not have
// refreshed yet.
export function readDeployFeedbackStyle(): DeployFeedbackStyle {
    if (typeof window === 'undefined') return 'modal';
    try {
        return window.localStorage.getItem(DEPLOY_FEEDBACK_STYLE_KEY) === 'inline' ? 'inline' : 'modal';
    } catch {
        // localStorage unavailable (private mode, quota): fall back to the modal default.
        return 'modal';
    }
}

export function useDeployFeedbackStyle(): [DeployFeedbackStyle, (next: DeployFeedbackStyle) => void] {
    const [style, setStyleState] = useState<DeployFeedbackStyle>(readDeployFeedbackStyle);

    useEffect(() => {
        function onSettingsChanged() {
            setStyleState(readDeployFeedbackStyle());
        }
        window.addEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
        return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, onSettingsChanged);
    }, []);

    useEffect(() => {
        function onStorage(event: StorageEvent) {
            if (event.key !== DEPLOY_FEEDBACK_STYLE_KEY) return;
            setStyleState(event.newValue === 'inline' ? 'inline' : 'modal');
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setStyle = useCallback((next: DeployFeedbackStyle) => {
        try {
            window.localStorage.setItem(DEPLOY_FEEDBACK_STYLE_KEY, next);
        } catch {
            // ignore; localStorage may be unavailable (private mode, quota)
        }
        setStyleState(next);
        window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
    }, []);

    return [style, setStyle];
}

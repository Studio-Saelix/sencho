import { useEffect } from 'react';
import { MUTE_RULES_CHANGED_EVENT } from '@/lib/muteRules';

/** Refetch mute rules when another surface creates or updates a rule. */
export function useMuteRulesRefresh(onRefresh: () => void): void {
    useEffect(() => {
        const handler = () => { onRefresh(); };
        window.addEventListener(MUTE_RULES_CHANGED_EVENT, handler);
        return () => window.removeEventListener(MUTE_RULES_CHANGED_EVENT, handler);
    }, [onRefresh]);
}

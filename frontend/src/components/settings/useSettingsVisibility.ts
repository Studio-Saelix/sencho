import { useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import type { VisibilityContext } from './registry';

/** Shared Settings visibility context for sidebar, gate, and page navigation. */
export function useSettingsVisibility(): VisibilityContext {
    const { isAdmin, can } = useAuth();
    const { isPaid } = useLicense();
    const { activeNode } = useNodes();
    const isRemote = activeNode?.type === 'remote';

    return useMemo(
        () => ({ isRemote, isAdmin, isPaid, can }),
        [isRemote, isAdmin, isPaid, can],
    );
}

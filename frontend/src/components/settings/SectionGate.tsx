import React from 'react';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import { getSettingsItem, isItemVisible, isItemLocked } from './registry';
import type { VisibilityContext } from './registry';
import type { SectionId } from './types';

interface SectionGateProps {
    sectionId: SectionId;
    children: React.ReactNode;
}

/**
 * Renders the section body only if the registry says it is visible AND
 * the operator has the entitlement to use it. Tier-locked sections are
 * hidden entirely from operators who do not qualify. Backend tier
 * guards remain the authoritative enforcement.
 */
export function SectionGate({ sectionId, children }: SectionGateProps) {
    const { isAdmin, permissions } = useAuth();
    const { isPaid } = useLicense();
    const { activeNode } = useNodes();

    const isAdmiral = permissions?.isAdmiral ?? false;
    const isRemote = activeNode?.type === 'remote';

    const visibility: VisibilityContext = {
        isAdmin,
        isPaid,
        isAdmiral,
        isRemote,
    };

    const item = getSettingsItem(sectionId);

    if (!item || !isItemVisible(item, visibility)) return null;
    if (isItemLocked(item, visibility)) return null;

    return <>{children}</>;
}

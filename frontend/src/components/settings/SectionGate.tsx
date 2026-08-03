import React from 'react';
import { useAuth } from '@/context/AuthContext';
import { getSettingsItem, isItemVisible, isItemLocked } from './registry';
import { useSettingsVisibility } from './useSettingsVisibility';
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
    const { permissionsStatus } = useAuth();
    const visibility = useSettingsVisibility();

    const item = getSettingsItem(sectionId);

    if (permissionsStatus === 'loading') {
        return <div className="h-48 animate-pulse rounded-lg bg-card" aria-busy="true" />;
    }

    if (!item || !isItemVisible(item, visibility)) return null;
    if (isItemLocked(item, visibility)) return null;

    return <>{children}</>;
}

import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { SettingsCallout } from './SettingsCallout';
import type { NodeSettingsLoadPhase } from './useNodeSettingsLoad';

/** Persistent error state when node settings failed to load for the active node. */
export function SettingsLoadError() {
    return (
        <SettingsCallout
            tone="error"
            icon={<AlertTriangle className="h-4 w-4" />}
            title="Could not load settings"
            subtitle="Settings for this node could not be loaded. Save stays unavailable until loading succeeds."
        />
    );
}

/**
 * Renders content only after an authoritative load for the active node.
 * Mid-switch / in-flight loads show `skeleton`; a failed load shows SettingsLoadError.
 */
export function SettingsLoadGate({
    phase,
    isCurrentNodeLoaded,
    skeleton,
    children,
}: {
    phase: NodeSettingsLoadPhase;
    isCurrentNodeLoaded: boolean;
    skeleton: ReactNode;
    children: ReactNode;
}) {
    if (isCurrentNodeLoaded) return children;
    if (phase === 'error') return <SettingsLoadError />;
    return skeleton;
}

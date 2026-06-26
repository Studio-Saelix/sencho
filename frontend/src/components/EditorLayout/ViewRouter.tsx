import { Suspense, lazy, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/AuthContext';
import { PaidGate } from '../PaidGate';
import { CapabilityGate } from '../CapabilityGate';
import { HubOnlyGate } from '../HubOnlyGate';
import LazyBoundary from '../LazyBoundary';
import { SettingsPage } from '../settings/SettingsPage';
import type { SectionId } from '../settings/types';
import { AppStoreView } from '../AppStoreView';
import ResourcesView from '../ResourcesView';
import HomeDashboard from '../HomeDashboard';
import type { NotificationItem } from '../dashboard/types';
import type { ScheduleTaskPrefill } from '../ScheduledOperationsView';
import type { ActiveView } from './hooks/useViewNavigationState';
import type { SecurityTab } from '@/lib/events';

// Paid-tier views are loaded on demand. Their internal PaidGate /
// CapabilityGate wrappers render
// the upsell or capability-missing card with blurred children rather than
// short-circuiting, so a tier-locked or capability-missing operator
// opening one of these tabs still triggers the chunk fetch to render the
// blurred preview. What this lazy split closes is the much larger
// initial-bundle leak: every Community user used to download the full
// FleetView, AuditLogView, etc. on first page load even if they never
// clicked those tabs. After this change, the chunks fetch only on tab
// open.
//
// GlobalObservabilityView is a free-tier feature with no internal gate;
// it is split here purely for the bundle-size win, not for IP protection.
const HostConsole = lazy(() => import('../HostConsole'));
const GlobalObservabilityView = lazy(() =>
    import('../GlobalObservabilityView').then(m => ({ default: m.GlobalObservabilityView })),
);
const FleetView = lazy(() =>
    import('../FleetView').then(m => ({ default: m.FleetView })),
);
const AuditLogView = lazy(() =>
    import('../AuditLogView').then(m => ({ default: m.AuditLogView })),
);
const ScheduledOperationsView = lazy(() => import('../ScheduledOperationsView'));
const AutoUpdateReadinessView = lazy(() => import('../AutoUpdateReadinessView'));
const SecurityView = lazy(() =>
    import('../SecurityView').then(m => ({ default: m.SecurityView })),
);

// Sized for the main workspace area (flex-1 with p-6 padding). Visible
// only during the brief window between an unlocked view's chunk request
// and its first render.
function ViewSkeleton() {
    return (
        <div className="flex flex-col gap-6" aria-busy="true">
            <Skeleton className="h-10 w-1/3 rounded-md" />
            <Skeleton className="h-96 w-full rounded-lg" />
        </div>
    );
}

function LazyView({ children }: { children: ReactNode }) {
    return (
        <LazyBoundary>
            <Suspense fallback={<ViewSkeleton />}>
                {children}
            </Suspense>
        </LazyBoundary>
    );
}

export type { ActiveView };

export interface ViewRouterProps {
    activeView: ActiveView;
    selectedFile: string | null;
    isLoading: boolean;
    settingsSection: SectionId;
    onSettingsSectionChange: (section: SectionId) => void;
    onTemplateDeploySuccess: (stackName: string) => void;
    onHostConsoleClose: () => void;
    onFleetNavigateToNode: (nodeId: number, stackName: string) => void;
    filterNodeId: number | null;
    onClearScheduledOpsFilter: () => void;
    schedulePrefill: ScheduleTaskPrefill | null;
    onPrefillConsumed: () => void;
    notifications: NotificationItem[];
    onNavigateToStack: (stackFile: string) => void;
    onOpenSettingsSection: (section: SectionId) => void;
    onClearNotifications: () => void;
    securityTab: SecurityTab;
    onSecurityTabChange: (tab: SecurityTab) => void;
    fleetUpdatesIntent?: { tab: 'nodes' | 'changelog' } | null;
    onFleetUpdatesIntentConsumed?: () => void;
    // Render slot for the inline editor view. Kept as a callback so the
    // (large) editor JSX is only allocated when activeView === 'editor',
    // not on every parent render that lands on a different view.
    renderEditor: () => ReactNode;
}

export function ViewRouter({
    activeView,
    selectedFile,
    isLoading,
    settingsSection,
    onSettingsSectionChange,
    onTemplateDeploySuccess,
    onHostConsoleClose,
    onFleetNavigateToNode,
    filterNodeId,
    onClearScheduledOpsFilter,
    schedulePrefill,
    onPrefillConsumed,
    notifications,
    onNavigateToStack,
    onOpenSettingsSection,
    onClearNotifications,
    securityTab,
    onSecurityTabChange,
    fleetUpdatesIntent,
    onFleetUpdatesIntentConsumed,
    renderEditor,
}: ViewRouterProps): ReactNode {
    const { can } = useAuth();
    if (activeView === 'settings') {
        return (
            <SettingsPage
                currentSection={settingsSection}
                onSectionChange={onSettingsSectionChange}
            />
        );
    }
    if (activeView === 'templates') {
        return <AppStoreView onDeploySuccess={onTemplateDeploySuccess} />;
    }
    if (activeView === 'resources') {
        return <ResourcesView />;
    }
    if (activeView === 'security') {
        // Node-scoped (not hub-only): scan/scanner data follows the active node
        // like Resources. The page itself is Community; per-tab gates handle
        // capability-missing nodes and the local-control governance tabs.
        return (
            <LazyView>
                <SecurityView activeTab={securityTab} onTabChange={onSecurityTabChange} />
            </LazyView>
        );
    }
    if (activeView === 'host-console') {
        // Mirror the backend RBAC gate (system:console, admin-only). The nav
        // item is already admin-gated; this stops a non-admin who reaches the
        // view another way from mounting a console that the server will 403.
        if (!can('system:console')) return null;
        return (
            <PaidGate>
                <CapabilityGate capability="host-console" featureName="Host Console">
                    <LazyView>
                        <HostConsole stackName={selectedFile} onClose={onHostConsoleClose} />
                    </LazyView>
                </CapabilityGate>
            </PaidGate>
        );
    }
    // Fall-through: when activeView === 'editor' but selectedFile is
    // null or the stack is still loading, drop through to the default
    // HomeDashboard render below. This matches the pre-extraction
    // behavior of the conditional ternary chain in EditorLayout.tsx.
    if (!isLoading && selectedFile && activeView === 'editor') {
        return renderEditor();
    }
    if (activeView === 'global-observability') {
        return (
            <HubOnlyGate>
                <LazyView>
                    <GlobalObservabilityView />
                </LazyView>
            </HubOnlyGate>
        );
    }
    if (activeView === 'fleet') {
        return (
            <HubOnlyGate>
                <CapabilityGate capability="fleet" featureName="Fleet Management">
                    <LazyView>
                        <FleetView
                      onNavigateToNode={onFleetNavigateToNode}
                      fleetUpdatesIntent={fleetUpdatesIntent}
                      onFleetUpdatesIntentConsumed={onFleetUpdatesIntentConsumed}
                    />
                    </LazyView>
                </CapabilityGate>
            </HubOnlyGate>
        );
    }
    if (activeView === 'audit-log') {
        return (
            <HubOnlyGate>
                <CapabilityGate capability="audit-log" featureName="Audit Log">
                    <LazyView>
                        <AuditLogView />
                    </LazyView>
                </CapabilityGate>
            </HubOnlyGate>
        );
    }
    if (activeView === 'auto-updates') {
        return (
            <HubOnlyGate>
                <CapabilityGate capability="auto-updates" featureName="Auto-Update Readiness">
                    <LazyView>
                        <AutoUpdateReadinessView />
                    </LazyView>
                </CapabilityGate>
            </HubOnlyGate>
        );
    }
    if (activeView === 'scheduled-ops') {
        return (
            <HubOnlyGate>
                <CapabilityGate capability="scheduled-ops" featureName="Scheduled Operations">
                    <LazyView>
                        <ScheduledOperationsView
                            filterNodeId={filterNodeId}
                            onClearFilter={onClearScheduledOpsFilter}
                            prefill={schedulePrefill}
                            onPrefillConsumed={onPrefillConsumed}
                        />
                    </LazyView>
                </CapabilityGate>
            </HubOnlyGate>
        );
    }
    return (
        <HomeDashboard
            onNavigateToStack={onNavigateToStack}
            onOpenSettingsSection={onOpenSettingsSection}
            notifications={notifications}
            onClearNotifications={onClearNotifications}
        />
    );
}

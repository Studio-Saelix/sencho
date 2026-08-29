import { Suspense, lazy, type ReactNode } from 'react';
import { Unplug } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import { resolveHostConsoleCapability, resolveHostConsoleLockMessage } from '@/lib/routing/hostConsoleCapability';
import { LockCard } from '../ui/LockCard';
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
import type { MuteRuleDraft } from '@/lib/muteRules';
import type { ActiveView } from './hooks/useViewNavigationState';
import type { StackUpdateInfo } from '@/types/imageUpdates';
import type { SecurityTab, FleetTab } from '@/lib/events';
import { isStackEditorDeepLink, isHostConsoleStackDeepLink } from '@/lib/router/readUrlRouteState';
import type { NavDestination } from '@/lib/navigation/appNavRegistry';

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
const NetworkingView = lazy(() =>
  import('../networking/NetworkingView').then(m => ({ default: m.NetworkingView })),
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
    onOpenNodeNetworking: (nodeId: number) => void;
    filterNodeId: number | null;
    onClearScheduledOpsFilter: () => void;
    schedulePrefill: ScheduleTaskPrefill | null;
    onPrefillConsumed: () => void;
    muteRulePrefill: MuteRuleDraft | null;
    onMutePrefillConsumed: () => void;
    notifications: NotificationItem[];
    onNavigateToStack: (stackFile: string) => void;
    onOpenSettingsSection: (section: SectionId) => void;
    onOpenMuteRulesWithPrefill?: (draft: MuteRuleDraft) => void;
    onClearNotifications: () => void;
    securityTab: SecurityTab;
    onSecurityTabChange: (tab: SecurityTab) => void;
    fleetUpdatesIntent?: { tab: 'nodes' | 'changelog' } | null;
    onFleetUpdatesIntentConsumed?: () => void;
    fleetActiveTab?: FleetTab;
    onFleetActiveTabChange?: (tab: FleetTab) => void;
    // Render slot for the inline editor view. Kept as a callback so the
    // (large) editor JSX is only allocated when activeView === 'editor',
    // not on every parent render that lands on a different view.
    renderEditor: () => ReactNode;
    stackUpdates: Record<string, StackUpdateInfo>;
    urlHydratingStack: string | null;
    isFileLoading: boolean;
    quickLinkCandidates?: NavDestination[];
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
    onOpenNodeNetworking,
    filterNodeId,
    onClearScheduledOpsFilter,
    schedulePrefill,
    onPrefillConsumed,
    muteRulePrefill,
    onMutePrefillConsumed,
    notifications,
    onNavigateToStack,
    onOpenSettingsSection,
    onOpenMuteRulesWithPrefill,
    onClearNotifications,
    securityTab,
    onSecurityTabChange,
    fleetUpdatesIntent,
    onFleetUpdatesIntentConsumed,
    fleetActiveTab,
    onFleetActiveTabChange,
    renderEditor,
    stackUpdates,
    urlHydratingStack,
    isFileLoading,
    quickLinkCandidates,
}: ViewRouterProps): ReactNode {
    const { can, permissionsStatus } = useAuth();
    const { isPaid, licenseReady } = useLicense();
    const { activeNode, activeNodeMeta } = useNodes();
    if (activeView === 'settings') {
        return (
            <SettingsPage
                currentSection={settingsSection}
                onSectionChange={onSettingsSectionChange}
                muteRulePrefill={muteRulePrefill}
                onMutePrefillConsumed={onMutePrefillConsumed}
                onOpenMuteRulesWithPrefill={onOpenMuteRulesWithPrefill}
                quickLinkCandidates={quickLinkCandidates}
            />
        );
    }
    if (activeView === 'templates') {
        return <AppStoreView onDeploySuccess={onTemplateDeploySuccess} />;
    }
    if (activeView === 'resources') {
        return <ResourcesView />;
    }
    if (activeView === 'networking') {
        return (
            <LazyView>
                <NetworkingView />
            </LazyView>
        );
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
        // RBAC + mixed-version capability. Wait for a resolved active node and
        // remote meta; null activeNode must not be treated as local (wrong-node
        // or doomed WebSocket). Stack deep links hydrate selectedFile async:
        // wait so we never open a compose-root shell, then reconnect into the stack.
        if (permissionsStatus === 'loading') return <ViewSkeleton />;
        if (!can('system:console')) return null;
        if (urlHydratingStack != null || (isHostConsoleStackDeepLink() && !selectedFile)) {
            return <ViewSkeleton />;
        }
        if (activeNode == null) return <ViewSkeleton />;
        const capState = resolveHostConsoleCapability({
            nodeResolved: true,
            isRemote: activeNode.type === 'remote',
            isPaid,
            licenseReady,
            activeNodeMeta,
        });
        if (capState === 'loading') return <ViewSkeleton />;
        if (capState === 'locked') {
            const { title, body } = resolveHostConsoleLockMessage({
                nodeMode: activeNode.mode,
                nodeName: activeNode.name,
                version: activeNodeMeta?.version,
            });
            return (
                <LockCard
                    icon={Unplug}
                    title={title}
                    body={body}
                />
            );
        }
        const nodeId = activeNode.id;
        return (
            <LazyView>
                <HostConsole
                    key={`${nodeId}:${selectedFile ?? ''}`}
                    nodeId={nodeId}
                    stackName={selectedFile}
                    onClose={onHostConsoleClose}
                />
            </LazyView>
        );
    }
    // Stack workspace: keep a loading shell while the stack URL hydrates.
    // Never fall through to HomeDashboard for editor deep links (refresh flash).
    if (activeView === 'editor') {
        if (selectedFile) {
            return renderEditor();
        }
        const awaitingStack = urlHydratingStack != null || isFileLoading || isStackEditorDeepLink();
        if (awaitingStack || isLoading) {
            return <ViewSkeleton />;
        }
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
                      onOpenNodeNetworking={onOpenNodeNetworking}
                      onOpenSettingsSection={onOpenSettingsSection}
                      onOpenMuteRulesWithPrefill={onOpenMuteRulesWithPrefill}
                      fleetUpdatesIntent={fleetUpdatesIntent}
                      onFleetUpdatesIntentConsumed={onFleetUpdatesIntentConsumed}
                      fleetActiveTab={fleetActiveTab}
                      onFleetActiveTabChange={onFleetActiveTabChange}
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
            stackUpdates={stackUpdates}
        />
    );
}

import { useState, useEffect } from 'react';
import {
    RefreshCw, Camera, FileDown,
    Network, SlidersHorizontal,
    Send, KeyRound, ArrowLeftRight, Wrench, Workflow, Tag,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FleetMasthead } from './fleet/FleetMasthead';
import { ReconnectingOverlay } from './FleetView/ReconnectingOverlay';
import { NodeUpdatesSheet } from './FleetView/NodeUpdatesSheet';
import { NodeDetailsSheet } from './FleetView/NodeDetailsSheet';
import { LocalUpdateConfirmDialog } from './FleetView/LocalUpdateConfirmDialog';
import { OverviewTab } from './FleetView/OverviewTab';
import { useFleetPreferences } from './FleetView/hooks/useFleetPreferences';
import { useFleetUpdateStatus } from './FleetView/hooks/useFleetUpdateStatus';
import { useFleetPolling } from './FleetView/hooks/useFleetPolling';
import { useFleetOverview } from './FleetView/hooks/useFleetOverview';
import { useFleetDossierExport } from './FleetView/hooks/useFleetDossierExport';
import { useTopologyPreferences } from '@/hooks/useTopologyPreferences';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { springs } from '@/lib/motion';
import { useLicense } from '@/context/LicenseContext';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { useExperimental } from '@/hooks/useExperimental';
import { PaidGate } from './PaidGate';
import FleetSnapshots from './FleetSnapshots';
import { FleetConfiguration } from './fleet/FleetConfiguration';
import { RoutingTab } from './fleet/RoutingTab';
import { FederationTab } from './fleet/FederationTab';
import { DeploymentsTab } from './blueprints/DeploymentsTab';
import { FleetActionsTab } from './fleet/FleetActions/FleetActionsTab';
import { SecretsTab } from './fleet/secrets/SecretsTab';
import { DependencyMapTab } from './fleet/DependencyMapTab';
import { ContainerLabelsTab } from './fleet/ContainerLabelsTab';
import { useNodeActions } from './nodes/useNodeActions';
import type { FleetTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import type { MuteRuleDraft } from '@/lib/muteRules';

interface FleetViewProps {
    onNavigateToNode: (nodeId: number, stackName: string) => void;
    /** Switches to a node and opens its Networking page (Fleet networking signal). */
    onOpenNodeNetworking: (nodeId: number) => void;
    /** Opens a Settings section (used to send "Add node" to Settings > Nodes). */
    onOpenSettingsSection?: (section: SectionId) => void;
    onOpenMuteRulesWithPrefill?: (draft: MuteRuleDraft) => void;
    fleetUpdatesIntent?: { tab: 'nodes' | 'changelog' } | null;
    onFleetUpdatesIntentConsumed?: () => void;
    /** Controlled fleet sub-tab (shell-owned for URL sync). */
    fleetActiveTab?: FleetTab;
    onFleetActiveTabChange?: (tab: FleetTab) => void;
}

export function FleetView({
    onNavigateToNode,
    onOpenNodeNetworking,
    onOpenSettingsSection,
    onOpenMuteRulesWithPrefill,
    fleetUpdatesIntent,
    onFleetUpdatesIntentConsumed,
    fleetActiveTab: controlledTab,
    onFleetActiveTabChange,
}: FleetViewProps) {
    const { isPaid, licenseStatus } = useLicense();
    const { isAdmin, can } = useAuth();
    const canManageFleet = can('node:manage');
    const canExportDossier = can('node:read') && can('stack:read');
    const { hasCapability, nodes: registryNodes } = useNodes();
    const { experimental, experimentalReady } = useExperimental();
    const containerLabelsEnabled = hasCapability('container-label-inventory');
    // Visual fail-closed while /meta loads; paid/admin gates still apply when on.
    const canDiscoverRouting = experimentalReady && experimental && isPaid;
    const canDiscoverSecrets = experimentalReady && experimental && isPaid && isAdmin;

    const { prefs, updatePrefs } = useFleetPreferences();
    const updateStatus = useFleetUpdateStatus();
    const overview = useFleetOverview({ prefs, updatePrefs, updateStatuses: updateStatus.updateStatuses });
    // Confirm dialogs: local update uses pin/target copy; reapply covers local
    // and remote nodes with mode-specific wording. Prefer reapply when both set.
    const confirmMode = updateStatus.reapplyConfirm !== null ? 'reapply' as const : 'update' as const;
    const confirmNodeId = updateStatus.reapplyConfirm ?? updateStatus.localUpdateConfirm;
    const confirmOpen = confirmNodeId !== null;
    const confirmStatus = confirmNodeId !== null
        ? updateStatus.updateStatuses.find(s => s.nodeId === confirmNodeId)
        : undefined;
    const topology = useTopologyPreferences();
    const { exporting, exportDossier } = useFleetDossierExport();

    useFleetPolling({
        fetchOverview: overview.fetchOverview,
        fetchUpdateStatus: updateStatus.fetchUpdateStatus,
        updateStatuses: updateStatus.updateStatuses,
    });

    const [initialUpdatesTab, setInitialUpdatesTab] = useState<'nodes' | 'changelog'>('nodes');
    const [detailsNodeId, setDetailsNodeId] = useState<number | null>(null);

    const [internalTab, setInternalTab] = useState<FleetTab>('overview');
    const activeTab = controlledTab ?? internalTab;
    const setActiveTab = (tab: FleetTab) => {
        onFleetActiveTabChange?.(tab);
        if (controlledTab === undefined) setInternalTab(tab);
    };

    // Fall back only after experimental readiness settles. When experimental is
    // on, also wait for license (and admin for secrets) so a paid deep link is
    // not rewritten to Overview while isPaid is still the cold-load false.
    useEffect(() => {
        if (!experimentalReady) return;
        if (activeTab === 'routing') {
            if (!experimental) {
                setActiveTab('overview');
                return;
            }
            if (licenseStatus !== 'ready') return;
            if (!isPaid) setActiveTab('overview');
            return;
        }
        if (activeTab === 'secrets') {
            if (!experimental) {
                setActiveTab('overview');
                return;
            }
            if (licenseStatus !== 'ready') return;
            if (!isPaid || !isAdmin) setActiveTab('overview');
        }
    // setActiveTab closes over onFleetActiveTabChange; listing deps explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [experimentalReady, experimental, licenseStatus, isPaid, isAdmin, activeTab]);

    useEffect(() => {
        if (fleetUpdatesIntent) {
            setInitialUpdatesTab(fleetUpdatesIntent.tab);
            updateStatus.setShowUpdateModal(true);
            updateStatus.fetchUpdateStatus();
            onFleetUpdatesIntentConsumed?.();
        }
    }, [fleetUpdatesIntent, updateStatus, onFleetUpdatesIntentConsumed]);

    const { mastheadStats, lastSyncAt, loading, refreshing } = overview;

    const { openEdit, openDelete, NodeActionModals } = useNodeActions({
        onNodeChange: () => { void overview.fetchOverview(true); },
    });

    return (
        <div className="h-full overflow-auto p-6">
            <FleetMasthead
                nodeCount={mastheadStats.nodeCount}
                onlineCount={mastheadStats.onlineCount}
                criticalCount={mastheadStats.criticalCount}
                totalCpuPercent={mastheadStats.avgCpuNum}
                worstCpu={mastheadStats.worstCpu}
                totalMemUsed={mastheadStats.totalMemUsed}
                totalMemTotal={mastheadStats.totalMemTotal}
                activeContainers={mastheadStats.totalContainers}
                totalContainers={mastheadStats.totalContainersAll}
                lastSyncAt={lastSyncAt}
                loading={loading}
            />

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as FleetTab)}>
                <div className="flex items-center justify-between gap-3 mb-4 flex-wrap rounded-lg border border-card-border bg-card/40 px-2.5 py-1.5">
                    {/* Flatten the list's own pill band so the tabs sit directly in
                        the single full-width band, not a nested second band. */}
                    <TabsList className="border-transparent bg-transparent max-md:w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]">
                        <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
                            <TabsHighlightItem value="overview">
                                <TabsTrigger value="overview">Overview</TabsTrigger>
                            </TabsHighlightItem>
                            {isAdmin && (
                                <TabsHighlightItem value="snapshots">
                                    <TabsTrigger value="snapshots">
                                        <Camera className="w-4 h-4 mr-1.5" />Snapshots
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                            <TabsHighlightItem value="configuration">
                                <TabsTrigger value="configuration">
                                    <SlidersHorizontal className="w-4 h-4 mr-1.5" />Status
                                </TabsTrigger>
                            </TabsHighlightItem>
                            <TabsHighlightItem value="dependencies">
                                <TabsTrigger value="dependencies">
                                    <Workflow className="w-4 h-4 mr-1.5" />Map
                                </TabsTrigger>
                            </TabsHighlightItem>
                            {containerLabelsEnabled && (
                                <TabsHighlightItem value="container-labels">
                                    <TabsTrigger value="container-labels">
                                        <Tag className="w-4 h-4 mr-1.5" />Docker Labels
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                            <span aria-hidden className="self-center mx-1 h-4 w-px bg-border" />
                            <TabsHighlightItem value="deployments">
                                    <TabsTrigger value="deployments">
                                        <Send className="w-4 h-4 mr-1.5" />Deployments
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            {canDiscoverRouting && (
                                <TabsHighlightItem value="routing">
                                    <TabsTrigger value="routing">
                                        <ArrowLeftRight className="w-4 h-4 mr-1.5" />Routing
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                            <TabsHighlightItem value="federation">
                                    <TabsTrigger value="federation">
                                        <Network className="w-4 h-4 mr-1.5" />Federation
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            <TabsHighlightItem value="actions">
                                <TabsTrigger value="actions">
                                    <Wrench className="w-4 h-4 mr-1.5" />Actions
                                </TabsTrigger>
                            </TabsHighlightItem>
                            {canDiscoverSecrets && (
                                <TabsHighlightItem value="secrets">
                                    <TabsTrigger value="secrets">
                                        <KeyRound className="w-4 h-4 mr-1.5" />Secrets
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                        </TabsHighlight>
                    </TabsList>
                    <div className="flex items-center gap-2 shrink-0">
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => overview.fetchOverview(true)}
                                        disabled={refreshing}
                                        className="h-9 w-9 p-0"
                                        aria-label="Refresh"
                                    >
                                        <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Refresh</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        {canExportDossier && (
                            <TooltipProvider>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => { void exportDossier(); }}
                                            disabled={exporting}
                                            className="h-9 w-9 p-0"
                                            aria-label="Export Dossier"
                                        >
                                            <FileDown className={`w-4 h-4 ${exporting ? 'animate-pulse' : ''}`} />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Export Dossier</TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                        )}
                    </div>
                </div>

                <TabsContent value="overview">
                    <OverviewTab
                        loading={loading}
                        nodes={overview.nodes}
                        processedNodes={overview.processedNodes}
                        allNodes={overview.allNodes}
                        topologyNodes={overview.topologyNodes}
                        viewMode={overview.viewMode}
                        onViewModeChange={overview.setViewMode}
                        searchQuery={overview.searchQuery}
                        onSearchQueryChange={overview.setSearchQuery}
                        prefs={prefs}
                        onPrefsChange={updatePrefs}
                        fleetPalette={overview.fleetPalette}
                        labelFilters={overview.labelFilters}
                        onLabelFiltersChange={overview.setLabelFilters}
                        onClearFilters={overview.clearFilters}
                        fleetStackLabelMap={overview.fleetStackLabelMap}
                        updateStatusMap={overview.updateStatusMap}
                        onNavigateToNode={onNavigateToNode}
                        onOpenNodeNetworking={onOpenNodeNetworking}
                        networkingByNode={overview.networkingByNode}
                        onUpdate={updateStatus.triggerNodeUpdate}
                        updatingNodeId={updateStatus.updatingNodeId}
                        onRetryUpdate={updateStatus.retryNodeUpdate}
                        onDismissUpdate={updateStatus.dismissNodeUpdate}
                        onCordonChange={() => { void overview.fetchOverview(true); }}
                        onEditNode={openEdit}
                        onDeleteNode={openDelete}
                        onOpenMuteRulesWithPrefill={onOpenMuteRulesWithPrefill}
                        onOpenNodeDetails={setDetailsNodeId}
                        onAddNode={isAdmin && onOpenSettingsSection ? () => onOpenSettingsSection('nodes') : undefined}
                        onCheckUpdates={updateStatus.checkUpdates}
                        checkingUpdates={updateStatus.checkingUpdates}
                        topologyMode={topology.prefs.mode}
                        onTopologyModeChange={topology.setMode}
                        topologyPositions={topology.prefs.positions}
                        onTopologyPositionsChange={topology.setPositions}
                    />
                </TabsContent>

                {isAdmin && (
                    <TabsContent value="snapshots">
                        <FleetSnapshots />
                    </TabsContent>
                )}
                <TabsContent value="configuration">
                    <FleetConfiguration />
                </TabsContent>
                <TabsContent value="dependencies">
                    <DependencyMapTab />
                </TabsContent>
                {containerLabelsEnabled && (
                    <TabsContent value="container-labels">
                        <ContainerLabelsTab onNavigateToNode={onNavigateToNode} />
                    </TabsContent>
                )}
                <TabsContent value="deployments">
                        <DeploymentsTab />
                    </TabsContent>
                {canDiscoverRouting && (
                    <TabsContent value="routing">
                        <PaidGate>
                            <RoutingTab
                                canManageNode={(nodeId) => can('node:manage', 'node', String(nodeId))}
                                canManageMembership={isAdmin}
                            />
                        </PaidGate>
                    </TabsContent>
                )}
                <TabsContent value="federation">
                    <FederationTab
                        canManage={canManageFleet}
                        canManageNode={(nodeId) => can('node:manage', 'node', String(nodeId))}
                    />
                </TabsContent>
                <TabsContent value="actions">
                    {/* Fleet Actions runs against the whole fleet, so it takes the
                        unfiltered node list rather than the overview-filtered view. */}
                    <FleetActionsTab nodes={overview.nodes} />
                </TabsContent>
                {canDiscoverSecrets && (
                    <TabsContent value="secrets">
                        <SecretsTab />
                    </TabsContent>
                )}
            </Tabs>

            {updateStatus.reconnecting && (
                <ReconnectingOverlay
                    preUpdateStartedAt={updateStatus.preUpdateStartedAt}
                    mode={updateStatus.reconnectMode}
                />
            )}

            <NodeUpdatesSheet
                open={updateStatus.showUpdateModal}
                onOpenChange={updateStatus.setShowUpdateModal}
                checkingUpdates={updateStatus.checkingUpdates}
                updateStatuses={updateStatus.updateStatuses}
                updatingNodeId={updateStatus.updatingNodeId}
                isAdmin={isAdmin}
                initialTab={initialUpdatesTab}
                fetchUpdateStatus={updateStatus.fetchUpdateStatus}
                triggerNodeUpdate={updateStatus.triggerNodeUpdate}
                triggerNodeReapply={updateStatus.triggerNodeReapply}
                retryNodeUpdate={updateStatus.retryNodeUpdate}
                dismissNodeUpdate={updateStatus.dismissNodeUpdate}
                triggerUpdateAll={updateStatus.triggerUpdateAll}
            />

            <NodeDetailsSheet
                open={detailsNodeId !== null}
                onOpenChange={(open) => { if (!open) setDetailsNodeId(null); }}
                node={detailsNodeId !== null ? (overview.allNodes.find(n => n.id === detailsNodeId) ?? null) : null}
                registryNode={detailsNodeId !== null ? (registryNodes.find(n => n.id === detailsNodeId) ?? null) : null}
                updateStatus={detailsNodeId !== null ? overview.updateStatusMap.get(detailsNodeId) : undefined}
                networkingSignal={detailsNodeId !== null ? overview.networkingByNode.get(detailsNodeId) : undefined}
                canManageNode={detailsNodeId !== null && can('node:manage', 'node', String(detailsNodeId))}
                onOpenNetworking={onOpenNodeNetworking}
                onEdit={openEdit}
            />

            <LocalUpdateConfirmDialog
                open={confirmOpen}
                mode={confirmMode}
                nodeType={
                    confirmMode === 'reapply'
                        ? (updateStatus.reapplyConfirmTarget?.type ?? 'local')
                        : (confirmStatus?.type ?? 'local')
                }
                onOpenChange={(open) => {
                    if (!open) {
                        updateStatus.setLocalUpdateConfirm(null);
                        updateStatus.setReapplyConfirm(null);
                    }
                }}
                onConfirm={confirmMode === 'reapply'
                    ? updateStatus.confirmReapply
                    : updateStatus.confirmLocalUpdate}
                imagePinKind={confirmStatus?.imagePinKind}
                composeImageRef={confirmStatus?.composeImageRef}
                targetImageRef={confirmStatus?.targetImageRef}
                targetVersion={confirmStatus?.latestVersion}
            />

            {NodeActionModals}
        </div>
    );
}

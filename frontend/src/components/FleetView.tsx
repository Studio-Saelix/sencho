import {
    RefreshCw, Camera, FileDown,
    Network, SlidersHorizontal,
    Send, KeyRound, ArrowLeftRight, Wrench, Workflow,
} from 'lucide-react';
import { FleetMasthead } from './fleet/FleetMasthead';
import { ReconnectingOverlay } from './FleetView/ReconnectingOverlay';
import { NodeUpdatesSheet } from './FleetView/NodeUpdatesSheet';
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
import { PaidGate } from './PaidGate';
import FleetSnapshots from './FleetSnapshots';
import { FleetConfiguration } from './fleet/FleetConfiguration';
import { RoutingTab } from './fleet/RoutingTab';
import { FederationTab } from './fleet/FederationTab';
import { DeploymentsTab } from './blueprints/DeploymentsTab';
import { FleetActionsTab } from './fleet/FleetActions/FleetActionsTab';
import { SecretsTab } from './fleet/secrets/SecretsTab';
import { DependencyMapTab } from './fleet/DependencyMapTab';
import { useNodeActions } from './nodes/useNodeActions';

interface FleetViewProps {
    onNavigateToNode: (nodeId: number, stackName: string) => void;
}

export function FleetView({ onNavigateToNode }: FleetViewProps) {
    const { isPaid } = useLicense();
    const { isAdmin } = useAuth();

    const { prefs, updatePrefs } = useFleetPreferences();
    const updateStatus = useFleetUpdateStatus();
    const overview = useFleetOverview({ prefs, updatePrefs, updateStatuses: updateStatus.updateStatuses });
    const topology = useTopologyPreferences();
    const { exporting, exportDossier } = useFleetDossierExport();

    useFleetPolling({
        fetchOverview: overview.fetchOverview,
        fetchUpdateStatus: updateStatus.fetchUpdateStatus,
        updateStatuses: updateStatus.updateStatuses,
    });

    const { mastheadStats, lastSyncAt, loading, refreshing } = overview;

    const { openCreate, openEdit, openDelete, NodeActionModals } = useNodeActions({
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

            <Tabs defaultValue="overview">
                <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                    <TabsList className="max-md:w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]">
                        <TabsHighlight className="rounded-md bg-glass-highlight" transition={springs.snappy}>
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
                            <span aria-hidden className="self-center mx-1 h-4 w-px bg-border" />
                            {isPaid && (
                                <TabsHighlightItem value="deployments">
                                    <TabsTrigger value="deployments">
                                        <Send className="w-4 h-4 mr-1.5" />Deployments
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                            {isPaid && (
                                <TabsHighlightItem value="routing">
                                    <TabsTrigger value="routing">
                                        <ArrowLeftRight className="w-4 h-4 mr-1.5" />Routing
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                            {isPaid && (
                                <TabsHighlightItem value="federation">
                                    <TabsTrigger value="federation">
                                        <Network className="w-4 h-4 mr-1.5" />Federation
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                            <TabsHighlightItem value="actions">
                                <TabsTrigger value="actions">
                                    <Wrench className="w-4 h-4 mr-1.5" />Actions
                                </TabsTrigger>
                            </TabsHighlightItem>
                            {isPaid && isAdmin && (
                                <TabsHighlightItem value="secrets">
                                    <TabsTrigger value="secrets">
                                        <KeyRound className="w-4 h-4 mr-1.5" />Secrets
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                        </TabsHighlight>
                    </TabsList>
                    <div className="flex items-center gap-2 max-md:w-full max-md:flex-wrap">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => overview.fetchOverview(true)}
                            disabled={refreshing}
                            className="gap-2"
                        >
                            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                        {isAdmin && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => { void exportDossier(); }}
                                disabled={exporting}
                                className="gap-2"
                            >
                                <FileDown className={`w-4 h-4 ${exporting ? 'animate-pulse' : ''}`} />
                                {exporting ? 'Exporting…' : 'Export Dossier'}
                            </Button>
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
                        onUpdate={updateStatus.triggerNodeUpdate}
                        updatingNodeId={updateStatus.updatingNodeId}
                        onRetryUpdate={updateStatus.retryNodeUpdate}
                        onDismissUpdate={updateStatus.dismissNodeUpdate}
                        onCordonChange={() => { void overview.fetchOverview(true); }}
                        onEditNode={isAdmin ? openEdit : undefined}
                        onDeleteNode={isAdmin ? openDelete : undefined}
                        onAddNode={isAdmin ? openCreate : undefined}
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
                {isPaid && (
                    <TabsContent value="deployments">
                        <DeploymentsTab />
                    </TabsContent>
                )}
                {isPaid && (
                    <TabsContent value="routing">
                        <PaidGate>
                            <RoutingTab canManage={isAdmin} />
                        </PaidGate>
                    </TabsContent>
                )}
                {isPaid && (
                    <TabsContent value="federation">
                        <PaidGate>
                            <FederationTab canManage={isAdmin} />
                        </PaidGate>
                    </TabsContent>
                )}
                <TabsContent value="actions">
                    {/* Fleet Actions runs against the whole fleet, so it takes the
                        unfiltered node list rather than the overview-filtered view. */}
                    <FleetActionsTab nodes={overview.nodes} />
                </TabsContent>
                {isPaid && isAdmin && (
                    <TabsContent value="secrets">
                        <SecretsTab />
                    </TabsContent>
                )}
            </Tabs>

            {updateStatus.reconnecting && (
                <ReconnectingOverlay preUpdateStartedAt={updateStatus.preUpdateStartedAt} />
            )}

            <NodeUpdatesSheet
                open={updateStatus.showUpdateModal}
                onOpenChange={updateStatus.setShowUpdateModal}
                checkingUpdates={updateStatus.checkingUpdates}
                updateStatuses={updateStatus.updateStatuses}
                updatingNodeId={updateStatus.updatingNodeId}
                isAdmin={isAdmin}
                fetchUpdateStatus={updateStatus.fetchUpdateStatus}
                triggerNodeUpdate={updateStatus.triggerNodeUpdate}
                retryNodeUpdate={updateStatus.retryNodeUpdate}
                dismissNodeUpdate={updateStatus.dismissNodeUpdate}
                triggerUpdateAll={updateStatus.triggerUpdateAll}
            />

            <LocalUpdateConfirmDialog
                open={updateStatus.localUpdateConfirm !== null}
                onOpenChange={(open) => { if (!open) updateStatus.setLocalUpdateConfirm(null); }}
                onConfirm={updateStatus.confirmLocalUpdate}
            />

            {NodeActionModals}
        </div>
    );
}

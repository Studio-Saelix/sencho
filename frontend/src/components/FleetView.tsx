import {
    RefreshCw, Search, Camera, Plus,
    Network, SlidersHorizontal,
    Send, KeyRound, ArrowLeftRight, Wrench,
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
import { useTopologyPreferences } from '@/hooks/useTopologyPreferences';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { springs } from '@/lib/motion';
import { useLicense } from '@/context/LicenseContext';
import { useAuth } from '@/context/AuthContext';
import { AdmiralGate } from './AdmiralGate';
import FleetSnapshots from './FleetSnapshots';
import { FleetConfiguration } from './fleet/FleetConfiguration';
import { RoutingTab } from './fleet/RoutingTab';
import { FederationTab } from './fleet/FederationTab';
import { DeploymentsTab } from './blueprints/DeploymentsTab';
import { FleetActionsTab } from './fleet/FleetActions/FleetActionsTab';
import { SecretsTab } from './fleet/secrets/SecretsTab';
import { useNodeActions } from './nodes/useNodeActions';
import { SettingsPrimaryButton } from './settings/SettingsActions';

interface FleetViewProps {
    onNavigateToNode: (nodeId: number, stackName: string) => void;
}

export function FleetView({ onNavigateToNode }: FleetViewProps) {
    const { isPaid, license } = useLicense();
    const { isAdmin } = useAuth();
    const isAdmiral = isPaid && license?.variant === 'admiral';

    const { prefs, updatePrefs } = useFleetPreferences();
    const updateStatus = useFleetUpdateStatus();
    const overview = useFleetOverview({ isPaid, prefs, updatePrefs, updateStatuses: updateStatus.updateStatuses });
    const topology = useTopologyPreferences();

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
                    <TabsList>
                        <TabsHighlight className="rounded-md bg-glass-highlight" transition={springs.snappy}>
                            <TabsHighlightItem value="overview">
                                <TabsTrigger value="overview">Overview</TabsTrigger>
                            </TabsHighlightItem>
                            <TabsHighlightItem value="snapshots">
                                <TabsTrigger value="snapshots">
                                    <Camera className="w-4 h-4 mr-1.5" />Snapshots
                                </TabsTrigger>
                            </TabsHighlightItem>
                            <TabsHighlightItem value="configuration">
                                <TabsTrigger value="configuration">
                                    <SlidersHorizontal className="w-4 h-4 mr-1.5" />Status
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
                            {isAdmiral && (
                                <TabsHighlightItem value="routing">
                                    <TabsTrigger value="routing">
                                        <ArrowLeftRight className="w-4 h-4 mr-1.5" />Routing
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                            {isAdmiral && (
                                <TabsHighlightItem value="federation">
                                    <TabsTrigger value="federation">
                                        <Network className="w-4 h-4 mr-1.5" />Federation
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                            <TabsHighlightItem value="actions">
                                <TabsTrigger value="actions">
                                    <Wrench className="w-4 h-4 mr-1.5" />Fleet Actions
                                </TabsTrigger>
                            </TabsHighlightItem>
                            {isPaid && (
                                <TabsHighlightItem value="secrets">
                                    <TabsTrigger value="secrets">
                                        <KeyRound className="w-4 h-4 mr-1.5" />Secrets
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            )}
                        </TabsHighlight>
                    </TabsList>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={updateStatus.checkUpdates}
                            className="gap-2"
                        >
                            <Search className="w-4 h-4" />
                            Check Updates
                        </Button>
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
                            <SettingsPrimaryButton
                                size="sm"
                                onClick={openCreate}
                                className="gap-1"
                            >
                                <Plus className="w-4 h-4" />
                                Add node
                            </SettingsPrimaryButton>
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
                        isPaid={isPaid}
                        topologyMode={topology.prefs.mode}
                        onTopologyModeChange={topology.setMode}
                        topologyPositions={topology.prefs.positions}
                        onTopologyPositionsChange={topology.setPositions}
                    />
                </TabsContent>

                <TabsContent value="snapshots">
                    <FleetSnapshots />
                </TabsContent>
                <TabsContent value="configuration">
                    <FleetConfiguration />
                </TabsContent>
                {isPaid && (
                    <TabsContent value="deployments">
                        <DeploymentsTab />
                    </TabsContent>
                )}
                {isAdmiral && (
                    <TabsContent value="routing">
                        <AdmiralGate>
                            <RoutingTab />
                        </AdmiralGate>
                    </TabsContent>
                )}
                {isAdmiral && (
                    <TabsContent value="federation">
                        <AdmiralGate>
                            <FederationTab />
                        </AdmiralGate>
                    </TabsContent>
                )}
                <TabsContent value="actions">
                    <FleetActionsTab nodes={overview.allNodes} />
                </TabsContent>
                {isPaid && (
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
                fetchUpdateStatus={updateStatus.fetchUpdateStatus}
                triggerNodeUpdate={updateStatus.triggerNodeUpdate}
                retryNodeUpdate={updateStatus.retryNodeUpdate}
                dismissNodeUpdate={updateStatus.dismissNodeUpdate}
                triggerUpdateAll={updateStatus.triggerUpdateAll}
                canBulkUpdate={isPaid}
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

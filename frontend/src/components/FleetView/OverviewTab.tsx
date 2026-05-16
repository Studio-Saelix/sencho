import { Server, Search, RotateCcw } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { FleetTopology } from '../fleet/FleetTopology';
import { NodeCard } from './NodeCard';
import { OverviewToolbar } from './OverviewToolbar';
import type { FleetTopologyNode, LayoutMode, SavedPositions } from '@/lib/fleet-topology-layout';
import type { Label as StackLabel } from '../label-types';
import type { Node } from '@/context/NodeContext';
import type { FleetNode, NodeUpdateStatus, ViewMode, FleetPreferences, FleetPaletteEntry } from './types';

interface OverviewTabProps {
    loading: boolean;
    nodes: FleetNode[];
    processedNodes: FleetNode[];
    allNodes: FleetNode[];
    topologyNodes: FleetTopologyNode[];
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    searchQuery: string;
    onSearchQueryChange: (q: string) => void;
    prefs: FleetPreferences;
    onPrefsChange: (update: Partial<FleetPreferences>) => void;
    fleetPalette: FleetPaletteEntry[];
    labelFilters: Set<string>;
    onLabelFiltersChange: (filters: Set<string>) => void;
    onClearFilters: () => void;
    fleetStackLabelMap: Record<number, Record<string, StackLabel[]>>;
    updateStatusMap: Map<number, NodeUpdateStatus>;
    onNavigateToNode: (nodeId: number, stackName: string) => void;
    onUpdate?: (nodeId: number) => void;
    updatingNodeId: number | null;
    onRetryUpdate?: (nodeId: number) => void;
    onDismissUpdate?: (nodeId: number) => void;
    onCordonChange?: () => void;
    onEditNode?: (node: Node) => void;
    onDeleteNode?: (node: Node) => void;
    isPaid: boolean;
    topologyMode: LayoutMode;
    onTopologyModeChange: (mode: LayoutMode) => void;
    topologyPositions: SavedPositions;
    onTopologyPositionsChange: (positions: SavedPositions) => void;
}

export function OverviewTab({
    loading,
    nodes,
    processedNodes,
    allNodes,
    topologyNodes,
    viewMode,
    onViewModeChange,
    searchQuery,
    onSearchQueryChange,
    prefs,
    onPrefsChange,
    fleetPalette,
    labelFilters,
    onLabelFiltersChange,
    onClearFilters,
    fleetStackLabelMap,
    updateStatusMap,
    onNavigateToNode,
    onUpdate,
    updatingNodeId,
    onRetryUpdate,
    onDismissUpdate,
    onCordonChange,
    onEditNode,
    onDeleteNode,
    isPaid,
    topologyMode,
    onTopologyModeChange,
    topologyPositions,
    onTopologyPositionsChange,
}: OverviewTabProps) {
    return (
        <>
            {loading && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
                            <Skeleton className="h-8 w-32" />
                            <div className="grid grid-cols-3 gap-2">
                                <Skeleton className="h-14 rounded-lg" />
                                <Skeleton className="h-14 rounded-lg" />
                                <Skeleton className="h-14 rounded-lg" />
                            </div>
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-3/4" />
                        </div>
                    ))}
                </div>
            )}

            {!loading && nodes.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                    <Server className="w-12 h-12 text-muted-foreground/50 mb-4" />
                    <h3 className="text-lg font-medium mb-1">No nodes configured</h3>
                    <p className="text-sm text-muted-foreground">Add a node to see your fleet here.</p>
                </div>
            )}

            {!loading && nodes.length > 0 && (
                <>
                    <OverviewToolbar
                        viewMode={viewMode}
                        onViewModeChange={onViewModeChange}
                        searchQuery={searchQuery}
                        onSearchQueryChange={onSearchQueryChange}
                        prefs={prefs}
                        onPrefsChange={onPrefsChange}
                        fleetPalette={fleetPalette}
                        labelFilters={labelFilters}
                        onLabelFiltersChange={onLabelFiltersChange}
                        onClearFilters={onClearFilters}
                    />

                    {viewMode === 'topology' && processedNodes.length > 0 ? (
                        <FleetTopology
                            nodes={topologyNodes}
                            onNodeClick={(id) => onNavigateToNode(id, '')}
                            isPaid={isPaid}
                            mode={topologyMode}
                            onModeChange={onTopologyModeChange}
                            savedPositions={topologyPositions}
                            onPositionsChange={onTopologyPositionsChange}
                        />
                    ) : processedNodes.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
                            {allNodes.map(node => (
                                <NodeCard
                                    key={node.id}
                                    node={node}
                                    onNavigate={onNavigateToNode}
                                    labelMap={fleetStackLabelMap[node.id] ?? {}}
                                    updateStatus={updateStatusMap.get(node.id)}
                                    onUpdate={onUpdate}
                                    updatingNodeId={updatingNodeId}
                                    onRetryUpdate={onRetryUpdate}
                                    onDismissUpdate={onDismissUpdate}
                                    onCordonChange={onCordonChange}
                                    onEdit={onEditNode}
                                    onDelete={onDeleteNode}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                            <Search className="w-10 h-10 text-muted-foreground/50 mb-3" />
                            <h3 className="text-sm font-medium mb-1">No nodes match your filters</h3>
                            <p className="text-xs text-muted-foreground">Try adjusting your search or filter criteria.</p>
                            <Button
                                variant="outline"
                                size="sm"
                                className="mt-3"
                                onClick={() => {
                                    onSearchQueryChange('');
                                    onClearFilters();
                                }}
                            >
                                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                                Clear filters
                            </Button>
                        </div>
                    )}

                    <p className="text-xs text-muted-foreground text-center mt-6">
                        Auto-refreshing every 30 seconds
                    </p>
                </>
            )}
        </>
    );
}

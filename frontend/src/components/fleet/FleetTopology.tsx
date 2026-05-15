import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    Handle,
    Position,
    type Node,
    type Edge,
    type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Server, Zap, Network, Layers, Move, Ban, Clock, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    layoutFleetGraph,
    type FleetNodeData,
    type FleetTopologyNode,
    type LayoutMode,
    type SavedPositions,
} from '@/lib/fleet-topology-layout';
import { NodeLabelPill } from '@/components/blueprints/NodeLabelPill';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface FleetTopologyProps {
    nodes: FleetTopologyNode[];
    onNodeClick?: (nodeId: number) => void;
    isPaid: boolean;
    mode: LayoutMode;
    onModeChange: (mode: LayoutMode) => void;
    savedPositions: SavedPositions;
    onPositionsChange: (positions: SavedPositions) => void;
}

// Raw oklch values for MiniMap coloring (ReactFlow cannot resolve CSS vars
// inside inline styles / SVG fills).
const MINIMAP_BRAND = 'oklch(0.78 0.11 195)';
const MINIMAP_WARNING = 'oklch(0.75 0.14 75)';
const MINIMAP_MUTED = 'oklch(0.55 0 0)';

const MAX_INLINE_LABELS = 3;
const PILOT_STALE_MS = 60_000;

function dotClass(node: FleetTopologyNode): string {
    if (node.status !== 'online') return 'bg-destructive';
    if (node.critical) return 'bg-warning';
    return 'bg-success';
}

function barColor(value: number): string {
    if (value >= 85) return 'bg-destructive';
    if (value >= 60) return 'bg-warning';
    return 'bg-brand';
}

function MetricBar({ label, value, muted }: { label: string; value: number; muted: boolean }) {
    const clamped = Math.max(0, Math.min(100, value));
    return (
        <div className="flex items-center gap-2">
            <span className="w-9 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                {label}
            </span>
            <div className="flex-1 h-1 rounded-full bg-muted/60 overflow-hidden">
                <div
                    className={cn('h-full rounded-full transition-[width] duration-300', muted ? 'bg-muted-foreground/40' : barColor(value))}
                    style={{ width: `${clamped}%` }}
                />
            </div>
            <span className="w-8 text-right font-mono text-[10px] tabular-nums text-stat-value">
                {Math.round(clamped)}%
            </span>
        </div>
    );
}

function formatRelative(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
}

function FleetNodeCard({ data, selected }: { data: FleetNodeData; selected?: boolean }) {
    const node = data.node;
    const isLocal = node.type === 'local';
    const isOffline = node.status !== 'online';
    const stackLabel = node.stackCount === 1 ? 'stack' : 'stacks';
    const labels = node.labels ?? [];
    const visibleLabels = labels.slice(0, MAX_INLINE_LABELS);
    const overflowLabels = labels.length - visibleLabels.length;
    const cordoned = Boolean(node.cordoned);
    const pilotStale = !isOffline
        && node.nodeMode === 'pilot_agent'
        && typeof node.pilotLastSeen === 'number'
        && Date.now() - node.pilotLastSeen > PILOT_STALE_MS;
    const showLatency = !isLocal && !isOffline && typeof node.latencyMs === 'number';

    return (
        <div
            className={cn(
                'w-[240px] rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors overflow-hidden',
                'hover:border-t-card-border-hover cursor-pointer',
                isLocal && 'ring-1 ring-brand/40',
                isOffline && 'opacity-70',
                selected && 'ring-1 ring-brand',
            )}
        >
            <Handle type="target" position={Position.Left} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />

            {cordoned && (
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="flex items-center gap-1.5 px-3 py-1 bg-warning/15 border-b border-warning/30">
                                <Ban className="h-3 w-3 text-warning" strokeWidth={2} />
                                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-warning">
                                    Cordoned
                                </span>
                            </div>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                            {node.cordonedReason || 'Cordoned: scheduling paused.'}
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            )}

            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-card-border">
                <span aria-hidden="true" className={cn('h-2 w-2 rounded-full shrink-0', dotClass(node))} />
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
                    {isOffline ? 'Offline' : node.critical ? 'Critical' : 'Online'}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                    {pilotStale && (
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Clock className="h-3 w-3 text-warning" strokeWidth={2} aria-label="Pilot heartbeat stale" />
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                    {node.pilotLastSeen
                                        ? `Pilot heartbeat ${formatRelative(node.pilotLastSeen)}`
                                        : 'Pilot heartbeat stale'}
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    )}
                    {node.critical && !isOffline ? (
                        <Zap className="h-3 w-3 text-warning" strokeWidth={2} aria-label="Critical" />
                    ) : null}
                    <span className={cn(
                        'font-mono text-[9px] uppercase tracking-[0.22em]',
                        isLocal ? 'text-brand' : 'text-muted-foreground',
                    )}>
                        {isLocal ? 'Local' : 'Remote'}
                    </span>
                </span>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-card-border">
                <Server className="h-3.5 w-3.5 text-stat-icon shrink-0" strokeWidth={1.5} />
                <span className="text-xs font-medium text-stat-value truncate">{node.name}</span>
            </div>

            {labels.length > 0 && (
                <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-card-border">
                    {visibleLabels.map(l => (
                        <NodeLabelPill key={l} label={l} size="sm" />
                    ))}
                    {overflowLabels > 0 && (
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="inline-flex items-center rounded-md border border-card-border bg-muted/40 px-1.5 py-0 font-mono text-[10px] text-muted-foreground">
                                        +{overflowLabels}
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                    {labels.slice(MAX_INLINE_LABELS).join(', ')}
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    )}
                </div>
            )}

            <div className="px-3 py-2 space-y-1 border-b border-card-border">
                <MetricBar label="CPU" value={node.cpuPercent} muted={isOffline} />
                <MetricBar label="MEM" value={node.memPercent} muted={isOffline} />
                <MetricBar label="DISK" value={node.diskPercent} muted={isOffline} />
            </div>

            <div className="flex items-center justify-between px-3 py-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                <span>{node.stackCount} {stackLabel} · {node.runningCount} running</span>
                {showLatency && (
                    <span className="inline-flex items-center gap-1">
                        <Activity className="h-2.5 w-2.5" strokeWidth={2} />
                        {Math.round(node.latencyMs!)}ms
                    </span>
                )}
            </div>

            <Handle type="source" position={Position.Right} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />
        </div>
    );
}

const nodeTypes: NodeTypes = {
    fleetNode: FleetNodeCard,
};

interface ModeButtonSpec {
    mode: LayoutMode;
    label: string;
    description: string;
    icon: typeof Network;
}

const MODE_BUTTONS: ModeButtonSpec[] = [
    { mode: 'hub', label: 'Hub', description: 'Local node at the centre, remotes radiating out.', icon: Network },
    { mode: 'grouped', label: 'Grouped', description: 'Cluster nodes by their primary label.', icon: Layers },
    { mode: 'free', label: 'Free', description: 'Drag nodes anywhere; positions persist in this browser.', icon: Move },
];

function TopologyToolbar({
    mode,
    onModeChange,
}: {
    mode: LayoutMode;
    onModeChange: (mode: LayoutMode) => void;
}) {
    return (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-card-border bg-card/60">
            <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground mr-1">
                Layout
            </span>
            {MODE_BUTTONS.map(spec => {
                const Icon = spec.icon;
                const active = mode === spec.mode;
                return (
                    <TooltipProvider key={spec.mode}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={() => onModeChange(spec.mode)}
                                    aria-pressed={active}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono uppercase tracking-[0.12em] transition-colors',
                                        active
                                            ? 'border-brand/60 bg-brand/15 text-brand'
                                            : 'border-card-border text-muted-foreground hover:text-foreground hover:bg-muted/40',
                                    )}
                                >
                                    <Icon className="h-3 w-3" strokeWidth={2} />
                                    {spec.label}
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                                {spec.description}
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                );
            })}
        </div>
    );
}

export function FleetTopology({
    nodes: fleetNodes,
    onNodeClick,
    isPaid,
    mode,
    onModeChange,
    savedPositions,
    onPositionsChange,
}: FleetTopologyProps) {
    const onNodeClickRef = useRef(onNodeClick);
    onNodeClickRef.current = onNodeClick;

    const onPositionsChangeRef = useRef(onPositionsChange);
    onPositionsChangeRef.current = onPositionsChange;

    const savedPositionsRef = useRef(savedPositions);
    savedPositionsRef.current = savedPositions;

    // Defensive: a Community user who somehow lands in a paid mode (older
    // localStorage value, manual edit) gets snapped back to Hub. The toolbar
    // also hides these modes for them, so this is a belt-and-suspenders guard.
    const effectiveMode: LayoutMode = useMemo(() => {
        if ((mode === 'grouped' || mode === 'free') && !isPaid) return 'hub';
        return mode;
    }, [mode, isPaid]);

    // Only re-layout when the topology *shape* changes (nodes added/removed,
    // type/status/label flips, mode flips). Metric value changes alone must
    // not snap user-dragged nodes back to dagre-computed positions on every
    // poll.
    const shapeKey = useMemo(
        () => effectiveMode + '|' + fleetNodes
            .map(n => `${n.id}:${n.type}:${n.status}:${(n.labels ?? []).slice().sort().join(',')}`)
            .sort()
            .join('|'),
        [fleetNodes, effectiveMode],
    );

    const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
    const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);

    useEffect(() => {
        const { nodes: nextNodes, edges: nextEdges } = layoutFleetGraph(fleetNodes, {
            mode: effectiveMode,
            savedPositions: savedPositionsRef.current,
        });
        setFlowNodes(nextNodes);
        setFlowEdges(nextEdges);
        // fleetNodes is referenced via shapeKey; savedPositions is read from
        // a ref so persisted drags don't trigger a relayout cycle.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shapeKey, setFlowNodes, setFlowEdges]);

    // Update live metrics on every poll without resetting positions.
    useEffect(() => {
        setFlowNodes(current => current.map(flowNode => {
            const next = fleetNodes.find(n => String(n.id) === flowNode.id);
            if (!next) return flowNode;
            const existingData = flowNode.data as FleetNodeData | undefined;
            const existing = existingData?.node;
            if (existing && existing.cpuPercent === next.cpuPercent
                && existing.memPercent === next.memPercent
                && existing.diskPercent === next.diskPercent
                && existing.stackCount === next.stackCount
                && existing.runningCount === next.runningCount
                && existing.critical === next.critical
                && existing.cordoned === next.cordoned
                && existing.cordonedReason === next.cordonedReason
                && existing.latencyMs === next.latencyMs
                && existing.pilotLastSeen === next.pilotLastSeen) {
                return flowNode;
            }
            return {
                ...flowNode,
                data: { node: next, clusterLabel: existingData?.clusterLabel } satisfies FleetNodeData,
            };
        }));
    }, [fleetNodes, setFlowNodes]);

    const handleNodeClick = useCallback((_event: React.MouseEvent, flowNode: Node) => {
        const id = Number(flowNode.id);
        if (!Number.isNaN(id)) {
            onNodeClickRef.current?.(id);
        }
    }, []);

    const handleNodeDragStop = useCallback((_event: React.MouseEvent, _node: Node, allDragged: Node[]) => {
        if (effectiveMode !== 'free') return;
        setFlowNodes(current => {
            const dragged = new Map(allDragged.map(n => [n.id, n.position]));
            const validIds = new Set(current.map(n => n.id));
            const merged: SavedPositions = {};
            for (const n of current) {
                const pos = dragged.get(n.id) ?? n.position;
                merged[n.id] = { x: pos.x, y: pos.y };
            }
            // Drop any stale saved entries for nodes no longer present.
            for (const key of Object.keys(savedPositionsRef.current)) {
                if (!validIds.has(key)) delete merged[key];
            }
            onPositionsChangeRef.current(merged);
            return current;
        });
    }, [effectiveMode, setFlowNodes]);

    const miniMapNodeColor = useCallback((n: Node) => {
        const data = n.data as FleetNodeData | undefined;
        const topo = data?.node;
        if (!topo || topo.status !== 'online') return MINIMAP_MUTED;
        if (topo.critical) return MINIMAP_WARNING;
        return MINIMAP_BRAND;
    }, []);

    if (fleetNodes.length === 0) {
        return (
            <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-10 text-center">
                <p className="text-sm text-muted-foreground">No nodes to plot.</p>
            </div>
        );
    }

    const allRemotesUnlabeled = effectiveMode === 'grouped'
        && fleetNodes.filter(n => n.type !== 'local').every(n => (n.labels ?? []).length === 0);

    return (
        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
            {isPaid && <TopologyToolbar mode={effectiveMode} onModeChange={onModeChange} />}
            {isPaid && allRemotesUnlabeled && (
                <div className="px-3 py-1.5 text-[11px] text-muted-foreground bg-muted/30 border-b border-card-border">
                    No node labels assigned. Add labels in Settings · Nodes to see remotes cluster.
                </div>
            )}
            <div className="h-[560px] w-full">
                <ReactFlow
                    nodes={flowNodes}
                    edges={flowEdges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={handleNodeClick}
                    onNodeDragStop={handleNodeDragStop}
                    nodeTypes={nodeTypes}
                    fitView
                    fitViewOptions={{ padding: 0.2 }}
                    proOptions={{ hideAttribution: true }}
                    nodesConnectable={false}
                    className="bg-background"
                >
                    <Background gap={20} size={1} className="opacity-30" />
                    <Controls
                        className="!bg-card !border-card-border !shadow-card-bevel [&>button]:!bg-card [&>button]:!border-card-border [&>button]:!text-foreground [&>button:hover]:!bg-muted"
                        showInteractive={false}
                    />
                    <MiniMap
                        className="!bg-card !border-card-border !shadow-card-bevel"
                        nodeColor={miniMapNodeColor}
                        maskColor="oklch(0 0 0 / 0.2)"
                        pannable
                        zoomable
                    />
                </ReactFlow>
            </div>
        </div>
    );
}

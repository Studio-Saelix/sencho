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
import { Server, Radio, RadioTower, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    buildTunnelsGraph,
    buildAliasesGraph,
    type MeshNodeData,
} from '@/lib/mesh-topology-layout';
import type { MeshAlias, MeshNodeStatus, MeshReachableMode } from '@/types/mesh';

const MINIMAP_BRAND = 'oklch(0.78 0.11 195)';
const MINIMAP_WARNING = 'oklch(0.75 0.14 75)';
const MINIMAP_MUTED = 'oklch(0.55 0 0)';
const MINIMAP_DESTRUCTIVE = 'oklch(0.65 0.2 28)';

export type MeshGraphEdgeMode = 'tunnels' | 'aliases';

interface MeshTopologyGraphProps {
    status: MeshNodeStatus[];
    aliases: MeshAlias[];
    edgeMode: MeshGraphEdgeMode;
    onNodeClick?: (nodeId: number) => void;
}

function statusDot(node: MeshNodeStatus): string {
    if (node.reachableMode === 'unreachable') return 'bg-destructive';
    if (node.reachableMode === 'pilot' && !node.pilotConnected) return 'bg-warning';
    if (!node.enabled) return 'bg-muted-foreground';
    return 'bg-success';
}

function reachableModeLabel(mode: MeshReachableMode): string {
    switch (mode) {
        case 'local': return 'local';
        case 'pilot': return 'pilot';
        case 'proxy': return 'proxy';
        case 'unreachable': return 'unreachable';
    }
}

function ModeIcon({ mode, connected }: { mode: MeshReachableMode; connected: boolean }) {
    if (mode === 'unreachable') return <AlertTriangle className="h-3 w-3 text-destructive" strokeWidth={1.75} />;
    if (mode === 'pilot' && !connected) return <Radio className="h-3 w-3 text-warning" strokeWidth={1.75} />;
    if (mode === 'pilot') return <RadioTower className="h-3 w-3 text-brand" strokeWidth={1.75} />;
    return null;
}

function MeshNodeCard({ data, selected }: { data: MeshNodeData; selected?: boolean }) {
    const node = data.node;
    const isLocal = node.reachableMode === 'local';
    const dimmed = node.reachableMode === 'unreachable';
    const optedInCount = node.optedInStacks.length;
    const stackLabel = optedInCount === 1 ? 'stack' : 'stacks';
    const streamLabel = node.activeStreamCount === 1 ? 'stream' : 'streams';

    return (
        <div
            className={cn(
                'w-[240px] rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors',
                'hover:border-t-card-border-hover cursor-pointer',
                isLocal && 'ring-1 ring-brand/40',
                dimmed && 'opacity-70',
                selected && 'ring-1 ring-brand',
            )}
        >
            <Handle type="target" position={Position.Left} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />

            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-card-border">
                <span aria-hidden="true" className={cn('h-2 w-2 rounded-full shrink-0', statusDot(node))} />
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
                    {node.enabled ? (dimmed ? 'unreachable' : 'meshed') : 'unmeshed'}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                    <ModeIcon mode={node.reachableMode} connected={node.pilotConnected} />
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
                <span className="text-xs font-medium text-stat-value truncate">{node.nodeName}</span>
            </div>

            <div className="px-3 py-1.5 border-b border-card-border space-y-0.5">
                <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
                    <span className="uppercase tracking-[0.18em] text-[9px]">mode</span>
                    <span className="text-stat-value">{reachableModeLabel(node.reachableMode)}</span>
                </div>
                <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
                    <span className="uppercase tracking-[0.18em] text-[9px]">opted in</span>
                    <span className="text-stat-value">{optedInCount} {stackLabel}</span>
                </div>
                {data.aliasCount > 0 && (
                    <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
                        <span className="uppercase tracking-[0.18em] text-[9px]">publishes</span>
                        <span className="text-stat-value">{data.aliasCount}</span>
                    </div>
                )}
            </div>

            <div className="px-3 py-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                {node.activeStreamCount} {streamLabel}
                {node.reachableMode === 'unreachable' && node.reachableReason ? (
                    <span className="ml-2 text-destructive truncate">· {node.reachableReason}</span>
                ) : null}
            </div>

            <Handle type="source" position={Position.Right} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />
        </div>
    );
}

const nodeTypes: NodeTypes = {
    meshNode: MeshNodeCard,
};

function nodeStateEqual(a: MeshNodeStatus, b: MeshNodeStatus): boolean {
    return a.nodeId === b.nodeId
        && a.enabled === b.enabled
        && a.reachableMode === b.reachableMode
        && a.pilotConnected === b.pilotConnected
        && a.reachableReason === b.reachableReason
        && a.activeStreamCount === b.activeStreamCount
        && a.optedInStacks.length === b.optedInStacks.length;
}

export function MeshTopologyGraph({ status, aliases, edgeMode, onNodeClick }: MeshTopologyGraphProps) {
    // Mirror FleetTopology's onNodeClick ref pattern: handlers may change on every
    // parent render, but ReactFlow's onNodeClick is stable, so route through a ref
    // to avoid recreating the callback (and thus rebuilding the flow) on every render.
    const onNodeClickRef = useRef(onNodeClick);
    onNodeClickRef.current = onNodeClick;

    // Shape key: relayout only when nodes are added/removed or reachability flips.
    const shapeKey = useMemo(
        () => status
            .map((n) => `${n.nodeId}:${n.reachableMode}:${n.enabled ? 1 : 0}:${n.pilotConnected ? 1 : 0}`)
            .sort()
            .join('|'),
        [status],
    );

    const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
    const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);

    useEffect(() => {
        const result = edgeMode === 'tunnels'
            ? buildTunnelsGraph(status)
            : buildAliasesGraph(status, aliases);
        setFlowNodes(result.nodes);
        setFlowEdges(result.edges);
        // Intentionally exclude `status` and `aliases` raw refs so we only relayout when
        // the shape (or selected edgeMode) changes; per-poll metric tweaks fall through
        // the live-update effect below without resetting user-dragged positions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shapeKey, edgeMode, setFlowNodes, setFlowEdges]);

    // Refresh node card data on prop change without touching positions. The /mesh/status
    // poll yields fresh JSON objects every cycle, so a reference equality check would
    // replace data on every poll and defeat the purpose. Compare by value instead.
    useEffect(() => {
        setFlowNodes((current) => current.map((flowNode) => {
            const next = status.find((n) => String(n.nodeId) === flowNode.id);
            if (!next) return flowNode;
            const existing = (flowNode.data as MeshNodeData | undefined);
            const aliasCount = edgeMode === 'aliases'
                ? aliases.filter((a) => a.nodeId === next.nodeId).length
                : 0;
            if (
                existing
                && existing.aliasCount === aliasCount
                && nodeStateEqual(existing.node, next)
            ) {
                return flowNode;
            }
            return { ...flowNode, data: { node: next, aliasCount, isOwnerView: false } satisfies MeshNodeData };
        }));
    }, [status, aliases, edgeMode, setFlowNodes]);

    const handleNodeClick = useCallback((_event: React.MouseEvent, flowNode: Node) => {
        const id = Number(flowNode.id);
        if (!Number.isNaN(id)) {
            onNodeClickRef.current?.(id);
        }
    }, []);

    const miniMapNodeColor = useCallback((n: Node) => {
        const data = n.data as MeshNodeData | undefined;
        const topo = data?.node;
        if (!topo) return MINIMAP_MUTED;
        if (topo.reachableMode === 'unreachable') return MINIMAP_DESTRUCTIVE;
        if (topo.reachableMode === 'pilot' && !topo.pilotConnected) return MINIMAP_WARNING;
        if (!topo.enabled) return MINIMAP_MUTED;
        return MINIMAP_BRAND;
    }, []);

    return (
        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
            <div className="h-[560px] w-full">
                <ReactFlow
                    nodes={flowNodes}
                    edges={flowEdges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={handleNodeClick}
                    nodeTypes={nodeTypes}
                    fitView
                    fitViewOptions={{ padding: 0.2, minZoom: 0.4 }}
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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    type Node,
    type Edge,
    type NodeTypes,
    Handle,
    Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { Container, Network, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
    DEFAULT_TOPOLOGY_FILTERS, filterTopologyNetworks, isMissingTopologyNetwork, normalizeTopologyResponse,
    TOPOLOGY_ANIMATION_EDGE_LIMIT, TOPOLOGY_RENDER_CAP, countTopologyGraphSize,
    type NetworkingTopologyFilters,
} from '@/lib/networkingTopology';
import type {
    NetworkingTopologyContainerDetail, NetworkingTopologyNetwork,
} from '@/types/networking';

// ── Types ─────────────────────────────────────────────────────────────────────

type TopologyNetwork = NetworkingTopologyNetwork;

interface ContainerAggregate {
    name: string;
    attachments: { network: string; ip: string }[];
    state: string;
    image: string;
    stack: string | null;
    service: string | null;
    composeAliases: string[];
    publishedPorts: NetworkingTopologyContainerDetail['publishedPorts'];
    exposureIntent: NetworkingTopologyContainerDetail['exposureIntent'];
    findingIds: string[];
    driftFlags: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stateColor(state: string): string {
    switch (state) {
        case 'running': return 'bg-success';
        case 'restarting':
        case 'paused':
        case 'created': return 'bg-warning';
        default: return 'bg-destructive';
    }
}

/** Aggregates containers across networks the same way for both the cheap
 *  pre-layout size counter and the real dagre layout, so the render cap is
 *  evaluated against the same node/edge counts the graph will actually use. */
function aggregateContainers(networksList: TopologyNetwork[]): Map<string, ContainerAggregate> {
    const containerMap = new Map<string, ContainerAggregate>();
    for (const net of networksList) {
        for (const c of net.containers) {
            if (!containerMap.has(c.id)) {
                containerMap.set(c.id, {
                    name: c.name, attachments: [],
                    state: c.state, image: c.image, stack: c.stack, service: c.service,
                    composeAliases: c.composeAliases, publishedPorts: c.publishedPorts,
                    exposureIntent: c.exposureIntent,
                    findingIds: c.findingIds, driftFlags: c.driftFlags,
                });
            }
            containerMap.get(c.id)!.attachments.push({ network: net.name, ip: c.ip });
        }
    }
    return containerMap;
}

// ── Custom Nodes ──────────────────────────────────────────────────────────────

interface ContainerNodeData extends ContainerAggregate {
    label: string;
    containerId: string;
    onStackClick?: (stack: string) => void;
}

function ContainerNodeComponent({ data }: { data: ContainerNodeData }) {
    return (
        <div
            className={cn(
                'rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel px-3 py-2 min-w-[160px]',
            )}
        >
            <Handle type="target" position={Position.Top} className="!bg-muted-foreground !w-2 !h-2" />
            <div className="flex items-center gap-2 mb-1">
                <span className={cn('w-2 h-2 rounded-full shrink-0', stateColor(data.state))} />
                <Container className="w-3.5 h-3.5 text-muted-foreground shrink-0" strokeWidth={1.5} />
                <span className="text-xs font-medium truncate max-w-[140px]">{data.label}</span>
            </div>
            {data.stack && (
                <Badge
                    variant="outline"
                    className="text-[9px] h-4 px-1 font-mono mb-1 cursor-pointer hover:bg-muted"
                    onClick={(event) => {
                        event.stopPropagation();
                        data.onStackClick?.(data.stack!);
                    }}
                >
                    {data.stack}
                </Badge>
            )}
            {data.attachments.length > 0 && (
                <div className="space-y-0.5">
                    {data.attachments.map(({ network, ip }) => (
                        <div key={network} className="flex items-center justify-between gap-2">
                            <span className="text-[10px] text-muted-foreground truncate max-w-[100px]">{network}</span>
                            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                {ip?.replace(/\/\d+$/, '') || ''}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            <span className="block font-mono text-[10px] text-muted-foreground/60 truncate max-w-[180px] mt-0.5">
                {data.image}
            </span>
            <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground !w-2 !h-2" />
        </div>
    );
}

function NetworkNodeComponent({ data }: { data: { label: string; driver: string; ownership: NetworkingTopologyNetwork['ownership']; missing: boolean; exposed: boolean; drift: boolean } }) {
    const statusColor = data.ownership === 'sencho-managed' ? 'text-success' : data.ownership === 'system' ? 'text-muted-foreground' : data.missing ? 'text-destructive' : 'text-warning';
    return (
        <div className={cn(
            'rounded-lg border-2 border-dashed px-4 py-2.5 min-w-[140px] text-center',
            data.missing ? 'border-destructive/40 bg-destructive/5 cursor-pointer' :
            data.ownership === 'sencho-managed' ? 'border-success/30 bg-success/5 cursor-pointer' :
                data.ownership === 'system' ? 'border-muted-foreground/20 bg-muted/20 cursor-pointer' :
                    'border-warning/30 bg-warning/5'
        )}>
            <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-0 !h-0" />
            <div className="flex items-center justify-center gap-1.5 mb-1">
                <Network className={cn('w-3.5 h-3.5', statusColor)} strokeWidth={1.5} />
                <span className="text-xs font-medium">{data.label}</span>
            </div>
            <Badge variant="outline" className="text-[9px] h-4">{data.driver}</Badge>
            {(data.exposed || data.drift || data.missing) && (
                <div className="mt-1 font-mono text-[9px] uppercase text-stat-subtitle">
                    {data.missing ? 'missing external' : data.drift ? 'drift' : 'exposed'}
                </div>
            )}
            <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none !w-0 !h-0" />
        </div>
    );
}

const nodeTypes: NodeTypes = {
    container: ContainerNodeComponent,
    network: NetworkNodeComponent,
};

// React Flow's inline style objects cannot resolve CSS custom properties,
// so raw oklch values are used here as a necessary escape hatch.
const BRAND_COLOR = 'oklch(0.78 0.11 195)';
const EDGE_COLORS = [
    BRAND_COLOR,
    'oklch(0.70 0.10 150)', // green
    'oklch(0.70 0.10 280)', // purple
    'oklch(0.70 0.10 30)',  // orange
    'oklch(0.70 0.10 220)', // blue
    'oklch(0.70 0.10 340)', // pink
];

const TOPOLOGY_LEGEND: { label: string; swatchClass: string }[] = [
    { label: 'Sencho-managed', swatchClass: 'bg-success/60 border-success' },
    { label: 'External / unmanaged', swatchClass: 'bg-warning/60 border-warning' },
    { label: 'System', swatchClass: 'bg-muted-foreground/40 border-muted-foreground' },
    { label: 'Missing external', swatchClass: 'bg-destructive/60 border-destructive' },
];

// ── Layout Helper (dagre) ────────────────────────────────────────────────────

function layoutGraph(
    networksList: TopologyNetwork[],
    onStackClick?: (stack: string) => void,
): { nodes: Node[]; edges: Edge[] } {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', ranksep: 120, nodesep: 60 });
    g.setDefaultEdgeLabel(() => ({}));

    const containerMap = aggregateContainers(networksList);

    for (const net of networksList) {
        g.setNode(`net-${net.id}`, { width: 160, height: 60 });
    }
    for (const [id] of containerMap) {
        g.setNode(`ctr-${id}`, { width: 200, height: 100 });
    }

    const seenEdges = new Set<string>();
    const edgeList: { netId: string; ctrId: string; color: string }[] = [];
    networksList.forEach((net, ni) => {
        const color = EDGE_COLORS[ni % EDGE_COLORS.length];
        for (const c of net.containers) {
                const edgeKey = `${net.id}-${c.id}`;
            if (!seenEdges.has(edgeKey)) {
                seenEdges.add(edgeKey);
                g.setEdge(`net-${net.id}`, `ctr-${c.id}`);
                edgeList.push({ netId: net.id, ctrId: c.id, color });
            }
        }
    });

    dagre.layout(g);

    const flowNodes: Node[] = [];
    for (const net of networksList) {
        const pos = g.node(`net-${net.id}`);
        flowNodes.push({
            id: `net-${net.id}`,
            type: 'network',
            position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
            data: {
                label: net.name, driver: net.driver, ownership: net.ownership,
                missing: isMissingTopologyNetwork(net),
                exposed: net.containers.some((container) => container.publishedPorts.length > 0),
                drift: net.findingIds.length > 0 || net.containers.some((container) => container.findingIds.length > 0 || container.driftFlags.length > 0),
                network: net,
            },
            draggable: true,
        });
    }
    for (const [id, ctr] of containerMap) {
        const pos = g.node(`ctr-${id}`);
        flowNodes.push({
            id: `ctr-${id}`,
            type: 'container',
            position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
            data: {
                label: ctr.name,
                containerId: id,
                attachments: ctr.attachments,
                state: ctr.state,
                image: ctr.image,
                stack: ctr.stack,
                service: ctr.service,
                composeAliases: ctr.composeAliases,
                publishedPorts: ctr.publishedPorts,
                exposureIntent: ctr.exposureIntent,
                findingIds: ctr.findingIds,
                driftFlags: ctr.driftFlags,
                onStackClick,
            },
            draggable: true,
        });
    }

    const animated = edgeList.length <= TOPOLOGY_ANIMATION_EDGE_LIMIT;
    const flowEdges: Edge[] = edgeList.map(({ netId, ctrId, color }) => ({
        id: `edge-${netId}-${ctrId}`,
        source: `net-${netId}`,
        target: `ctr-${ctrId}`,
        animated,
        style: { stroke: color, strokeWidth: 1.5 },
    }));

    return { nodes: flowNodes, edges: flowEdges };
}

// ── Main Component ────────────────────────────────────────────────────────────

interface NetworkTopologyViewProps {
    onContainerSelect?: (container: NetworkingTopologyContainerDetail) => void;
    onNetworkClick?: (network: NetworkingTopologyNetwork) => void;
    onStackClick?: (stack: string) => void;
    /** API path for topology data. Defaults to the Resources maintenance route. */
    endpoint?: string;
    /** When false, hides the include-system toggle (caller controls scope). */
    showSystemToggle?: boolean;
    /** Controlled include-system value when showSystemToggle is false. */
    includeSystem?: boolean;
    filters?: NetworkingTopologyFilters;
}

export default function NetworkTopologyView({
    onContainerSelect,
    onNetworkClick,
    onStackClick,
    endpoint = '/system/networks/topology',
    showSystemToggle = true,
    includeSystem: controlledIncludeSystem,
    filters,
}: NetworkTopologyViewProps) {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [loading, setLoading] = useState(true);
    const [internalIncludeSystem, setInternalIncludeSystem] = useState(false);
    const includeSystem = controlledIncludeSystem ?? internalIncludeSystem;
    const onContainerSelectRef = useRef(onContainerSelect);
    onContainerSelectRef.current = onContainerSelect;
    const onNetworkClickRef = useRef(onNetworkClick);
    onNetworkClickRef.current = onNetworkClick;
    const onStackClickRef = useRef(onStackClick);
    onStackClickRef.current = onStackClick;
    const [runtimeAvailable, setRuntimeAvailable] = useState(true);
    const [loadError, setLoadError] = useState(false);
    // Raw (unfiltered) networks from the last fetch; filters are applied
    // client-side so toggling them never triggers a new request (Workstream J).
    const [rawNetworks, setRawNetworks] = useState<TopologyNetwork[]>([]);
    const [overCap, setOverCap] = useState(false);

    const fetchTopology = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const res = await apiFetch(`${endpoint}?includeSystem=${includeSystem}`);
            if (!res.ok) throw new Error('Failed to fetch topology');
            const inspected: unknown = await res.json();
            const topology = normalizeTopologyResponse(inspected);
            setRuntimeAvailable(topology.runtimeAvailable);
            setRawNetworks(topology.networks);
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || err?.error || 'Something went wrong.'));
            setLoadError(true);
            setRawNetworks([]);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [includeSystem, endpoint]);

    useEffect(() => { fetchTopology(); }, [fetchTopology]);

    // Filters, the cheap size count, the cap check, and layout all run client-side
    // against the cached raw response (no refetch per filter/search keystroke).
    const networksList = useMemo(() => filterTopologyNetworks(
        rawNetworks.filter((network) => includeSystem || !network.isSystem),
        filters ?? DEFAULT_TOPOLOGY_FILTERS,
    ), [rawNetworks, includeSystem, filters]);

    useEffect(() => {
        const size = countTopologyGraphSize(networksList);
        if (size.nodeCount + size.edgeCount > TOPOLOGY_RENDER_CAP) {
            setOverCap(true);
            setNodes([]);
            setEdges([]);
            return;
        }
        setOverCap(false);
        const { nodes: layoutNodes, edges: layoutEdges } = layoutGraph(networksList, onStackClickRef.current);
        setNodes(layoutNodes);
        setEdges(layoutEdges);
    }, [networksList, setNodes, setEdges]);

    const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
        if (node.type === 'network') {
            onNetworkClickRef.current?.(node.data.network as NetworkingTopologyNetwork);
        }
        if (node.type === 'container') {
            onContainerSelectRef.current?.({
                id: node.data.containerId as string,
                name: node.data.label as string,
                attachments: node.data.attachments as { network: string; ip: string }[],
                state: node.data.state as string,
                image: node.data.image as string,
                stack: node.data.stack as string | null,
                service: node.data.service as string | null,
                composeAliases: node.data.composeAliases as string[],
                publishedPorts: node.data.publishedPorts as NetworkingTopologyContainerDetail['publishedPorts'],
                exposureIntent: node.data.exposureIntent as NetworkingTopologyContainerDetail['exposureIntent'],
                findingIds: node.data.findingIds as string[],
                driftFlags: node.data.driftFlags as string[],
            });
        }
        // Node click opens the drawer only; viewing logs is an explicit action
        // inside the container drawer (previously this also auto-opened logs,
        // which raced the drawer for the user's attention).
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-[400px] text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                <span className="text-sm">Loading network topology...</span>
            </div>
        );
    }

    if (overCap) {
        return (
            <div className="flex flex-col items-center justify-center h-[400px] text-muted-foreground gap-3">
                <Network className="w-8 h-8 opacity-40" strokeWidth={1.5} />
                <p className="text-sm">This graph is too large to render.</p>
                <p className="text-xs opacity-70">Narrow the filters to bring it under {TOPOLOGY_RENDER_CAP} nodes and edges, or use the Networks table instead.</p>
            </div>
        );
    }

    if (nodes.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-[400px] text-muted-foreground gap-3">
                <Network className="w-8 h-8 opacity-40" strokeWidth={1.5} />
                <p className="text-sm">
                    {loadError
                      ? 'Could not load topology for this node.'
                      : !runtimeAvailable
                        ? 'Docker runtime unavailable.'
                        : includeSystem
                          ? 'No networks found.'
                          : 'No user-created networks found.'}
                </p>
                <p className="text-xs opacity-70">
                    {!runtimeAvailable
                        ? 'Topology is unavailable until Docker responds on this node.'
                        : includeSystem
                        ? 'No Docker networks are available on this node.'
                        : 'Create a network or deploy stacks with custom networks to see the topology.'}
                </p>
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-card-border bg-card shadow-card-bevel overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-card-border">
                {showSystemToggle && (
                  <>
                    <TogglePill id="show-system" checked={includeSystem} onChange={setInternalIncludeSystem} />
                    <Label htmlFor="show-system" className="text-xs cursor-pointer">
                        Show system networks
                    </Label>
                  </>
                )}
                <div className="flex flex-wrap items-center gap-2">
                    {TOPOLOGY_LEGEND.map((entry) => (
                        <span key={entry.label} className="flex items-center gap-1 font-mono text-[10px] text-stat-subtitle">
                            <span className={cn('h-2 w-2 rounded-full border', entry.swatchClass)} />
                            {entry.label}
                        </span>
                    ))}
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => fetchTopology()}
                    disabled={loading}
                    aria-label="Refresh topology"
                >
                    <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} strokeWidth={1.5} />
                </Button>
            </div>
            <div className="h-[500px] w-full">
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={handleNodeClick}
                    nodeTypes={nodeTypes}
                    fitView
                    fitViewOptions={{ padding: 0.3 }}
                    proOptions={{ hideAttribution: true }}
                    className="bg-background"
                >
                    <Background gap={20} size={1} className="opacity-30" />
                    <Controls className="!bg-card !border-card-border !shadow-card-bevel [&>button]:!bg-card [&>button]:!border-card-border [&>button]:!text-foreground [&>button:hover]:!bg-muted" />
                    <MiniMap
                        className="!bg-card !border-card-border !shadow-card-bevel"
                        nodeColor={(node) => {
                            if (node.type === 'network') return BRAND_COLOR;
                            return 'oklch(0.50 0 0)';
                        }}
                        maskColor="oklch(0 0 0 / 0.2)"
                    />
                </ReactFlow>
            </div>
        </div>
    );
}

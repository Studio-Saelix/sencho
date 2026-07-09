import { useState, useEffect, useCallback, useRef } from 'react';
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface TopologyContainer {
    id: string;
    name: string;
    ip: string;
    state: string;
    image: string;
    stack: string | null;
}

interface TopologyNetwork {
    Id: string;
    Name: string;
    Driver: string;
    managedStatus: 'managed' | 'unmanaged' | 'system';
    containers: TopologyContainer[];
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

// ── Custom Nodes ──────────────────────────────────────────────────────────────

interface ContainerNodeData {
    label: string;
    containerId: string;
    networks: string[];
    ipAddresses: Record<string, string>;
    state: string;
    image: string;
    stack: string | null;
}

function ContainerNodeComponent({ data }: { data: ContainerNodeData }) {
    return (
        <div
            className={cn(
                'rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel px-3 py-2 min-w-[160px]',
                (!data.state || data.state === 'running') && 'cursor-pointer hover:border-t-card-border-hover',
            )}
        >
            <Handle type="target" position={Position.Top} className="!bg-muted-foreground !w-2 !h-2" />
            <div className="flex items-center gap-2 mb-1">
                <span className={cn('w-2 h-2 rounded-full shrink-0', stateColor(data.state))} />
                <Container className="w-3.5 h-3.5 text-muted-foreground shrink-0" strokeWidth={1.5} />
                <span className="text-xs font-medium truncate max-w-[140px]">{data.label}</span>
            </div>
            {data.stack && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 font-mono mb-1">{data.stack}</Badge>
            )}
            {data.networks.length > 0 && (
                <div className="space-y-0.5">
                    {data.networks.map(netName => (
                        <div key={netName} className="flex items-center justify-between gap-2">
                            <span className="text-[10px] text-muted-foreground truncate max-w-[100px]">{netName}</span>
                            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                {data.ipAddresses[netName]?.replace(/\/\d+$/, '') || ''}
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

function NetworkNodeComponent({ data }: { data: { label: string; driver: string; status: string } }) {
    const statusColor = data.status === 'managed' ? 'text-success' : data.status === 'system' ? 'text-muted-foreground' : 'text-warning';
    return (
        <div className={cn(
            'rounded-lg border-2 border-dashed px-4 py-2.5 min-w-[140px] text-center',
            data.status === 'managed' ? 'border-success/30 bg-success/5' :
                data.status === 'system' ? 'border-muted-foreground/20 bg-muted/20' :
                    'border-warning/30 bg-warning/5'
        )}>
            <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-0 !h-0" />
            <div className="flex items-center justify-center gap-1.5 mb-1">
                <Network className={cn('w-3.5 h-3.5', statusColor)} strokeWidth={1.5} />
                <span className="text-xs font-medium">{data.label}</span>
            </div>
            <Badge variant="outline" className="text-[9px] h-4">{data.driver}</Badge>
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

// ── Layout Helper (dagre) ────────────────────────────────────���───────────────

function layoutGraph(
    networksList: TopologyNetwork[],
): { nodes: Node[]; edges: Edge[] } {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', ranksep: 120, nodesep: 60 });
    g.setDefaultEdgeLabel(() => ({}));

    // Deduplicate containers across networks
    const containerMap = new Map<string, {
        name: string;
        networks: string[];
        ipAddresses: Record<string, string>;
        state: string;
        image: string;
        stack: string | null;
    }>();
    for (const net of networksList) {
        for (const c of net.containers) {
            if (!containerMap.has(c.id)) {
                containerMap.set(c.id, {
                    name: c.name, networks: [], ipAddresses: {},
                    state: c.state, image: c.image, stack: c.stack,
                });
            }
            const entry = containerMap.get(c.id)!;
            entry.networks.push(net.Name);
            entry.ipAddresses[net.Name] = c.ip;
        }
    }

    // Add nodes to dagre graph
    for (const net of networksList) {
        g.setNode(`net-${net.Id}`, { width: 160, height: 60 });
    }
    for (const [id] of containerMap) {
        g.setNode(`ctr-${id}`, { width: 200, height: 100 });
    }

    // Add edges and collect for React Flow
    const seenEdges = new Set<string>();
    const edgeList: { netId: string; ctrId: string; color: string }[] = [];
    networksList.forEach((net, ni) => {
        const color = EDGE_COLORS[ni % EDGE_COLORS.length];
        for (const c of net.containers) {
            const edgeKey = `${net.Id}-${c.id}`;
            if (!seenEdges.has(edgeKey)) {
                seenEdges.add(edgeKey);
                g.setEdge(`net-${net.Id}`, `ctr-${c.id}`);
                edgeList.push({ netId: net.Id, ctrId: c.id, color });
            }
        }
    });

    dagre.layout(g);

    // Convert dagre positions (center-based) to React Flow positions (top-left)
    const flowNodes: Node[] = [];
    for (const net of networksList) {
        const pos = g.node(`net-${net.Id}`);
        flowNodes.push({
            id: `net-${net.Id}`,
            type: 'network',
            position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
            data: { label: net.Name, driver: net.Driver, status: net.managedStatus },
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
                networks: ctr.networks,
                ipAddresses: ctr.ipAddresses,
                state: ctr.state,
                image: ctr.image,
                stack: ctr.stack,
            },
            draggable: true,
        });
    }

    const flowEdges: Edge[] = edgeList.map(({ netId, ctrId, color }) => ({
        id: `edge-${netId}-${ctrId}`,
        source: `net-${netId}`,
        target: `ctr-${ctrId}`,
        animated: true,
        style: { stroke: color, strokeWidth: 1.5 },
    }));

    return { nodes: flowNodes, edges: flowEdges };
}

// ── Main Component ────────────────────────────────────────────────────────────

interface NetworkTopologyViewProps {
    onContainerClick?: (containerId: string, containerName: string) => void;
    /** API path for topology data. Defaults to the Resources maintenance route. */
    endpoint?: string;
    /** When false, hides the include-system toggle (caller controls scope). */
    showSystemToggle?: boolean;
    /** Controlled include-system value when showSystemToggle is false. */
    includeSystem?: boolean;
}

export default function NetworkTopologyView({
    onContainerClick,
    endpoint = '/system/networks/topology',
    showSystemToggle = true,
    includeSystem: controlledIncludeSystem,
}: NetworkTopologyViewProps) {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [loading, setLoading] = useState(true);
    const [internalIncludeSystem, setInternalIncludeSystem] = useState(false);
    const includeSystem = controlledIncludeSystem ?? internalIncludeSystem;
    const onContainerClickRef = useRef(onContainerClick);
    onContainerClickRef.current = onContainerClick;

    const fetchTopology = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiFetch(`${endpoint}?includeSystem=${includeSystem}`);
            if (!res.ok) throw new Error('Failed to fetch topology');
            const inspected = await res.json();
            const networksList: TopologyNetwork[] = Array.isArray(inspected)
              ? inspected
              : (inspected.networks ?? []).map((n: {
                  id: string; name: string; driver: string; isSystem: boolean; stack: string | null;
                  containers: TopologyContainer[];
                }) => ({
                  Id: n.id,
                  Name: n.name,
                  Driver: n.driver,
                  managedStatus: n.isSystem ? 'system' as const : (n.stack ? 'managed' as const : 'unmanaged' as const),
                  containers: n.containers,
                }));
            const { nodes: layoutNodes, edges: layoutEdges } = layoutGraph(networksList);
            setNodes(layoutNodes);
            setEdges(layoutEdges);
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || err?.error || 'Something went wrong.'));
        } finally {
            setLoading(false);
        }
    }, [setNodes, setEdges, includeSystem, endpoint]);

    useEffect(() => { fetchTopology(); }, [fetchTopology]);

    const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
        if (node.type === 'container' && (!node.data.state || node.data.state === 'running')) {
            onContainerClickRef.current?.(node.data.containerId as string, node.data.label as string);
        }
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-[400px] text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                <span className="text-sm">Loading network topology...</span>
            </div>
        );
    }

    if (nodes.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-[400px] text-muted-foreground gap-3">
                <Network className="w-8 h-8 opacity-40" strokeWidth={1.5} />
                <p className="text-sm">
                    {includeSystem ? 'No networks found.' : 'No user-created networks found.'}
                </p>
                <p className="text-xs opacity-70">
                    {includeSystem
                        ? 'No Docker networks are available on this node.'
                        : 'Create a network or deploy stacks with custom networks to see the topology.'}
                </p>
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-card-border bg-card shadow-card-bevel overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-card-border">
                {showSystemToggle && (
                  <>
                    <TogglePill id="show-system" checked={includeSystem} onChange={setInternalIncludeSystem} />
                    <Label htmlFor="show-system" className="text-xs cursor-pointer">
                        Show system networks
                    </Label>
                  </>
                )}
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

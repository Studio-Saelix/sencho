import { useEffect, useMemo } from 'react';
import {
    ReactFlow,
    Background,
    Handle,
    Position,
    useNodesState,
    useEdgesState,
    type Node,
    type Edge,
    type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Boxes, Globe, Server, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SystemSheet } from '@/components/ui/system-sheet';
import { buildStackTopologyGraph } from '@/lib/mesh-topology-layout';
import type { MeshAlias, MeshNodeStatus } from '@/types/mesh';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    nodeId: number | null;
    nodeName: string | null;
    stackName: string | null;
    status: MeshNodeStatus[];
    aliases: MeshAlias[];
}

interface StackCenterData extends Record<string, unknown> {
    stackName: string;
    nodeId: number;
}
interface StackAliasData extends Record<string, unknown> {
    host: string;
    port: number;
    service: string;
}
interface StackConsumerData extends Record<string, unknown> {
    node: MeshNodeStatus;
}

function consumerDot(node: MeshNodeStatus): string {
    if (node.reachableMode === 'unreachable') return 'bg-destructive';
    if (node.reachableMode === 'pilot' && !node.pilotConnected) return 'bg-warning';
    return 'bg-success';
}

function consumerStateLabel(node: MeshNodeStatus): string {
    if (node.reachableMode === 'unreachable') return 'unreachable';
    if (node.reachableMode === 'pilot' && !node.pilotConnected) return 'pilot · idle';
    if (node.reachableMode === 'pilot') return 'pilot · ok';
    if (node.reachableMode === 'proxy') return 'proxy';
    return node.reachableMode;
}

function StackCenterCard({ data }: { data: StackCenterData }) {
    return (
        <div className="w-[180px] rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel ring-1 ring-brand/40">
            <Handle type="source" position={Position.Right} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-card-border">
                <Boxes className="h-3.5 w-3.5 text-brand shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-brand">stack</span>
            </div>
            <div className="px-3 py-2">
                <div className="text-xs font-medium text-stat-value truncate">{data.stackName}</div>
            </div>
        </div>
    );
}

function StackAliasCard({ data }: { data: StackAliasData }) {
    return (
        <div className="w-[200px] rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
            <Handle type="target" position={Position.Left} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />
            <Handle type="source" position={Position.Right} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-card-border">
                <Globe className="h-3.5 w-3.5 text-stat-icon shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">alias</span>
            </div>
            <div className="px-3 py-2 space-y-1">
                <div className="text-xs font-mono text-stat-value truncate">{data.host}</div>
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {data.service} · :{data.port}
                </div>
            </div>
        </div>
    );
}

function StackConsumerCard({ data }: { data: StackConsumerData }) {
    const node = data.node;
    const dimmed = node.reachableMode === 'unreachable';
    return (
        <div className={cn(
            'w-[200px] rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel',
            dimmed && 'opacity-70',
        )}>
            <Handle type="target" position={Position.Left} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-card-border">
                <span aria-hidden="true" className={cn('h-2 w-2 rounded-full shrink-0', consumerDot(node))} />
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">consumer</span>
                {dimmed && <AlertTriangle className="h-3 w-3 text-destructive ml-auto" strokeWidth={1.75} />}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-card-border">
                <Server className="h-3.5 w-3.5 text-stat-icon shrink-0" strokeWidth={1.5} />
                <span className="text-xs font-medium text-stat-value truncate">{node.nodeName}</span>
            </div>
            <div className="px-3 py-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                {consumerStateLabel(node)}
            </div>
        </div>
    );
}

const nodeTypes: NodeTypes = {
    stackCenter: StackCenterCard,
    stackAlias: StackAliasCard,
    stackConsumer: StackConsumerCard,
};

export function MeshStackTopologySheet({
    open,
    onOpenChange,
    nodeId,
    nodeName,
    stackName,
    status,
    aliases,
}: Props) {
    const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
    const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);

    // Shape-key: only relayout when the structural identity of the graph changes
    // (different stack selected, an alias appears/disappears, a consumer node goes
    // in/out of mesh, or a consumer's tunnel state flips). Scalar field changes on
    // the same nodes fall through and do not reset user-dragged positions.
    const shapeKey = useMemo(() => {
        if (nodeId === null || stackName === null) return 'empty';
        const aliasKey = aliases
            .filter((a) => a.nodeId === nodeId && a.stackName === stackName)
            .map((a) => a.host)
            .sort()
            .join(',');
        const consumerKey = status
            .filter((s) => s.enabled && s.nodeId !== nodeId)
            .map((s) => `${s.nodeId}:${s.reachableMode}:${s.pilotConnected ? 1 : 0}`)
            .sort()
            .join('|');
        return `${nodeId}/${stackName}/${aliasKey}/${consumerKey}`;
    }, [nodeId, stackName, status, aliases]);

    useEffect(() => {
        if (nodeId === null || stackName === null) {
            setFlowNodes([]);
            setFlowEdges([]);
            return;
        }
        const next = buildStackTopologyGraph({ nodeId, stackName, status, aliases });
        setFlowNodes(next.nodes);
        setFlowEdges(next.edges);
        // Intentionally exclude status/aliases raw refs: relayout only on shapeKey changes,
        // so polls that don't change reachability don't snap user-dragged nodes back.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shapeKey, setFlowNodes, setFlowEdges]);

    const stackAliasCount = useMemo(() => {
        if (nodeId === null || stackName === null) return 0;
        return aliases.filter((a) => a.nodeId === nodeId && a.stackName === stackName).length;
    }, [nodeId, stackName, aliases]);

    const consumerCount = useMemo(() => {
        if (nodeId === null) return 0;
        return status.filter((s) => s.enabled && s.nodeId !== nodeId).length;
    }, [nodeId, status]);

    const meta = `${stackAliasCount} ${stackAliasCount === 1 ? 'alias' : 'aliases'} · ${consumerCount} ${consumerCount === 1 ? 'consumer' : 'consumers'}`;
    const crumbName = stackName ?? '';
    const ownerName = nodeName ?? '';

    return (
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Fleet', 'Mesh', ownerName, 'topology']}
            name={crumbName}
            meta={meta}
            size="lg"
        >
            <div className="space-y-3">
                <p className="text-sm text-stat-subtitle leading-snug">
                    Aliases this stack publishes and the meshed nodes that can reach them. Edge styling
                    reflects each consumer's tunnel state.
                </p>
                <p className="text-xs text-stat-subtitle leading-snug">
                    Consumer nodes are meshed peers that could reach this stack's aliases via DNS.
                    Whether a container on a consumer actually dials an alias depends on that consumer's
                    own opt-in stacks.
                </p>

                {stackAliasCount === 0 ? (
                    <div className="rounded border border-dashed border-card-border bg-card/50 p-8 text-center">
                        <Boxes className="w-10 h-10 text-stat-subtitle mx-auto mb-3" strokeWidth={1.5} />
                        <div className="text-sm font-display italic mb-1">No published mesh services</div>
                        <div className="text-xs text-stat-subtitle">
                            This stack is in the mesh but exposes no service ports for other meshed stacks to reach.
                        </div>
                    </div>
                ) : (
                    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
                        <div className="h-[420px] w-full">
                            <ReactFlow
                                nodes={flowNodes}
                                edges={flowEdges}
                                onNodesChange={onNodesChange}
                                onEdgesChange={onEdgesChange}
                                nodeTypes={nodeTypes}
                                fitView
                                fitViewOptions={{ padding: 0.2, minZoom: 0.4 }}
                                proOptions={{ hideAttribution: true }}
                                nodesConnectable={false}
                                className="bg-background"
                            >
                                <Background gap={20} size={1} className="opacity-30" />
                            </ReactFlow>
                        </div>
                    </div>
                )}
            </div>
        </SystemSheet>
    );
}

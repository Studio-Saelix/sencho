import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { MeshAlias, MeshNodeStatus } from '@/types/mesh';

export interface MeshNodeData extends Record<string, unknown> {
    node: MeshNodeStatus;
    aliasCount: number;
    isOwnerView: boolean;
}

export interface MeshEdgeData extends Record<string, unknown> {
    kind: 'tunnels' | 'aliases';
    aliasCount: number;
    remoteNodeId: number;
}

const NODE_WIDTH = 240;
const NODE_HEIGHT = 150;

const EDGE_BRAND = 'oklch(0.78 0.11 195)';
const EDGE_WARNING = 'oklch(0.75 0.14 75)';
const EDGE_MUTED = 'oklch(0.55 0 0)';
const EDGE_DESTRUCTIVE = 'oklch(0.65 0.2 28)';

type EdgeVisual = {
    stroke: string;
    strokeWidth: number;
    strokeDasharray?: string;
};

function tunnelEdgeStyle(remote: MeshNodeStatus): EdgeVisual {
    if (remote.reachableMode === 'unreachable') {
        return { stroke: EDGE_DESTRUCTIVE, strokeWidth: 1, strokeDasharray: '4 4' };
    }
    if (remote.reachableMode === 'pilot' && !remote.pilotConnected) {
        return { stroke: EDGE_MUTED, strokeWidth: 1, strokeDasharray: '4 4' };
    }
    if (!remote.enabled) {
        return { stroke: EDGE_MUTED, strokeWidth: 1, strokeDasharray: '4 4' };
    }
    return { stroke: EDGE_BRAND, strokeWidth: 1.5 };
}

function tunnelEdgeLabel(remote: MeshNodeStatus): string {
    if (remote.reachableMode === 'unreachable') return 'unreachable';
    if (remote.reachableMode === 'pilot') {
        return remote.pilotConnected ? 'pilot · ok' : 'pilot · idle';
    }
    if (remote.reachableMode === 'proxy') return 'proxy';
    return '';
}

function aliasesEdgeStyle(remote: MeshNodeStatus, aliasCount: number): EdgeVisual {
    if (aliasCount === 0) {
        return { stroke: EDGE_MUTED, strokeWidth: 1, strokeDasharray: '4 4' };
    }
    if (remote.reachableMode === 'unreachable' || (remote.reachableMode === 'pilot' && !remote.pilotConnected)) {
        return { stroke: EDGE_WARNING, strokeWidth: 1.5, strokeDasharray: '4 4' };
    }
    return { stroke: EDGE_BRAND, strokeWidth: 1.5 };
}

interface GraphLayoutResult {
    nodes: Node[];
    edges: Edge[];
}

function emptyResult(): GraphLayoutResult {
    return { nodes: [], edges: [] };
}

function layoutNodesLR(meshNodes: MeshNodeStatus[]): Map<number, { x: number; y: number }> {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', ranksep: 160, nodesep: 32, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const n of meshNodes) {
        g.setNode(String(n.nodeId), { width: NODE_WIDTH, height: NODE_HEIGHT });
    }

    const local = meshNodes.find((n) => n.reachableMode === 'local') ?? null;
    if (local) {
        for (const r of meshNodes) {
            if (r.nodeId === local.nodeId) continue;
            g.setEdge(String(local.nodeId), String(r.nodeId));
        }
    }

    dagre.layout(g);

    const positions = new Map<number, { x: number; y: number }>();
    for (const n of meshNodes) {
        const pos = g.node(String(n.nodeId));
        positions.set(n.nodeId, { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 });
    }
    return positions;
}

function makeNode(
    node: MeshNodeStatus,
    aliasCount: number,
    position: { x: number; y: number },
): Node {
    return {
        id: String(node.nodeId),
        type: 'meshNode',
        position,
        data: { node, aliasCount, isOwnerView: false } satisfies MeshNodeData,
        draggable: true,
    };
}

export function buildTunnelsGraph(status: MeshNodeStatus[]): GraphLayoutResult {
    if (status.length === 0) return emptyResult();

    const positions = layoutNodesLR(status);
    const local = status.find((n) => n.reachableMode === 'local') ?? null;

    const flowNodes: Node[] = status.map((n) => {
        const pos = positions.get(n.nodeId) ?? { x: 0, y: 0 };
        return makeNode(n, 0, pos);
    });

    if (!local) return { nodes: flowNodes, edges: [] };

    const flowEdges: Edge[] = status
        .filter((n) => n.nodeId !== local.nodeId)
        .map((remote) => {
            const style = tunnelEdgeStyle(remote);
            const label = tunnelEdgeLabel(remote);
            return {
                id: `tunnel-${local.nodeId}-${remote.nodeId}`,
                source: String(local.nodeId),
                target: String(remote.nodeId),
                label,
                style,
                labelStyle: { fill: 'oklch(0.85 0 0)', fontSize: 10 },
                labelBgStyle: { fill: 'oklch(0.18 0 0)', fillOpacity: 0.9 },
                labelBgPadding: [4, 2] as [number, number],
                data: {
                    kind: 'tunnels',
                    aliasCount: 0,
                    remoteNodeId: remote.nodeId,
                } satisfies MeshEdgeData,
                animated: false,
            };
        });

    return { nodes: flowNodes, edges: flowEdges };
}

export function buildAliasesGraph(
    status: MeshNodeStatus[],
    aliases: MeshAlias[],
): GraphLayoutResult {
    if (status.length === 0) return emptyResult();

    const positions = layoutNodesLR(status);
    const local = status.find((n) => n.reachableMode === 'local') ?? null;

    const aliasCountByOwner = new Map<number, number>();
    for (const a of aliases) {
        aliasCountByOwner.set(a.nodeId, (aliasCountByOwner.get(a.nodeId) ?? 0) + 1);
    }

    const flowNodes: Node[] = status.map((n) => {
        const pos = positions.get(n.nodeId) ?? { x: 0, y: 0 };
        return makeNode(n, aliasCountByOwner.get(n.nodeId) ?? 0, pos);
    });

    if (!local) return { nodes: flowNodes, edges: [] };

    const flowEdges: Edge[] = status
        .filter((n) => n.nodeId !== local.nodeId)
        .map((remote) => {
            const remoteOwns = aliasCountByOwner.get(remote.nodeId) ?? 0;
            const style = aliasesEdgeStyle(remote, remoteOwns);
            const label = remoteOwns === 0
                ? 'no aliases'
                : `${remoteOwns} ${remoteOwns === 1 ? 'alias' : 'aliases'}`;
            return {
                id: `aliases-${local.nodeId}-${remote.nodeId}`,
                source: String(local.nodeId),
                target: String(remote.nodeId),
                label,
                style,
                labelStyle: { fill: 'oklch(0.85 0 0)', fontSize: 10 },
                labelBgStyle: { fill: 'oklch(0.18 0 0)', fillOpacity: 0.9 },
                labelBgPadding: [4, 2] as [number, number],
                data: {
                    kind: 'aliases',
                    aliasCount: remoteOwns,
                    remoteNodeId: remote.nodeId,
                } satisfies MeshEdgeData,
                animated: false,
            };
        });

    return { nodes: flowNodes, edges: flowEdges };
}

export interface StackTopologyInput {
    nodeId: number;
    stackName: string;
    status: MeshNodeStatus[];
    aliases: MeshAlias[];
}

export interface StackTopologyVertex {
    stack: { id: string; name: string };
    aliases: Array<{ id: string; host: string; port: number; service: string }>;
    consumers: Array<{ id: string; node: MeshNodeStatus }>;
}

// Per-stack sheet uses a fixed three-column layout (stack centre, alias column,
// consumer column) instead of Dagre because the graph is always small and a
// deterministic layout reads better than auto-routed edges for ~10 vertices.
const STACK_CENTER_X = 0;
const STACK_CENTER_Y = 0;
const STACK_ALIAS_X = 220;
const STACK_CONSUMER_X = 460;
const STACK_VERTICAL_GAP = 80;

function stackVertexLayout(
    aliasCount: number,
    consumerCount: number,
): { center: { x: number; y: number }; aliasPositions: Array<{ x: number; y: number }>; consumerPositions: Array<{ x: number; y: number }> } {
    const aliasStartY = -((aliasCount - 1) * STACK_VERTICAL_GAP) / 2;
    const consumerStartY = -((consumerCount - 1) * STACK_VERTICAL_GAP) / 2;

    return {
        center: { x: STACK_CENTER_X, y: STACK_CENTER_Y },
        aliasPositions: Array.from({ length: aliasCount }, (_, i) => ({
            x: STACK_ALIAS_X,
            y: aliasStartY + i * STACK_VERTICAL_GAP,
        })),
        consumerPositions: Array.from({ length: consumerCount }, (_, i) => ({
            x: STACK_CONSUMER_X,
            y: consumerStartY + i * STACK_VERTICAL_GAP,
        })),
    };
}

export function buildStackTopologyGraph(input: StackTopologyInput): GraphLayoutResult {
    const { nodeId, stackName, status, aliases } = input;

    const stackAliases = aliases.filter((a) => a.nodeId === nodeId && a.stackName === stackName);
    const consumers = status.filter((s) => s.enabled && s.nodeId !== nodeId);

    if (stackAliases.length === 0 && consumers.length === 0) {
        return emptyResult();
    }

    const layout = stackVertexLayout(stackAliases.length, consumers.length);
    const stackVertexId = `stack-${nodeId}-${stackName}`;

    const flowNodes: Node[] = [];

    flowNodes.push({
        id: stackVertexId,
        type: 'stackCenter',
        position: layout.center,
        data: { stackName, nodeId },
        draggable: true,
    });

    const aliasVertexId = (host: string) => `alias-${nodeId}-${stackName}-${host}`;
    const consumerVertexId = (id: number) => `consumer-${nodeId}-${stackName}-${id}`;

    stackAliases.forEach((alias, i) => {
        flowNodes.push({
            id: aliasVertexId(alias.host),
            type: 'stackAlias',
            position: layout.aliasPositions[i] ?? { x: 0, y: 0 },
            data: {
                host: alias.host,
                port: alias.port,
                service: alias.serviceName,
            },
            draggable: true,
        });
    });

    consumers.forEach((node, i) => {
        flowNodes.push({
            id: consumerVertexId(node.nodeId),
            type: 'stackConsumer',
            position: layout.consumerPositions[i] ?? { x: 0, y: 0 },
            data: { node },
            draggable: true,
        });
    });

    const flowEdges: Edge[] = [];

    for (const alias of stackAliases) {
        flowEdges.push({
            id: `e-stack-${aliasVertexId(alias.host)}`,
            source: stackVertexId,
            target: aliasVertexId(alias.host),
            style: { stroke: EDGE_BRAND, strokeWidth: 1.5 },
            animated: false,
        });
        for (const node of consumers) {
            const style = aliasesEdgeStyle(node, 1);
            flowEdges.push({
                id: `e-${aliasVertexId(alias.host)}-to-${node.nodeId}`,
                source: aliasVertexId(alias.host),
                target: consumerVertexId(node.nodeId),
                style,
                animated: false,
            });
        }
    }

    return { nodes: flowNodes, edges: flowEdges };
}

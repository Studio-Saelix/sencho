import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export interface FleetTopologyNode {
    id: number;
    name: string;
    type: 'local' | 'remote';
    status: 'online' | 'offline' | 'unknown';
    cpuPercent: number;
    memPercent: number;
    diskPercent: number;
    stackCount: number;
    runningCount: number;
    critical: boolean;
    labels?: string[];
    cordoned?: boolean;
    cordonedReason?: string | null;
    latencyMs?: number | null;
    pilotLastSeen?: number | null;
    nodeMode?: string | null;
}

export interface FleetNodeData extends Record<string, unknown> {
    node: FleetTopologyNode;
    clusterLabel?: string;
}

export type LayoutMode = 'hub' | 'grouped' | 'free';

export type SavedPositions = Record<string, { x: number; y: number }>;

export const LOCAL_CLUSTER_ID = '__local__';
export const UNLABELED_CLUSTER_ID = '__unlabeled__';

const NODE_WIDTH = 240;
const NODE_HEIGHT = 175;

// ReactFlow inline styles cannot resolve CSS custom properties, so raw oklch
// values are used. Values match the design tokens in frontend/src/index.css.
const EDGE_BRAND = 'oklch(0.78 0.11 195)';
const EDGE_WARNING = 'oklch(0.75 0.14 75)';
const EDGE_MUTED = 'oklch(0.55 0 0)';

function edgeStyle(remote: FleetTopologyNode): {
    stroke: string;
    strokeWidth: number;
    strokeDasharray?: string;
} {
    if (remote.status !== 'online') {
        return { stroke: EDGE_MUTED, strokeWidth: 1, strokeDasharray: '4 4' };
    }
    if (remote.critical) {
        return { stroke: EDGE_WARNING, strokeWidth: 1.5 };
    }
    return { stroke: EDGE_BRAND, strokeWidth: 1.5 };
}

// Multiple labels: alphabetically-first wins, giving a deterministic primary.
function clusterForRemote(remote: FleetTopologyNode): string {
    const labels = remote.labels ?? [];
    if (labels.length === 0) return UNLABELED_CLUSTER_ID;
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    return sorted[0];
}

function buildHubLayout(fleetNodes: FleetTopologyNode[]): Map<string, { x: number; y: number }> {
    const local = fleetNodes.find(n => n.type === 'local') ?? null;
    const remotes = fleetNodes.filter(n => n.type !== 'local');

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', ranksep: 160, nodesep: 32, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const n of fleetNodes) {
        g.setNode(String(n.id), { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    if (local) {
        for (const r of remotes) {
            g.setEdge(String(local.id), String(r.id));
        }
    }

    dagre.layout(g);

    const positions = new Map<string, { x: number; y: number }>();
    for (const n of fleetNodes) {
        const pos = g.node(String(n.id));
        positions.set(String(n.id), {
            x: pos.x - pos.width / 2,
            y: pos.y - pos.height / 2,
        });
    }
    return positions;
}

function buildGroupedLayout(fleetNodes: FleetTopologyNode[]): {
    positions: Map<string, { x: number; y: number }>;
    clusterByNodeId: Map<string, string>;
} {
    const g = new dagre.graphlib.Graph({ compound: true });
    g.setGraph({
        rankdir: 'LR',
        ranksep: 120,
        nodesep: 28,
        marginx: 24,
        marginy: 24,
    });
    g.setDefaultEdgeLabel(() => ({}));

    const clusterByNodeId = new Map<string, string>();
    const clusterIds = new Set<string>();

    for (const n of fleetNodes) {
        const cluster = n.type === 'local' ? LOCAL_CLUSTER_ID : clusterForRemote(n);
        clusterByNodeId.set(String(n.id), cluster);
        clusterIds.add(cluster);
    }

    for (const cid of clusterIds) {
        g.setNode(cid, {});
    }
    for (const n of fleetNodes) {
        g.setNode(String(n.id), { width: NODE_WIDTH, height: NODE_HEIGHT });
        g.setParent(String(n.id), clusterByNodeId.get(String(n.id))!);
    }

    // Real hub edges (local→remote) plus intra-cluster pseudo-edges so dagre
    // keeps cluster members vertically aligned. Intra-cluster edges are stripped
    // from the rendered edge list later.
    const local = fleetNodes.find(n => n.type === 'local') ?? null;
    if (local) {
        for (const r of fleetNodes) {
            if (r.type === 'local') continue;
            g.setEdge(String(local.id), String(r.id));
        }
    }
    dagre.layout(g);

    const positions = new Map<string, { x: number; y: number }>();
    for (const n of fleetNodes) {
        const pos = g.node(String(n.id));
        positions.set(String(n.id), {
            x: pos.x - pos.width / 2,
            y: pos.y - pos.height / 2,
        });
    }
    return { positions, clusterByNodeId };
}

export interface LayoutOptions {
    mode: LayoutMode;
    savedPositions?: SavedPositions;
}

export function layoutFleetGraph(
    fleetNodes: FleetTopologyNode[],
    opts: LayoutOptions = { mode: 'hub' },
): { nodes: Node[]; edges: Edge[] } {
    if (fleetNodes.length === 0) return { nodes: [], edges: [] };

    const local = fleetNodes.find(n => n.type === 'local') ?? null;
    const remotes = fleetNodes.filter(n => n.type !== 'local');

    let positions: Map<string, { x: number; y: number }>;
    let clusterByNodeId: Map<string, string> | null = null;

    switch (opts.mode) {
        case 'grouped': {
            const result = buildGroupedLayout(fleetNodes);
            positions = result.positions;
            clusterByNodeId = result.clusterByNodeId;
            break;
        }
        case 'free': {
            positions = buildHubLayout(fleetNodes);
            const saved = opts.savedPositions ?? {};
            for (const n of fleetNodes) {
                const key = String(n.id);
                if (saved[key]) positions.set(key, saved[key]);
            }
            break;
        }
        case 'hub':
        default:
            positions = buildHubLayout(fleetNodes);
            break;
    }

    const flowNodes: Node[] = fleetNodes.map(n => {
        const key = String(n.id);
        const pos = positions.get(key) ?? { x: 0, y: 0 };
        const cluster = clusterByNodeId?.get(key);
        return {
            id: key,
            type: 'fleetNode',
            position: pos,
            data: { node: n, clusterLabel: cluster } satisfies FleetNodeData,
            draggable: true,
        };
    });

    const flowEdges: Edge[] = local
        ? remotes.map(r => ({
            id: `edge-${local.id}-${r.id}`,
            source: String(local.id),
            target: String(r.id),
            style: edgeStyle(r),
            animated: false,
        }))
        : [];

    return { nodes: flowNodes, edges: flowEdges };
}

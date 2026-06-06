import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

// Mirrors the payload from GET /api/fleet/dependency-map. The repo defines
// types per side rather than sharing a package, matching how the topology and
// fleet views re-declare their backend shapes.
export type DepNodeKind = 'host' | 'stack' | 'service' | 'network' | 'volume' | 'port';
export type DepFlagKind = 'missing-dependency' | 'port-conflict' | 'orphan' | 'cross-stack-shared';
export type DepEdgeKind =
  | 'stack-node'
  | 'stack-service'
  | 'depends-on'
  | 'service-network'
  | 'service-volume'
  | 'service-port';

export interface DepNode {
  id: string;
  kind: DepNodeKind;
  label: string;
  nodeId: number;
  nodeName: string;
  stack: string | null;
  managedStatus?: 'managed' | 'unmanaged' | 'system';
  state?: string;
  flags: DepFlagKind[];
  meta?: Record<string, string | number>;
}

export interface DepEdge {
  id: string;
  source: string;
  target: string;
  kind: DepEdgeKind;
  declaredOnly?: boolean;
}

export interface DepFlag {
  kind: DepFlagKind;
  nodeId: number;
  nodeName: string;
  subjects: string[];
  detail: string;
}

export interface FleetDependencyMap {
  nodes: DepNode[];
  edges: DepEdge[];
  flags: DepFlag[];
  nodeErrors: { nodeId: number; nodeName: string; error: string }[];
  parseErrors: { nodeId: number; nodeName: string; stack: string; error: string }[];
}

export interface DepFlowData extends Record<string, unknown> {
  dep: DepNode;
  expanded: boolean;
  expandable: boolean;
  childCount: number;
}

export const DEP_NODE_DIMS: Record<DepNodeKind, { w: number; h: number }> = {
  host: { w: 200, h: 54 },
  stack: { w: 200, h: 58 },
  service: { w: 174, h: 50 },
  network: { w: 162, h: 46 },
  volume: { w: 162, h: 46 },
  port: { w: 150, h: 46 },
};

// ReactFlow inline styles cannot resolve CSS custom properties, so raw oklch
// values are used. They approximate the default cyan accent and do not track a
// user's chosen accent or light/dark theme.
const EDGE_BRAND = 'oklch(0.78 0.11 195)';
const EDGE_MUTED = 'oklch(0.55 0 0)';

function edgeStyle(e: DepEdge): { stroke: string; strokeWidth: number; strokeDasharray?: string } {
  if (e.declaredOnly) return { stroke: EDGE_MUTED, strokeWidth: 1, strokeDasharray: '4 4' };
  if (e.kind === 'stack-node' || e.kind === 'stack-service') return { stroke: EDGE_MUTED, strokeWidth: 1 };
  return { stroke: EDGE_BRAND, strokeWidth: 1.5 };
}

/**
 * Positions an already-filtered set of dependency nodes/edges with dagre and
 * maps them to ReactFlow nodes/edges. Visibility (collapse/expand and filters)
 * is decided by the caller; this function only lays out what it is given.
 */
export function layoutDependencyGraph(
  nodes: DepNode[],
  edges: DepEdge[],
  expanded: Set<string>,
  childCounts: Map<string, number>,
): { nodes: Node[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes: [], edges: [] };

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 120, nodesep: 22, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    const d = DEP_NODE_DIMS[n.kind];
    g.setNode(n.id, { width: d.w, height: d.h });
  }
  const visibleEdges = edges.filter((e) => g.hasNode(e.source) && g.hasNode(e.target));
  for (const e of visibleEdges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const flowNodes: Node[] = nodes.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      type: 'dep',
      position: { x: p.x - p.width / 2, y: p.y - p.height / 2 },
      data: {
        dep: n,
        expanded: expanded.has(n.id),
        expandable: n.kind === 'stack',
        childCount: childCounts.get(n.id) ?? 0,
      } satisfies DepFlowData,
      draggable: true,
    };
  });

  const flowEdges: Edge[] = visibleEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    style: edgeStyle(e),
    animated: false,
  }));

  return { nodes: flowNodes, edges: flowEdges };
}

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  RefreshCw, Search, Server, Layers, Box, Network, Database, Plug,
  ChevronRight, ChevronDown, TriangleAlert, Share2,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  layoutDependencyGraph,
  DEP_NODE_DIMS,
  type FleetDependencyMap,
  type DepNode,
  type DepNodeKind,
  type DepFlagKind,
  type DepFlowData,
} from '@/lib/dependency-map-layout';

// Above this many visible graph nodes the graph becomes unreadable; we prompt
// the operator to filter or switch to the (uncapped) list instead.
const GRAPH_NODE_CEILING = 300;

// ReactFlow MiniMap fills cannot resolve CSS custom properties; these raw oklch
// values approximate the default accent/severity palette and do not track theme.
const MINIMAP_BRAND = 'oklch(0.78 0.11 195)';
const MINIMAP_WARNING = 'oklch(0.75 0.14 75)';
const MINIMAP_DESTRUCTIVE = 'oklch(0.62 0.21 25)';
const MINIMAP_MUTED = 'oklch(0.55 0 0)';

const KIND_ICON: Record<DepNodeKind, typeof Server> = {
  host: Server,
  stack: Layers,
  service: Box,
  network: Network,
  volume: Database,
  port: Plug,
};

const FLAG_META: { kind: DepFlagKind; label: string; severity: 'warning' | 'destructive' }[] = [
  { kind: 'missing-dependency', label: 'Missing deps', severity: 'destructive' },
  { kind: 'port-conflict', label: 'Port conflicts', severity: 'destructive' },
  { kind: 'orphan', label: 'Orphans', severity: 'warning' },
  { kind: 'cross-stack-shared', label: 'Shared', severity: 'warning' },
];

const DESTRUCTIVE_FLAGS = new Set<DepFlagKind>(['missing-dependency', 'port-conflict']);

function worstSeverity(flags: DepFlagKind[]): 'destructive' | 'warning' | null {
  if (flags.length === 0) return null;
  return flags.some((f) => DESTRUCTIVE_FLAGS.has(f)) ? 'destructive' : 'warning';
}

// ── Node card ─────────────────────────────────────────────────────────────

function DependencyNodeCard({ data }: { data: DepFlowData }) {
  const dep = data.dep;
  const Icon = KIND_ICON[dep.kind];
  const severity = worstSeverity(dep.flags);
  const isHost = dep.kind === 'host';

  return (
    <div
      className={cn(
        'rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden',
        isHost && 'ring-1 ring-brand/40',
        severity === 'destructive' && 'ring-1 ring-destructive/50',
        severity === 'warning' && 'ring-1 ring-warning/40',
        data.expandable && 'cursor-pointer',
      )}
      style={{ width: DEP_NODE_DIMS[dep.kind].w }}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="h-3.5 w-3.5 text-stat-icon shrink-0" strokeWidth={1.5} />
        <span className="text-xs font-medium text-stat-value truncate" title={dep.label}>{dep.label}</span>
        {data.expandable && (
          data.expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" strokeWidth={2} />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" strokeWidth={2} />
        )}
      </div>
      {(dep.state || severity || (data.expandable && data.childCount > 0)) && (
        <div className="flex items-center gap-1.5 px-3 pb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
          {dep.state && <span>{dep.state}</span>}
          {data.expandable && data.childCount > 0 && <span>· {data.childCount} svc</span>}
          {severity && (
            <span className={cn('ml-auto inline-flex items-center gap-1', severity === 'destructive' ? 'text-destructive' : 'text-warning')}>
              <TriangleAlert className="h-2.5 w-2.5" strokeWidth={2} />
              {dep.flags.length}
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}

const nodeTypes: NodeTypes = { dep: DependencyNodeCard };

// ── Adjacency helpers ──────────────────────────────────────────────────────

interface Adjacency {
  byId: Map<string, DepNode>;
  stackChildren: Map<string, string[]>;
  serviceResources: Map<string, string[]>;
  hostByNodeId: Map<number, string>;
  serviceStack: Map<string, string>;
}

function buildAdjacency(map: FleetDependencyMap): Adjacency {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const stackChildren = new Map<string, string[]>();
  const serviceResources = new Map<string, string[]>();
  const serviceStack = new Map<string, string>();
  const hostByNodeId = new Map<number, string>();

  for (const n of map.nodes) if (n.kind === 'host') hostByNodeId.set(n.nodeId, n.id);

  for (const e of map.edges) {
    if (e.kind === 'stack-service') {
      const arr = stackChildren.get(e.source) ?? [];
      arr.push(e.target);
      stackChildren.set(e.source, arr);
      serviceStack.set(e.target, e.source);
    } else if (e.kind === 'service-network' || e.kind === 'service-volume' || e.kind === 'service-port') {
      const arr = serviceResources.get(e.source) ?? [];
      arr.push(e.target);
      serviceResources.set(e.source, arr);
    }
  }
  return { byId, stackChildren, serviceResources, hostByNodeId, serviceStack };
}

// ── Tab ─────────────────────────────────────────────────────────────────────

type ViewMode = 'graph' | 'list';

export function DependencyMapTab() {
  const [data, setData] = useState<FleetDependencyMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('graph');
  const [search, setSearch] = useState('');
  const [nodeFilter, setNodeFilter] = useState<Set<number>>(new Set());
  const [flagFilter, setFlagFilter] = useState<Set<DepFlagKind>>(new Set());
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());

  const fetchMap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/fleet/dependency-map', { localOnly: true });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json() as FleetDependencyMap);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load dependency map';
      setError(message);
      toast.error(`Failed to load dependency map: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchMap(); }, [fetchMap]);

  const adjacency = useMemo(() => (data ? buildAdjacency(data) : null), [data]);

  const flagCounts = useMemo(() => {
    const counts = new Map<DepFlagKind, number>();
    for (const f of data?.flags ?? []) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    return counts;
  }, [data]);

  const presentNodeIds = useMemo(() => {
    const set = new Set<number>();
    for (const n of data?.nodes ?? []) set.add(n.nodeId);
    for (const e of data?.nodeErrors ?? []) set.add(e.nodeId);
    return [...set];
  }, [data]);

  const nodeNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const n of data?.nodes ?? []) m.set(n.nodeId, n.nodeName);
    for (const e of data?.nodeErrors ?? []) m.set(e.nodeId, e.nodeName);
    return m;
  }, [data]);

  const term = search.trim().toLowerCase();
  const searchActive = term !== '';
  const flagActive = flagFilter.size > 0;

  const passNode = useCallback((n: DepNode) => nodeFilter.size === 0 || nodeFilter.has(n.nodeId), [nodeFilter]);
  const textMatch = useCallback((n: DepNode) =>
    n.label.toLowerCase().includes(term) || (n.stack ?? '').toLowerCase().includes(term) || n.nodeName.toLowerCase().includes(term), [term]);
  const flagMatch = useCallback((n: DepNode) => n.flags.some((f) => flagFilter.has(f)), [flagFilter]);
  const matchesFilters = useCallback((n: DepNode) =>
    (!searchActive || textMatch(n)) && (!flagActive || flagMatch(n)), [searchActive, textMatch, flagActive, flagMatch]);

  // Resolve the set of nodes to draw (collapse + filters).
  const visible = useMemo(() => {
    if (!data || !adjacency) return { nodes: [] as DepNode[], expanded: new Set<string>() };
    const filterActive = searchActive || flagActive;
    const visibleIds = new Set<string>();
    const expanded = new Set(expandedStacks);

    const addWithHost = (n: DepNode) => {
      visibleIds.add(n.id);
      const host = adjacency.hostByNodeId.get(n.nodeId);
      if (host) visibleIds.add(host);
    };

    if (filterActive) {
      for (const n of data.nodes) {
        if (!passNode(n) || n.kind === 'host' || n.kind === 'stack') continue;
        if (!matchesFilters(n)) continue;
        addWithHost(n);
        const parentStack = adjacency.serviceStack.get(n.id);
        if (parentStack) { visibleIds.add(parentStack); expanded.add(parentStack); }
        for (const r of adjacency.serviceResources.get(n.id) ?? []) visibleIds.add(r);
      }
      // Orphan stacks that match directly.
      for (const n of data.nodes) {
        if (n.kind === 'stack' && passNode(n) && matchesFilters(n)) addWithHost(n);
      }
    } else {
      for (const n of data.nodes) {
        if (!passNode(n)) continue;
        if (n.kind === 'host' || n.kind === 'stack') { visibleIds.add(n.id); continue; }
        // Standalone orphan resources surface by default.
        if ((n.kind === 'network' || n.kind === 'volume') && n.flags.includes('orphan')) addWithHost(n);
      }
      for (const sid of expanded) {
        if (!visibleIds.has(sid)) continue;
        for (const svc of adjacency.stackChildren.get(sid) ?? []) {
          const svcNode = adjacency.byId.get(svc);
          if (!svcNode || !passNode(svcNode)) continue;
          visibleIds.add(svc);
          for (const r of adjacency.serviceResources.get(svc) ?? []) visibleIds.add(r);
        }
      }
    }

    return { nodes: data.nodes.filter((n) => visibleIds.has(n.id)), expanded };
  }, [data, adjacency, searchActive, flagActive, expandedStacks, passNode, matchesFilters]);

  const childCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (adjacency) for (const [stack, kids] of adjacency.stackChildren) m.set(stack, kids.length);
    return m;
  }, [adjacency]);

  const overCeiling = visible.nodes.length > GRAPH_NODE_CEILING;

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!data || view !== 'graph' || overCeiling) {
      setFlowNodes([]);
      setFlowEdges([]);
      return;
    }
    const visibleSet = new Set(visible.nodes.map((n) => n.id));
    const edges = data.edges.filter((e) => visibleSet.has(e.source) && visibleSet.has(e.target));
    const { nodes: fn, edges: fe } = layoutDependencyGraph(visible.nodes, edges, visible.expanded, childCounts);
    setFlowNodes(fn);
    setFlowEdges(fe);
  }, [data, view, overCeiling, visible, childCounts, setFlowNodes, setFlowEdges]);

  const handleNodeClick = useCallback((_e: React.MouseEvent, flowNode: Node) => {
    const dep = (flowNode.data as DepFlowData | undefined)?.dep;
    if (dep?.kind !== 'stack') return;
    setExpandedStacks((prev) => {
      const next = new Set(prev);
      if (next.has(flowNode.id)) next.delete(flowNode.id); else next.add(flowNode.id);
      return next;
    });
  }, []);

  const miniMapColor = useCallback((n: Node) => {
    const dep = (n.data as DepFlowData | undefined)?.dep;
    const sev = dep ? worstSeverity(dep.flags) : null;
    if (sev === 'destructive') return MINIMAP_DESTRUCTIVE;
    if (sev === 'warning') return MINIMAP_WARNING;
    if (dep?.kind === 'host') return MINIMAP_BRAND;
    return MINIMAP_MUTED;
  }, []);

  const toggleFlag = (kind: DepFlagKind) => setFlagFilter((prev) => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    return next;
  });
  const toggleNode = (id: number) => setNodeFilter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const listRows = useMemo(() => {
    if (!data) return [];
    return data.nodes
      .filter((n) => n.kind !== 'host')
      .filter(passNode)
      .filter(matchesFilters);
  }, [data, passNode, matchesFilters]);

  if (loading && !data) {
    return <div className="rounded-lg border border-card-border bg-card p-10 text-center text-sm text-muted-foreground">Loading dependency map…</div>;
  }
  if (error && !data) {
    return (
      <div className="rounded-lg border border-card-border bg-card p-10 text-center">
        <p className="text-sm text-muted-foreground mb-3">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void fetchMap()} className="gap-2">
          <RefreshCw className="w-4 h-4" />Retry
        </Button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search stacks, services, resources…"
            className="h-8 w-64 pl-8 text-sm"
          />
        </div>
        <SegmentedControl
          value={view}
          onChange={setView}
          ariaLabel="View mode"
          options={[
            { value: 'graph', label: 'Graph', icon: Share2 },
            { value: 'list', label: 'List', icon: Layers },
          ]}
        />
        <Button variant="outline" size="sm" onClick={() => void fetchMap()} disabled={loading} className="gap-2 ml-auto">
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />Refresh
        </Button>
      </div>

      {/* Flag summary strip */}
      <div className="flex items-center gap-2 flex-wrap">
        {FLAG_META.map((f) => {
          const count = flagCounts.get(f.kind) ?? 0;
          const active = flagFilter.has(f.kind);
          return (
            <button
              key={f.kind}
              type="button"
              onClick={() => toggleFlag(f.kind)}
              aria-pressed={active}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors',
                active ? 'border-brand/60 bg-brand/15 text-brand'
                  : count > 0 ? 'border-card-border text-foreground hover:bg-muted/40'
                    : 'border-card-border text-muted-foreground/60',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', f.severity === 'destructive' ? 'bg-destructive' : 'bg-warning')} />
              {f.label}
              <span className="tabular-nums">{count > 99 ? '99+' : count}</span>
            </button>
          );
        })}
      </div>

      {/* Node filter chips (only with more than one node present) */}
      {presentNodeIds.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">Node</span>
          {presentNodeIds.map((id) => {
            const active = nodeFilter.has(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleNode(id)}
                aria-pressed={active}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors',
                  active ? 'border-brand/60 bg-brand/15 text-brand' : 'border-card-border text-muted-foreground hover:text-foreground hover:bg-muted/40',
                )}
              >
                <Server className="h-3 w-3" strokeWidth={2} />
                {nodeNameById.get(id) ?? `Node ${id}`}
              </button>
            );
          })}
        </div>
      )}

      {/* Unreachable-node banner */}
      {data.nodeErrors.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={2} />
          <span>
            {data.nodeErrors.length === 1 ? '1 node could not be reached' : `${data.nodeErrors.length} nodes could not be reached`}: {data.nodeErrors.map((e) => e.nodeName).join(', ')}. The rest of the fleet is shown below.
          </span>
        </div>
      )}

      {data.parseErrors.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={2} />
          <span>
            {data.parseErrors.length === 1 ? '1 stack could not be parsed' : `${data.parseErrors.length} stacks could not be parsed`}: {data.parseErrors.map((e) => `${e.nodeName}/${e.stack}`).join(', ')}. Their declared dependencies are not shown.
          </span>
        </div>
      )}

      {/* Body */}
      {view === 'graph' ? (
        overCeiling ? (
          <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-10 text-center">
            <Network className="h-6 w-6 text-muted-foreground mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-sm text-muted-foreground mb-1">This fleet is large to draw at once ({visible.nodes.length} elements).</p>
            <p className="text-sm text-muted-foreground mb-4">Narrow it with search or filters, or switch to the list.</p>
            <Button variant="outline" size="sm" onClick={() => setView('list')}>Switch to list</Button>
          </div>
        ) : flowNodes.length === 0 ? (
          <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-10 text-center text-sm text-muted-foreground">
            {searchActive || flagActive ? 'No elements match the current filters.' : 'No stacks to map on this fleet.'}
          </div>
        ) : (
          <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground bg-muted/30 border-b border-card-border">
              Click a stack to expand its services, networks, volumes, and ports.
            </div>
            <div className="h-[560px] w-full">
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={handleNodeClick}
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
                <MiniMap className="!bg-card !border-card-border !shadow-card-bevel" nodeColor={miniMapColor} maskColor="oklch(0 0 0 / 0.2)" pannable zoomable />
              </ReactFlow>
            </div>
          </div>
        )
      ) : (
        <DependencyList rows={listRows} nodeColumn={presentNodeIds.length > 1} />
      )}
    </div>
  );
}

// ── List view ───────────────────────────────────────────────────────────────

function DependencyList({ rows, nodeColumn }: { rows: DepNode[]; nodeColumn: boolean }) {
  if (rows.length === 0) {
    return <div className="rounded-lg border border-card-border bg-card p-10 text-center text-sm text-muted-foreground">No elements match the current filters.</div>;
  }
  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            {nodeColumn && <th className="text-left px-3 py-2 font-normal">Node</th>}
            <th className="text-left px-3 py-2 font-normal">Stack</th>
            <th className="text-left px-3 py-2 font-normal">Type</th>
            <th className="text-left px-3 py-2 font-normal">Name</th>
            <th className="text-left px-3 py-2 font-normal">State</th>
            <th className="text-left px-3 py-2 font-normal">Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const sev = worstSeverity(n.flags);
            return (
              <tr key={n.id} className="border-b border-card-border/50 last:border-0">
                {nodeColumn && <td className="px-3 py-1.5 text-muted-foreground">{n.nodeName}</td>}
                <td className="px-3 py-1.5 text-muted-foreground">{n.stack ?? '—'}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{n.kind}</td>
                <td className="px-3 py-1.5 text-stat-value">{n.label}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{n.state ?? '—'}</td>
                <td className="px-3 py-1.5">
                  {n.flags.length === 0 ? <span className="text-muted-foreground">—</span> : (
                    <span className={cn('inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em]', sev === 'destructive' ? 'text-destructive' : 'text-warning')}>
                      <TriangleAlert className="h-3 w-3" strokeWidth={2} />
                      {n.flags.join(', ')}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { visibilityInterval } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ArrowLeftRight, Loader2, ScrollText, Table2, Network } from 'lucide-react';
import { RoutingNodeCard } from './RoutingNodeCard';
import { MeshOptInSheet } from './MeshOptInSheet';
import { MeshRouteDetailSheet } from './MeshRouteDetailSheet';
import { MeshDiagnosticsSheet } from './MeshDiagnosticsSheet';
import { MeshActivitySheet } from './MeshActivitySheet';
import { MeshTopologyGraph, type MeshGraphEdgeMode } from './MeshTopologyGraph';
import { MeshStackTopologySheet } from './MeshStackTopologySheet';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { MeshAlias, MeshDataPlaneStatus, MeshNodeStatus, MeshProbeResult } from '@/types/mesh';

type RoutingViewMode = 'table' | 'graph';

interface TopologyStackTarget {
    nodeId: number;
    nodeName: string;
    stack: string;
}

const MESH_REFRESH_INTERVAL_MS = 30000;
const VIEW_MODE_KEY = 'sencho-routing-view-mode';
const EDGE_MODE_KEY = 'sencho-routing-edge-mode';

function readStoredViewMode(): RoutingViewMode {
    try {
        const v = localStorage.getItem(VIEW_MODE_KEY);
        return v === 'graph' ? 'graph' : 'table';
    } catch {
        return 'table';
    }
}

function readStoredEdgeMode(): MeshGraphEdgeMode {
    try {
        const v = localStorage.getItem(EDGE_MODE_KEY);
        return v === 'aliases' ? 'aliases' : 'tunnels';
    } catch {
        return 'tunnels';
    }
}

export function RoutingTab() {
    const [status, setStatus] = useState<MeshNodeStatus[]>([]);
    const [localDataPlane, setLocalDataPlane] = useState<MeshDataPlaneStatus | null>(null);
    const [aliases, setAliases] = useState<MeshAlias[]>([]);
    const [loading, setLoading] = useState(true);
    const [optInNode, setOptInNode] = useState<{ id: number; name: string } | null>(null);
    const [diagnosticsNode, setDiagnosticsNode] = useState<{ id: number; name: string } | null>(null);
    const [routeDetailAlias, setRouteDetailAlias] = useState<string | null>(null);
    const [activityOpen, setActivityOpen] = useState(false);
    const [viewMode, setViewMode] = useState<RoutingViewMode>(readStoredViewMode);
    const [edgeMode, setEdgeMode] = useState<MeshGraphEdgeMode>(readStoredEdgeMode);
    const [topologyStack, setTopologyStack] = useState<TopologyStackTarget | null>(null);

    const refresh = useCallback(async (opts: { silent?: boolean } = {}) => {
        try {
            const [statusRes, aliasesRes] = await Promise.all([
                apiFetch('/mesh/status', { localOnly: true }),
                apiFetch('/mesh/aliases', { localOnly: true }),
            ]);
            if (statusRes.ok) {
                const body = await statusRes.json() as { nodes: MeshNodeStatus[]; localDataPlane?: MeshDataPlaneStatus };
                setStatus(body.nodes);
                if (body.localDataPlane) setLocalDataPlane(body.localDataPlane);
            }
            if (aliasesRes.ok) {
                const body = await aliasesRes.json() as { aliases: MeshAlias[] };
                setAliases(body.aliases);
            }
        } catch (err) {
            if (opts.silent) {
                console.warn('[mesh] background refresh failed:', (err as Error).message);
            } else {
                toast.error(`Failed to load mesh state: ${(err as Error).message}`);
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    useEffect(
        () => visibilityInterval(() => { void refresh({ silent: true }); }, MESH_REFRESH_INTERVAL_MS),
        [refresh],
    );

    const setViewModePersisted = useCallback((mode: RoutingViewMode) => {
        setViewMode(mode);
        try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* localStorage unavailable */ }
    }, []);

    const setEdgeModePersisted = useCallback((mode: MeshGraphEdgeMode) => {
        setEdgeMode(mode);
        try { localStorage.setItem(EDGE_MODE_KEY, mode); } catch { /* localStorage unavailable */ }
    }, []);

    const testUpstream = useCallback(async (alias: string): Promise<void> => {
        try {
            const res = await apiFetch(`/mesh/aliases/${encodeURIComponent(alias)}/test`, {
                method: 'POST', localOnly: true,
            });
            const body = await res.json() as MeshProbeResult;
            if (body.ok) {
                toast.success(`${alias} ok (${body.latencyMs}ms)`);
            } else {
                toast.error(`${alias} ${body.where ?? 'fail'}: ${body.code ?? 'error'}`);
            }
        } catch (err) {
            toast.error(`Probe failed: ${(err as Error).message}`);
        }
    }, []);

    const handleGraphNodeClick = useCallback((nodeId: number) => {
        const target = status.find((s) => s.nodeId === nodeId);
        if (!target) return;
        setOptInNode({ id: target.nodeId, name: target.nodeName });
    }, [status]);

    const totalAliases = aliases.length;
    const meshedNodes = status.filter((s) => s.enabled).length;
    // A node is "reachable for mesh" when it is local, a pilot with an
    // active tunnel, or a Distributed API remote with valid credentials
    // (central can dial the on-demand proxy tunnel as needed).
    const reachableNodes = status.filter((s) => (
        s.reachableMode === 'local'
        || (s.reachableMode === 'pilot' && s.pilotConnected)
        || s.reachableMode === 'proxy'
    )).length;

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12 text-stat-subtitle">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                Loading mesh state…
            </div>
        );
    }

    if (status.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16">
                <ArrowLeftRight className="w-12 h-12 text-stat-subtitle mb-4" />
                <div className="text-lg font-display italic mb-2">No nodes available</div>
                <div className="text-sm text-stat-subtitle text-center max-w-md">
                    Add a node to the fleet to start routing traffic between containers across nodes.
                </div>
            </div>
        );
    }

    if (meshedNodes === 0) {
        return (
            <div className="space-y-4">
                <RoutingMasthead meshedNodes={meshedNodes} reachableNodes={reachableNodes} totalAliases={totalAliases} onShowActivity={() => setActivityOpen(true)} />
                <DataPlaneBanner status={localDataPlane} />
                <div className="flex flex-col items-center justify-center py-12 rounded border border-dashed border-card-border bg-card/50">
                    <ArrowLeftRight className="w-12 h-12 text-stat-subtitle mb-4" />
                    <div className="text-lg font-display italic mb-2">Mesh containers across nodes</div>
                    <div className="text-sm text-stat-subtitle text-center max-w-md mb-6">
                        Add a stack to the mesh and its services become reachable from any other meshed
                        stack by hostname. No VPN, no firewall changes.
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-[18px] grid-auto-rows-min-content items-start w-full">
                        {status.map((s) => (
                            <RoutingNodeCard
                                key={s.nodeId}
                                status={s}
                                aliases={aliases}
                                onAddStack={() => setOptInNode({ id: s.nodeId, name: s.nodeName })}
                                onShowDiagnostics={() => setDiagnosticsNode({ id: s.nodeId, name: s.nodeName })}
                                onShowAlias={(alias) => setRouteDetailAlias(alias)}
                                onTestUpstream={testUpstream}
                                onChanged={() => { void refresh(); }}
                            />
                        ))}
                    </div>
                </div>
                <SheetsRoot
                    optInNode={optInNode} setOptInNode={setOptInNode}
                    diagnosticsNode={diagnosticsNode} setDiagnosticsNode={setDiagnosticsNode}
                    routeDetailAlias={routeDetailAlias} setRouteDetailAlias={setRouteDetailAlias}
                    activityOpen={activityOpen} setActivityOpen={setActivityOpen}
                    topologyStack={topologyStack}
                    setTopologyStack={setTopologyStack}
                    status={status}
                    aliases={aliases}
                    onChanged={() => { void refresh(); }}
                />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <RoutingMasthead meshedNodes={meshedNodes} reachableNodes={reachableNodes} totalAliases={totalAliases} onShowActivity={() => setActivityOpen(true)} />
            <DataPlaneBanner status={localDataPlane} />
            <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl<RoutingViewMode>
                    value={viewMode}
                    onChange={setViewModePersisted}
                    ariaLabel="Routing view mode"
                    options={[
                        { value: 'table', label: 'Table', icon: Table2 },
                        { value: 'graph', label: 'Graph', icon: Network },
                    ]}
                />
                {viewMode === 'graph' && (
                    <SegmentedControl<MeshGraphEdgeMode>
                        value={edgeMode}
                        onChange={setEdgeModePersisted}
                        ariaLabel="Mesh graph edge mode"
                        options={[
                            { value: 'tunnels', label: 'Tunnels' },
                            { value: 'aliases', label: 'Aliases', badge: totalAliases },
                        ]}
                    />
                )}
            </div>
            {viewMode === 'table' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-[18px] grid-auto-rows-min-content items-start">
                    {status.map((s) => (
                        <RoutingNodeCard
                            key={s.nodeId}
                            status={s}
                            aliases={aliases}
                            onAddStack={() => setOptInNode({ id: s.nodeId, name: s.nodeName })}
                            onShowDiagnostics={() => setDiagnosticsNode({ id: s.nodeId, name: s.nodeName })}
                            onShowAlias={(alias) => setRouteDetailAlias(alias)}
                            onTestUpstream={testUpstream}
                            onChanged={() => { void refresh(); }}
                        />
                    ))}
                </div>
            ) : (
                <MeshTopologyGraph
                    status={status}
                    aliases={aliases}
                    edgeMode={edgeMode}
                    onNodeClick={handleGraphNodeClick}
                />
            )}
            <SheetsRoot
                optInNode={optInNode} setOptInNode={setOptInNode}
                diagnosticsNode={diagnosticsNode} setDiagnosticsNode={setDiagnosticsNode}
                routeDetailAlias={routeDetailAlias} setRouteDetailAlias={setRouteDetailAlias}
                activityOpen={activityOpen} setActivityOpen={setActivityOpen}
                topologyStack={topologyStack}
                setTopologyStack={setTopologyStack}
                status={status}
                aliases={aliases}
                onChanged={() => { void refresh(); }}
            />
        </div>
    );
}

/**
 * Visible when the local Sencho's mesh data plane is down. Distinguishes the
 * common reasons (subnet conflict, IP-in-use, invalid CIDR) so the operator
 * does not have to dig through the activity log to know how to recover. The
 * `not_in_docker` warn-level case is intentionally suppressed: it is the
 * expected condition for dev-mode startup.
 */
function DataPlaneBanner({ status }: { status: MeshDataPlaneStatus | null }) {
    if (!status || status.ok || status.reason === 'not_in_docker' || status.reason === 'not_started') {
        return null;
    }
    const headlines: Record<Exclude<MeshDataPlaneStatus['reason'], 'ok' | 'not_started' | 'not_in_docker'>, string> = {
        subnet_invalid: 'SENCHO_MESH_SUBNET is not a valid CIDR.',
        subnet_overlap: `Mesh subnet ${status.subnet} overlaps another Docker network on this host.`,
        subnet_mismatch: `sencho_mesh already exists with a different subnet than ${status.subnet}.`,
        ip_in_use: `Another container is using Sencho's address on ${status.subnet}.`,
        attach_failed: 'Sencho could not attach to its own mesh network.',
    };
    const reason = status.reason as keyof typeof headlines;
    return (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-3 shadow-card-bevel">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={1.75} />
            <div className="min-w-0 space-y-1">
                <div className="font-medium">Mesh data plane is down</div>
                <div className="text-xs leading-relaxed text-destructive/90">
                    {headlines[reason] ?? 'Mesh setup did not complete.'}
                    {' '}
                    Set <code className="font-mono bg-destructive/15 px-1 py-0.5 rounded text-[11px]">SENCHO_MESH_SUBNET</code> to a free <code className="font-mono bg-destructive/15 px-1 py-0.5 rounded text-[11px]">/24</code> (for example <code className="font-mono bg-destructive/15 px-1 py-0.5 rounded text-[11px]">10.42.0.0/24</code>) and restart the Sencho container.
                </div>
                {status.message ? (
                    <div className="text-[11px] font-mono text-destructive/80 truncate">{status.message}</div>
                ) : null}
            </div>
        </div>
    );
}

function RoutingMasthead({ meshedNodes, reachableNodes, totalAliases, onShowActivity }: {
    meshedNodes: number; reachableNodes: number; totalAliases: number; onShowActivity: () => void;
}) {
    const stateWord = meshedNodes === 0 ? 'unmeshed' : meshedNodes < reachableNodes ? 'partial' : 'meshed';
    return (
        <div className="flex items-center justify-between rounded-lg border border-card-border bg-card p-4 shadow-card-bevel">
            <div className="flex items-center gap-4">
                <div className="font-display italic text-2xl">{stateWord}</div>
                <div className="grid grid-cols-3 gap-4 text-xs">
                    <div>
                        <div className="text-[10px] leading-3 tracking-[0.18em] uppercase text-stat-subtitle font-mono">meshed</div>
                        <div className="font-mono text-stat-value">{meshedNodes}/{reachableNodes}</div>
                    </div>
                    <div>
                        <div className="text-[10px] leading-3 tracking-[0.18em] uppercase text-stat-subtitle font-mono">aliases</div>
                        <div className="font-mono text-stat-value">{totalAliases}</div>
                    </div>
                </div>
            </div>
            <Button variant="outline" size="sm" onClick={onShowActivity}>
                <ScrollText className="w-3 h-3 mr-1" /> Mesh activity
            </Button>
        </div>
    );
}

function SheetsRoot(props: {
    optInNode: { id: number; name: string } | null;
    setOptInNode: (v: { id: number; name: string } | null) => void;
    diagnosticsNode: { id: number; name: string } | null;
    setDiagnosticsNode: (v: { id: number; name: string } | null) => void;
    routeDetailAlias: string | null;
    setRouteDetailAlias: (v: string | null) => void;
    activityOpen: boolean;
    setActivityOpen: (v: boolean) => void;
    topologyStack: TopologyStackTarget | null;
    setTopologyStack: (v: TopologyStackTarget | null) => void;
    status: MeshNodeStatus[];
    aliases: MeshAlias[];
    onChanged: () => void;
}) {
    const optInNode = props.optInNode;
    return (
        <>
            {optInNode && (
                <MeshOptInSheet
                    open={!!optInNode}
                    onOpenChange={(open) => { if (!open) props.setOptInNode(null); }}
                    nodeId={optInNode.id}
                    nodeName={optInNode.name}
                    onChanged={props.onChanged}
                    onViewTopology={(stack) => {
                        props.setTopologyStack({ nodeId: optInNode.id, nodeName: optInNode.name, stack });
                        props.setOptInNode(null);
                    }}
                />
            )}
            <MeshDiagnosticsSheet
                open={!!props.diagnosticsNode}
                onOpenChange={(open) => { if (!open) props.setDiagnosticsNode(null); }}
                nodeId={props.diagnosticsNode?.id ?? null}
                nodeName={props.diagnosticsNode?.name ?? null}
            />
            <MeshRouteDetailSheet
                open={!!props.routeDetailAlias}
                onOpenChange={(open) => { if (!open) props.setRouteDetailAlias(null); }}
                alias={props.routeDetailAlias}
            />
            <MeshActivitySheet
                open={props.activityOpen}
                onOpenChange={props.setActivityOpen}
            />
            <MeshStackTopologySheet
                open={!!props.topologyStack}
                onOpenChange={(open) => { if (!open) props.setTopologyStack(null); }}
                nodeId={props.topologyStack?.nodeId ?? null}
                nodeName={props.topologyStack?.nodeName ?? null}
                stackName={props.topologyStack?.stack ?? null}
                status={props.status}
                aliases={props.aliases}
            />
        </>
    );
}

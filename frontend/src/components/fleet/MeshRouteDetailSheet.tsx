import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { formatTimeAgo } from '@/lib/relativeTime';
import { toast } from '@/components/ui/toast-store';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { Badge } from '@/components/ui/badge';
import { ConfirmModal } from '@/components/ui/modal';
import { Loader2, Activity, Hash, Trash2 } from 'lucide-react';
import type { MeshAlias, MeshNodeStatus, MeshRouteDiagnostic, MeshActivityEvent, MeshProbeResult } from '@/types/mesh';
import { meshRouteStateFromBackend, meshRouteStateTokens } from './meshRouteState';
import { describeTransport } from './meshTransport';
import { MeshStackTopologyView } from './MeshStackTopologyView';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    alias: string | null;
    /** Removing a route opts its owning stack out of the mesh; admin-only, mirrors the backend gate. */
    canManage: boolean;
    status: MeshNodeStatus[];
    aliases: MeshAlias[];
    onChanged: () => void;
}

type RouteTab = 'overview' | 'events' | 'topology' | 'raw';

export function MeshRouteDetailSheet({ open, onOpenChange, alias, canManage, status, aliases, onChanged }: Props) {
    const [diag, setDiag] = useState<MeshRouteDiagnostic | null>(null);
    const [events, setEvents] = useState<MeshActivityEvent[]>([]);
    const [probe, setProbe] = useState<MeshProbeResult | null>(null);
    const [probing, setProbing] = useState(false);
    const [loading, setLoading] = useState(false);
    const [activeTab, setActiveTab] = useState<RouteTab>('overview');
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [removing, setRemoving] = useState(false);

    useEffect(() => {
        if (!open || !alias) return;
        // Reset per-alias state so a stale target can never drive the destructive
        // remove action (or a misleading transport row) during the refetch window.
        setDiag(null);
        setProbe(null);
        setEvents([]);
        let cancelled = false;
        const refresh = async () => {
            setLoading(true);
            try {
                const [diagRes, evRes] = await Promise.all([
                    apiFetch(`/mesh/aliases/${encodeURIComponent(alias)}/diagnostic`, { localOnly: true }),
                    apiFetch(`/mesh/activity?alias=${encodeURIComponent(alias)}&limit=20`, { localOnly: true }),
                ]);
                if (cancelled) return;
                if (diagRes.ok) setDiag(await diagRes.json());
                if (evRes.ok) {
                    const body = await evRes.json() as { events: MeshActivityEvent[] };
                    setEvents(body.events);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void refresh();
        return () => { cancelled = true; };
    }, [open, alias]);

    const runProbe = async () => {
        if (!alias) return;
        setProbing(true);
        setProbe(null);
        try {
            const res = await apiFetch(`/mesh/aliases/${encodeURIComponent(alias)}/test`, {
                method: 'POST', localOnly: true,
            });
            const body = await res.json() as MeshProbeResult;
            setProbe(body);
        } finally {
            setProbing(false);
        }
    };

    const removeFromMesh = async () => {
        const tgt = diag?.target;
        if (!tgt) return;
        setRemoving(true);
        try {
            const res = await apiFetch(
                `/mesh/nodes/${tgt.nodeId}/stacks/${encodeURIComponent(tgt.stack)}/opt-out`,
                { method: 'POST', localOnly: true },
            );
            if (!res.ok) throw new Error(`status ${res.status}`);
            toast.success(`${tgt.stack} removed from mesh, redeploying`);
            onChanged();
            onOpenChange(false);
        } catch (err) {
            toast.error(`Failed to remove from mesh: ${(err as Error).message}`);
        } finally {
            setRemoving(false);
        }
    };

    if (!alias) return null;
    const pillState = diag ? meshRouteStateFromBackend(diag.state) : 'not-authorized';
    const pill = meshRouteStateTokens(pillState);

    const meta = diag?.target
        ? `${diag.target.stack}/${diag.target.service}:${diag.target.port} · node #${diag.target.nodeId}`
        : (loading ? 'Loading…' : 'No target resolved');

    const footerContext = probe
        ? (probe.ok ? `Last probe ok · ${probe.latencyMs}ms` : `Last probe failed · ${probe.where ?? 'unknown'}`)
        : diag?.lastProbeMs != null
            ? (diag.lastProbeAt != null
                ? `Last probe ${formatTimeAgo(diag.lastProbeAt)} · ${diag.lastProbeMs}ms`
                : `Last probe ${diag.lastProbeMs}ms`)
            : 'No probe run yet';

    const target = diag?.target ?? null;
    const targetNode = target ? status.find((s) => s.nodeId === target.nodeId) : undefined;
    const stackAliasCount = target
        ? aliases.filter((a) => a.nodeId === target.nodeId && a.stackName === target.stack).length
        : 0;
    const transport = describeTransport(targetNode, diag?.pilot.connected ?? false);

    return (
        <>
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Fleet', 'Mesh', 'Routes', alias]}
            name={alias}
            meta={meta}
            primaryAction={{
                label: probing ? 'Probing…' : 'Test probe',
                icon: probing ? Loader2 : Activity,
                onClick: () => { void runProbe(); },
                disabled: probing,
            }}
            destructiveAction={canManage && target ? {
                label: removing ? 'Removing…' : 'Remove from mesh',
                icon: Trash2,
                onClick: () => setConfirmRemove(true),
                disabled: removing,
            } : undefined}
            tabs={[
                { id: 'overview', label: 'Overview' },
                { id: 'events', label: 'Events', count: events.length },
                { id: 'topology', label: 'Topology' },
                { id: 'raw', label: 'Raw' },
            ]}
            activeTab={activeTab}
            onTabChange={(id) => setActiveTab(id as RouteTab)}
            footerContext={footerContext}
            size="md"
        >
            {activeTab === 'overview' && (
                <>
                    <SheetSection title="State" hideHeader>
                        <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-sm border text-[10px] leading-3 font-mono uppercase tracking-[0.18em] ${pill.toneClass}`}>
                                {pill.label}
                            </span>
                            {probe && (
                                <Badge variant={probe.ok ? 'default' : 'destructive'} className="text-[10px] font-mono">
                                    {probe.ok ? `ok ${probe.latencyMs}ms` : `${probe.where ?? 'fail'}: ${probe.code ?? 'error'}`}
                                </Badge>
                            )}
                        </div>
                    </SheetSection>

                    {diag?.target && (
                        <SheetSection title="Target">
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                                <div className="text-stat-subtitle">Target node</div>
                                <div className="font-mono text-stat-value">#{diag.target.nodeId}</div>
                                <div className="text-stat-subtitle">Stack / service</div>
                                <div className="font-mono text-stat-value">{diag.target.stack}/{diag.target.service}</div>
                                <div className="text-stat-subtitle">Port</div>
                                <div className="font-mono text-stat-value">{diag.target.port}</div>
                                <div className="text-stat-subtitle">{transport.label}</div>
                                <div className="font-mono text-stat-value">{transport.value}</div>
                            </div>
                        </SheetSection>
                    )}

                    {diag?.lastError && (
                        <SheetSection title="Last error">
                            <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-xs">
                                <div className="text-stat-value">{diag.lastError.message}</div>
                                <div className="text-[10px] text-stat-subtitle mt-1">{new Date(diag.lastError.ts).toLocaleString()}</div>
                            </div>
                        </SheetSection>
                    )}
                </>
            )}

            {activeTab === 'events' && (
                <SheetSection title="Recent activity" hideHeader>
                    <div className="space-y-1">
                        {loading && <Loader2 className="w-4 h-4 animate-spin text-stat-subtitle" />}
                        {!loading && events.length === 0 && (
                            <div className="text-xs text-stat-subtitle">No events yet for this alias.</div>
                        )}
                        {events.map((e, i) => (
                            <div key={i} className="flex items-start gap-2 text-[11px] font-mono">
                                {e.source === 'pilot' && <Hash className="w-3 h-3 mt-0.5 text-stat-subtitle" />}
                                {e.source === 'mesh' && <Activity className="w-3 h-3 mt-0.5 text-stat-subtitle" />}
                                <span className={`tabular-nums ${e.level === 'error' ? 'text-destructive' : e.level === 'warn' ? 'text-warning' : 'text-stat-value'}`}>
                                    {new Date(e.ts).toLocaleTimeString()} {e.type} {e.message}
                                </span>
                            </div>
                        ))}
                    </div>
                </SheetSection>
            )}

            {activeTab === 'topology' && (
                <SheetSection title="Stack topology" hideHeader>
                    {diag?.target ? (
                        <MeshStackTopologyView
                            nodeId={diag.target.nodeId}
                            stackName={diag.target.stack}
                            status={status}
                            aliases={aliases}
                        />
                    ) : (
                        <div className="text-xs text-stat-subtitle">No target resolved for this alias.</div>
                    )}
                </SheetSection>
            )}

            {activeTab === 'raw' && (
                <SheetSection title="Diagnostic JSON" hideHeader>
                    <pre className="text-[11px] font-mono text-stat-value bg-card border border-card-border rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
                        {diag ? JSON.stringify(diag, null, 2) : 'No diagnostic data loaded.'}
                    </pre>
                </SheetSection>
            )}
        </SystemSheet>
        <ConfirmModal
            open={confirmRemove}
            onOpenChange={(o) => { if (!o) setConfirmRemove(false); }}
            variant="destructive"
            kicker={`Mesh / ${target?.stack ?? ''}`}
            title={`Remove ${target?.stack ?? 'stack'} from the mesh?`}
            description={
                target
                    ? `${target.stack} will be redeployed on node #${target.nodeId} so its containers drop the mesh routing entries. This removes ${stackAliasCount} ${stackAliasCount === 1 ? 'alias' : 'aliases'} published by this stack.`
                    : undefined
            }
            confirmLabel="Remove and redeploy"
            onConfirm={() => { setConfirmRemove(false); void removeFromMesh(); }}
            onCancel={() => setConfirmRemove(false)}
        />
        </>
    );
}

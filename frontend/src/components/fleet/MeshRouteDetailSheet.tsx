import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { Badge } from '@/components/ui/badge';
import { Loader2, Activity, Hash } from 'lucide-react';
import type { MeshRouteDiagnostic, MeshActivityEvent, MeshProbeResult } from '@/types/mesh';
import { meshRouteStateFromBackend, meshRouteStateTokens } from './meshRouteState';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    alias: string | null;
}

type RouteTab = 'overview' | 'events' | 'raw';

export function MeshRouteDetailSheet({ open, onOpenChange, alias }: Props) {
    const [diag, setDiag] = useState<MeshRouteDiagnostic | null>(null);
    const [events, setEvents] = useState<MeshActivityEvent[]>([]);
    const [probe, setProbe] = useState<MeshProbeResult | null>(null);
    const [probing, setProbing] = useState(false);
    const [loading, setLoading] = useState(false);
    const [activeTab, setActiveTab] = useState<RouteTab>('overview');

    useEffect(() => {
        if (!open || !alias) return;
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

    if (!alias) return null;
    const pillState = diag ? meshRouteStateFromBackend(diag.state) : 'not-authorized';
    const pill = meshRouteStateTokens(pillState);

    const meta = diag?.target
        ? `${diag.target.stack}/${diag.target.service}:${diag.target.port} · node #${diag.target.nodeId}`
        : (loading ? 'Loading…' : 'No target resolved');

    const footerContext = probe
        ? (probe.ok ? `Last probe ok · ${probe.latencyMs}ms` : `Last probe failed · ${probe.where ?? 'unknown'}`)
        : (diag?.lastProbeMs != null ? `Last probe ${diag.lastProbeMs}ms` : 'No probe run yet');

    return (
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
            tabs={[
                { id: 'overview', label: 'Overview' },
                { id: 'events', label: 'Events', count: events.length },
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
                                <div className="text-stat-subtitle">Pilot tunnel</div>
                                <div className="font-mono text-stat-value">{diag.pilot.connected ? 'connected' : 'disconnected'}</div>
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

            {activeTab === 'raw' && (
                <SheetSection title="Diagnostic JSON" hideHeader>
                    <pre className="text-[11px] font-mono text-stat-value bg-card border border-card-border rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
                        {diag ? JSON.stringify(diag, null, 2) : 'No diagnostic data loaded.'}
                    </pre>
                </SheetSection>
            )}
        </SystemSheet>
    );
}

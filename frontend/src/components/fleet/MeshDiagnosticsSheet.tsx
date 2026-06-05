import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { RefreshCw } from 'lucide-react';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { MeshNodeDiagnostic, MeshNodeStatus } from '@/types/mesh';
import { describeTransport } from './meshTransport';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    nodeId: number | null;
    nodeName: string | null;
    /** Routing status for this node; drives the transport-aware diagnostics line. */
    nodeStatus: MeshNodeStatus | null;
}

function bytesFmt(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function ageFmt(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    return `${Math.floor(ms / 60_000)}m`;
}

export function MeshDiagnosticsSheet({ open, onOpenChange, nodeId, nodeName, nodeStatus }: Props) {
    const [diag, setDiag] = useState<MeshNodeDiagnostic | null>(null);
    const [loading, setLoading] = useState(false);
    const [updatedAt, setUpdatedAt] = useState<number | null>(null);

    const refresh = async () => {
        if (nodeId == null) return;
        setLoading(true);
        try {
            const res = await apiFetch(`/mesh/nodes/${nodeId}/diagnostic`, { localOnly: true });
            if (res.ok) {
                setDiag(await res.json());
                setUpdatedAt(Date.now());
            }
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (open) void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, nodeId]);

    const transport = describeTransport(nodeStatus ?? undefined, diag?.pilot.connected ?? false);
    const isPilotNode = nodeStatus?.reachableMode === 'pilot';
    const forwarderLabel = diag
        ? (diag.forwarder.listening ? `forwarder listening (${diag.forwarder.listenerCount})` : 'forwarder idle')
        : 'forwarder ?';
    const transportLabel = `${transport.label.toLowerCase()} ${transport.value}`;
    const streamsLabel = `${diag?.activeStreams.length ?? 0} streams`;
    const aliasesLabel = `${diag?.aliasCache.length ?? 0} aliases`;
    const meta = `${forwarderLabel} · ${transportLabel} · ${streamsLabel} · ${aliasesLabel}`;

    const footerContext = updatedAt ? `Updated ${formatTimeAgo(updatedAt)}` : (loading ? 'Loading…' : 'Never updated');

    return (
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Fleet', 'Mesh', 'Diagnostics']}
            name={nodeName ?? 'Diagnostics'}
            meta={meta}
            primaryAction={{
                label: 'Refresh',
                icon: RefreshCw,
                onClick: () => { void refresh(); },
                disabled: loading,
            }}
            footerContext={footerContext}
            size="md"
        >
            <SheetSection title="Forwarder · transport">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <div className="text-stat-subtitle">Forwarder</div>
                    <div className="font-mono text-stat-value">
                        {diag?.forwarder.listening ? `listening on ${diag.forwarder.listenerCount} port${diag.forwarder.listenerCount === 1 ? '' : 's'}` : 'idle'}
                    </div>
                    <div className="text-stat-subtitle">{transport.label}</div>
                    <div className="font-mono text-stat-value">{transport.value}</div>
                    {isPilotNode && (
                        <>
                            <div className="text-stat-subtitle">Buffered</div>
                            <div className="font-mono text-stat-value">{diag ? bytesFmt(diag.pilot.bufferedAmount) : '-'}</div>
                            <div className="text-stat-subtitle">Last seen</div>
                            <div className="font-mono text-stat-value">{diag?.pilot.lastSeen ? new Date(diag.pilot.lastSeen).toLocaleTimeString() : '-'}</div>
                        </>
                    )}
                </div>
                <p className="text-[11px] text-stat-subtitle leading-snug mt-2">
                    Mesh runs in-process on each node; no separate container.
                </p>
            </SheetSection>

            <SheetSection title="Active streams">
                {(!diag || diag.activeStreams.length === 0) && (
                    <div className="text-xs text-stat-subtitle">No active streams.</div>
                )}
                <div className="divide-y divide-card-border/40">
                    {diag?.activeStreams.map((s) => (
                        <div key={s.streamId} className="flex justify-between py-1.5 text-[11px] font-mono">
                            <span>#{s.streamId} {s.alias ?? '<no-alias>'}</span>
                            <span className="text-stat-subtitle">in {bytesFmt(s.bytesIn)} / out {bytesFmt(s.bytesOut)} · {ageFmt(s.ageMs)}</span>
                        </div>
                    ))}
                </div>
            </SheetSection>

            <SheetSection title="Resolver cache">
                {(!diag || diag.aliasCache.length === 0) && (
                    <div className="text-xs text-stat-subtitle">No aliases registered.</div>
                )}
                <div className="divide-y divide-card-border/40">
                    {diag?.aliasCache.map((a) => (
                        <div key={a.host} className="flex justify-between py-1.5 text-[11px] font-mono">
                            <span>{a.host}</span>
                            <span className="text-stat-subtitle">node #{a.targetNodeId}:{a.port}</span>
                        </div>
                    ))}
                </div>
            </SheetSection>
        </SystemSheet>
    );
}

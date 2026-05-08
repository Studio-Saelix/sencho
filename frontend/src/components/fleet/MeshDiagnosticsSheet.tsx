import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { RefreshCw, ServerCog } from 'lucide-react';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { MeshNodeDiagnostic } from '@/types/mesh';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    nodeId: number | null;
    nodeName: string | null;
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

export function MeshDiagnosticsSheet({ open, onOpenChange, nodeId, nodeName }: Props) {
    const [diag, setDiag] = useState<MeshNodeDiagnostic | null>(null);
    const [loading, setLoading] = useState(false);
    const [restarting, setRestarting] = useState(false);
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

    const restart = async () => {
        if (nodeId == null) return;
        setRestarting(true);
        try {
            const res = await apiFetch(`/mesh/nodes/${nodeId}/sidecar/restart`, {
                method: 'POST', localOnly: true,
            });
            if (res.ok) {
                toast.success('Sidecar restart requested');
                await refresh();
            } else {
                toast.error('Sidecar restart failed');
            }
        } finally {
            setRestarting(false);
        }
    };

    const sidecarLabel = diag ? (diag.sidecar.running ? 'sidecar running' : 'sidecar off') : 'sidecar ?';
    const pilotLabel = diag ? (diag.pilot.connected ? 'pilot connected' : 'pilot disconnected') : 'pilot ?';
    const streamsLabel = `${diag?.activeStreams.length ?? 0} streams`;
    const aliasesLabel = `${diag?.aliasCache.length ?? 0} aliases`;
    const meta = `${sidecarLabel} · ${pilotLabel} · ${streamsLabel} · ${aliasesLabel}`;

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
            secondaryActions={[
                {
                    label: 'Restart sidecar',
                    icon: ServerCog,
                    onClick: () => { void restart(); },
                    disabled: restarting,
                },
            ]}
            footerContext={footerContext}
            size="md"
        >
            <SheetSection title="Pilot · sidecar · transport">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <div className="text-stat-subtitle">Sidecar</div>
                    <div className="font-mono text-stat-value">{diag?.sidecar.running ? 'running' : 'off'}</div>
                    <div className="text-stat-subtitle">Pilot tunnel</div>
                    <div className="font-mono text-stat-value">{diag?.pilot.connected ? 'connected' : 'disconnected'}</div>
                    <div className="text-stat-subtitle">Buffered</div>
                    <div className="font-mono text-stat-value">{diag ? bytesFmt(diag.pilot.bufferedAmount) : '-'}</div>
                    <div className="text-stat-subtitle">Last seen</div>
                    <div className="font-mono text-stat-value">{diag?.pilot.lastSeen ? new Date(diag.pilot.lastSeen).toLocaleTimeString() : '-'}</div>
                </div>
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

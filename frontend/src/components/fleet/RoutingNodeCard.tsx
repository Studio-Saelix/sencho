import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Plus, ServerCog, Activity, Loader2 } from 'lucide-react';
import type { MeshAlias, MeshNodeStatus } from '@/types/mesh';
import { meshRouteStateFor, meshRouteStateTokens } from './meshRouteState';

interface Props {
    status: MeshNodeStatus;
    aliases: MeshAlias[];
    onAddStack: () => void;
    onShowDiagnostics: () => void;
    onShowAlias: (alias: string) => void;
    onTestUpstream: (alias: string) => Promise<void>;
    onChanged: () => void;
}

export function RoutingNodeCard({
    status, aliases, onAddStack, onShowDiagnostics, onShowAlias, onTestUpstream, onChanged,
}: Props) {
    const [toggling, setToggling] = useState(false);
    const [testingAlias, setTestingAlias] = useState<string | null>(null);

    const nodeAliases = aliases.filter((a) => a.nodeId === status.nodeId);

    const toggleEnabled = async (next: boolean) => {
        setToggling(true);
        try {
            const action = next ? 'enable' : 'disable';
            const res = await apiFetch(`/mesh/nodes/${status.nodeId}/${action}`, {
                method: 'POST', localOnly: true,
            });
            if (!res.ok) throw new Error(`status ${res.status}`);
            toast.success(next ? 'Mesh enabled on node' : 'Mesh disabled on node');
            onChanged();
        } catch (err) {
            toast.error(`Failed to ${next ? 'enable' : 'disable'} mesh: ${(err as Error).message}`);
        } finally {
            setToggling(false);
        }
    };

    const runTest = async (alias: string) => {
        setTestingAlias(alias);
        try { await onTestUpstream(alias); } finally { setTestingAlias(null); }
    };

    return (
        <Card className="bg-card shadow-card-bevel">
            <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{status.nodeName}</span>
                        {status.reachableMode === 'local' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-brand/40 bg-brand/10 text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-brand">
                                ★ Local
                            </span>
                        )}
                        {status.reachableMode === 'pilot' && !status.pilotConnected && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-destructive/40 bg-destructive/10 text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-destructive">
                                pilot offline
                            </span>
                        )}
                        {status.reachableMode === 'unreachable' && (
                            <span
                                title={status.reachableReason ?? undefined}
                                className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-destructive/40 bg-destructive/10 text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-destructive"
                            >
                                unreachable
                            </span>
                        )}
                        {status.reverseCallbackStatus === 'connecting' && (
                            <span
                                title="Central is dialing the reverse bridge to this peer."
                                className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-card-border bg-card text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-stat-subtitle"
                            >
                                reconnecting
                            </span>
                        )}
                        {status.reverseCallbackStatus === 'unavailable' && (
                            <span
                                title="Peer→central tunnel is between dials. Central will redial on its next reconcile tick."
                                className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-amber-500/40 bg-amber-500/10 text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-amber-600 dark:text-amber-400"
                            >
                                reverse unavailable
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <TogglePill
                            checked={status.enabled}
                            disabled={toggling || status.reachableMode === 'unreachable'}
                            onChange={(next) => { void toggleEnabled(next); }}
                        />
                        <Button variant="outline" size="sm" onClick={onShowDiagnostics}>
                            <ServerCog className="w-3 h-3 mr-1" /> Diagnostics
                        </Button>
                    </div>
                </div>

                {status.reachableMode === 'unreachable' && status.reachableReason && (
                    <div className="text-[11px] text-destructive">
                        {status.reachableReason}
                    </div>
                )}
                {status.reachableMode === 'pilot' && !status.pilotConnected && (
                    <div className="text-[11px] text-stat-subtitle">
                        Pilot tunnel is not connected. Mesh traffic resumes when the agent reconnects.
                    </div>
                )}

                <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="text-stat-subtitle">Mesh stacks</div>
                    <div className="font-mono text-stat-value">{status.optedInStacks.length}</div>
                    <div className="text-stat-subtitle">Aliases</div>
                    <div className="font-mono text-stat-value">{nodeAliases.length}</div>
                </div>

                {status.enabled && (
                    <>
                        <div className="border-t border-card-border pt-2 space-y-1">
                            {nodeAliases.length === 0 && (
                                <div className="text-[11px] text-stat-subtitle">No mesh services on this node yet.</div>
                            )}
                            {nodeAliases.map((a) => {
                                const pillState = meshRouteStateFor({
                                    optedIn: true,
                                    pilotConnected: status.pilotConnected,
                                });
                                const pill = meshRouteStateTokens(pillState);
                                return (
                                    <div key={a.host} className="flex items-center justify-between gap-2 rounded border border-card-border bg-card px-2 py-1.5">
                                        <button
                                            type="button"
                                            className="text-[11px] font-mono text-left truncate hover:text-brand transition-colors"
                                            onClick={() => onShowAlias(a.host)}
                                        >
                                            {a.host}:{a.port}
                                        </button>
                                        <span className={`shrink-0 px-1.5 py-0.5 rounded-sm border text-[10px] leading-3 font-mono uppercase tracking-[0.18em] ${pill.toneClass}`}>
                                            {pill.label}
                                        </span>
                                        <Button
                                            variant="ghost" size="sm"
                                            onClick={() => { void runTest(a.host); }}
                                            disabled={testingAlias === a.host}
                                            className="h-6 px-1.5"
                                        >
                                            {testingAlias === a.host
                                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                                : <Activity className="w-3 h-3" />}
                                        </Button>
                                    </div>
                                );
                            })}
                        </div>
                        <Button
                            variant="outline" size="sm" className="w-full"
                            onClick={onAddStack}
                            disabled={status.reachableMode === 'unreachable'}
                        >
                            <Plus className="w-3 h-3 mr-1" /> Add stack to mesh
                        </Button>
                    </>
                )}
            </CardContent>
        </Card>
    );
}


import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SystemSheet } from '@/components/ui/system-sheet';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import type { MeshNodeStatus, MeshStackEntry } from '@/types/mesh';
import { computeMeshMembershipImpact, describeMeshMembershipImpact, type MeshMembershipChange } from './meshImpact';
import { describeMembershipError } from './meshMessages';
import { Loader2 } from 'lucide-react';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    nodeId: number;
    nodeName: string;
    onChanged: () => void;
    /** Whether the user may start the mesh-wide membership cascade. */
    canManage: boolean;
    /** Every node's mesh status, used to show what the change restarts. */
    status?: MeshNodeStatus[];
}

export function MeshOptInSheet({ open, onOpenChange, nodeId, nodeName, onChanged, canManage, status = [] }: Props) {
    const [stacks, setStacks] = useState<MeshStackEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingStack, setPendingStack] = useState<string | null>(null);
    const [confirmStack, setConfirmStack] = useState<MeshStackEntry | null>(null);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await apiFetch(`/mesh/nodes/${nodeId}/stacks`, { localOnly: true });
                if (!res.ok) throw new Error(`status ${res.status}`);
                const data = await res.json() as { stacks: MeshStackEntry[] };
                if (!cancelled) setStacks(data.stacks);
            } catch (err) {
                if (!cancelled) setError((err as Error).message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [open, nodeId]);

    const performToggle = async (stack: MeshStackEntry) => {
        setPendingStack(stack.name);
        setError(null);
        try {
            const action = stack.optedIn ? 'opt-out' : 'opt-in';
            const res = await apiFetch(
                `/mesh/nodes/${nodeId}/stacks/${encodeURIComponent(stack.name)}/${action}`,
                { method: 'POST', localOnly: true },
            );
            if (!res.ok) {
                const body = await res.json().catch(() => ({})) as { error?: string };
                setError(describeMembershipError(res.status, body.error));
                return;
            }
            setStacks((prev) => prev.map((s) => s.name === stack.name ? { ...s, optedIn: !stack.optedIn } : s));
            onChanged();
            toast.success(stack.optedIn
                ? `${stack.name} removed from the mesh. Restarting affected stacks.`
                : `${stack.name} added to the mesh. Restarting affected stacks.`);
        } catch (err) {
            setError(`Mesh update failed: ${(err as Error).message}`);
        } finally {
            setPendingStack(null);
        }
    };

    const inMeshCount = stacks.filter((s) => s.optedIn).length;
    const confirmChange: MeshMembershipChange | null = confirmStack
        ? { kind: confirmStack.optedIn ? 'opt-out' : 'opt-in', nodeId, stackName: confirmStack.name }
        : null;
    const confirmDescription = confirmChange
        ? describeMeshMembershipImpact(computeMeshMembershipImpact(status, confirmChange), confirmChange)
        : undefined;
    const meta = `${inMeshCount} of ${stacks.length} in mesh`;

    return (
        <>
            <SystemSheet
                open={open}
                onOpenChange={onOpenChange}
                crumb={['Fleet', 'Mesh', nodeName]}
                name={nodeName}
                meta={meta}
                size="sm"
            >
                <div className="space-y-4">
                    <p className="text-sm text-stat-subtitle leading-snug">
                        Adding a stack lets its services be reached from other meshed stacks by hostname.
                        Adding or removing a stack restarts it, and restarts the other meshed stacks so they learn the new hostnames.
                        {!canManage && ' Changing mesh membership requires an administrator.'}
                    </p>

                    {loading && (
                        <div className="flex items-center gap-2 text-stat-subtitle text-sm">
                            <Loader2 className="w-4 h-4 animate-spin" /> Loading stacks…
                        </div>
                    )}
                    {error && (
                        <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                            {error}
                        </div>
                    )}
                    {!loading && stacks.length === 0 && (
                        <div className="text-sm text-stat-subtitle">No stacks deployed on this node yet.</div>
                    )}

                    <div className="space-y-2">
                        {stacks.map((stack) => (
                            <div key={stack.name} className="flex items-center justify-between rounded border border-card-border bg-card px-3 py-2">
                                <div className="flex items-center gap-3">
                                    <span className="text-sm font-mono">{stack.name}</span>
                                    {stack.optedIn && pendingStack !== stack.name && (
                                        <span className="text-[10px] leading-3 tracking-[0.18em] uppercase text-success/80 font-mono">in mesh</span>
                                    )}
                                </div>
                                {pendingStack === stack.name ? (
                                    <Loader2 className="w-4 h-4 animate-spin text-stat-subtitle" />
                                ) : (
                                    <div className="flex items-center gap-2">
                                        {canManage && (
                                            <Button
                                                size="sm"
                                                variant={stack.optedIn ? 'outline' : 'default'}
                                                onClick={() => setConfirmStack(stack)}
                                            >
                                                {stack.optedIn ? 'Remove from mesh' : 'Add to mesh'}
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            </SystemSheet>

            <ConfirmModal
                open={!!confirmStack}
                onOpenChange={(o) => { if (!o) setConfirmStack(null); }}
                variant={confirmStack?.optedIn ? 'destructive' : 'default'}
                kicker={`Mesh / ${nodeName}`}
                title={
                    confirmStack?.optedIn
                        ? `Remove ${confirmStack.name} from mesh?`
                        : `Add ${confirmStack?.name ?? ''} to mesh?`
                }
                description={confirmDescription}
                confirmLabel={confirmStack?.optedIn ? 'Remove and restart' : 'Add and restart'}
                onConfirm={() => {
                    if (confirmStack) void performToggle(confirmStack);
                    setConfirmStack(null);
                }}
                onCancel={() => setConfirmStack(null)}
            />
        </>
    );
}

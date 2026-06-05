import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Loader2, Pin, Server } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { FleetTabHeading } from './FleetEmptyState';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    listBlueprints,
    pinBlueprint,
    describeSelector,
    type BlueprintListItem,
} from '@/lib/blueprintsApi';
import { listNodes, type NodeRecord } from '@/lib/nodesApi';

const UNPINNED = '__unpinned__';

function formatTimestamp(ms: number | null): string {
    if (!ms) return '';
    const date = new Date(ms);
    return date.toLocaleString();
}

interface FederationTabProps {
    /** Whether the current user may change pin placement. Pinning is admin-only on the backend
     * (PUT /api/blueprints/:id/pin requires admin); non-admins see the placement read-only. */
    canManage: boolean;
}

export function FederationTab({ canManage }: FederationTabProps) {
    const [nodes, setNodes] = useState<NodeRecord[]>([]);
    const [blueprints, setBlueprints] = useState<BlueprintListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [savingId, setSavingId] = useState<number | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [nodesResult, blueprintsResult] = await Promise.all([
                listNodes(),
                listBlueprints(),
            ]);
            setNodes(nodesResult);
            setBlueprints(blueprintsResult);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load federation data';
            toast.error(message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const cordonedNodes = useMemo(() => nodes.filter(n => n.cordoned), [nodes]);
    const nodeNameById = useMemo(() => {
        const map = new Map<number, string>();
        for (const node of nodes) map.set(node.id, node.name);
        return map;
    }, [nodes]);

    const handlePinChange = useCallback(async (blueprintId: number, value: string) => {
        const nodeId = value === UNPINNED ? null : Number.parseInt(value, 10);
        setSavingId(blueprintId);
        try {
            const updated = await pinBlueprint(blueprintId, nodeId);
            setBlueprints(prev => prev.map(b => b.id === blueprintId ? { ...b, pinned_node_id: updated.pinned_node_id } : b));
            const blueprint = blueprints.find(b => b.id === blueprintId);
            if (nodeId === null) {
                toast.success(`${blueprint?.name ?? 'Blueprint'} unpinned`);
            } else {
                const targetName = nodeNameById.get(nodeId) ?? `node ${nodeId}`;
                toast.success(`${blueprint?.name ?? 'Blueprint'} pinned to ${targetName}`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to update pin';
            toast.error(message);
        } finally {
            setSavingId(null);
        }
    }, [blueprints, nodeNameById]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12 text-stat-subtitle">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                Loading federation state…
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <FleetTabHeading
                title="Placement control"
                subtitle="Mark nodes unschedulable and pin blueprints to specific nodes."
            />

            <section className="rounded-xl border border-card-border bg-card">
                <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Ban className="w-4 h-4 text-warning" />
                        <h3 className="text-sm font-medium">Cordoned nodes</h3>
                        <span className="text-xs text-muted-foreground">
                            {cordonedNodes.length} of {nodes.length}
                        </span>
                    </div>
                    <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-stat-subtitle">
                        Toggle on each node card
                    </span>
                </div>
                <div className="p-4">
                    {cordonedNodes.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No nodes are cordoned. Use the kebab menu on any node card to mark it unschedulable.
                        </p>
                    ) : (
                        <ul className="divide-y divide-card-border">
                            {cordonedNodes.map(node => (
                                <li key={node.id} className="py-2 first:pt-0 last:pb-0 flex items-start gap-3">
                                    <Server className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-sm font-medium">{node.name}</span>
                                            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-stat-subtitle">{node.type}</span>
                                            {node.cordoned_at && (
                                                <span className="text-[10px] text-muted-foreground">
                                                    since {formatTimestamp(node.cordoned_at)}
                                                </span>
                                            )}
                                        </div>
                                        {node.cordoned_reason && (
                                            <p className="text-xs text-muted-foreground mt-0.5">{node.cordoned_reason}</p>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </section>

            <section className="rounded-xl border border-card-border bg-card">
                <div className="px-4 py-3 border-b border-card-border flex items-center gap-2">
                    <Pin className="w-4 h-4 text-foreground" />
                    <h3 className="text-sm font-medium">Pin policy</h3>
                    <span className="text-xs text-muted-foreground">
                        Force a blueprint onto a specific node, overriding its selector.
                        {!canManage && ' Pin changes require an administrator.'}
                    </span>
                </div>
                <div className="p-4">
                    {blueprints.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No blueprints yet. Create one in the Deployments tab to manage placement here.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-mono uppercase tracking-[0.18em] text-stat-subtitle border-b border-card-border">
                                        <th className="py-2 pr-4 font-normal">Blueprint</th>
                                        <th className="py-2 pr-4 font-normal">Selector</th>
                                        <th className="py-2 pr-4 font-normal">Pinned to</th>
                                        <th className="py-2 pr-4 font-normal">Effective</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-card-border">
                                    {blueprints.map(bp => {
                                        const pinnedName = bp.pinned_node_id !== null
                                            ? nodeNameById.get(bp.pinned_node_id) ?? `node ${bp.pinned_node_id}`
                                            : null;
                                        const effective = pinnedName
                                            ? `pin: ${pinnedName}`
                                            : describeSelector(bp.selector);
                                        return (
                                            <tr key={bp.id}>
                                                <td className="py-2 pr-4 align-top">
                                                    <div className="font-medium">{bp.name}</div>
                                                    {bp.description && (
                                                        <div className="text-xs text-muted-foreground line-clamp-1">{bp.description}</div>
                                                    )}
                                                </td>
                                                <td className="py-2 pr-4 align-top text-xs text-muted-foreground">
                                                    {describeSelector(bp.selector)}
                                                </td>
                                                <td className="py-2 pr-4 align-top">
                                                    {canManage ? (
                                                        <Select
                                                            value={bp.pinned_node_id !== null ? String(bp.pinned_node_id) : UNPINNED}
                                                            onValueChange={(value) => void handlePinChange(bp.id, value)}
                                                            disabled={savingId === bp.id}
                                                        >
                                                            <SelectTrigger className="h-8 w-56">
                                                                <SelectValue placeholder="(unpinned)" />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value={UNPINNED}>(unpinned)</SelectItem>
                                                                {nodes.map(node => (
                                                                    <SelectItem key={node.id} value={String(node.id)}>
                                                                        {node.name}
                                                                        {node.cordoned ? ' · cordoned' : ''}
                                                                    </SelectItem>
                                                                ))}
                                                            </SelectContent>
                                                        </Select>
                                                    ) : (
                                                        <span className={pinnedName ? 'text-sm' : 'text-xs text-muted-foreground'}>
                                                            {pinnedName ?? '(unpinned)'}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="py-2 pr-4 align-top text-xs text-muted-foreground">
                                                    {effective}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

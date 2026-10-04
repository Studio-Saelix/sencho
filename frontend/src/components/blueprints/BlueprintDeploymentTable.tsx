import { Lock, AlertTriangle, Pin, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
    type BlueprintDeployment,
    type BlueprintClassification,
    type BlueprintDeploymentStatus,
} from '@/lib/blueprintsApi';
import { useNodes } from '@/context/NodeContext';
import { formatTimeAgo } from '@/lib/relativeTime';
import { summarizeFailure, type FailureSummary } from '@/lib/blueprintStatus';

interface BlueprintDeploymentTableProps {
    deployments: BlueprintDeployment[];
    classification: BlueprintClassification;
    canDeploy: (nodeId: number) => boolean;
    canWithdraw: (nodeId: number) => boolean;
    canRetry: boolean;
    busyNodeId: number | null;
    onWithdraw: (nodeId: number) => void;
    onAcceptStateReview: (nodeId: number) => void;
    onRetry: (nodeId: number) => void;
    pinnedNodeId?: number | null;
}

const STATUS_LABEL: Record<BlueprintDeploymentStatus, string> = {
    pending: 'Pending',
    pending_state_review: 'Awaiting confirmation',
    deploying: 'Deploying',
    active: 'Active',
    drifted: 'Drifted',
    correcting: 'Correcting',
    repair_held: 'Repair held',
    failed: 'Failed',
    withdrawing: 'Withdrawing',
    withdrawn: 'Withdrawn',
    evict_blocked: 'Evict blocked',
    name_conflict: 'Name conflict',
};

function statusDotClass(status: BlueprintDeploymentStatus): string {
    switch (status) {
        case 'active': return 'bg-success';
        case 'deploying':
        case 'correcting': return 'bg-brand';
        case 'failed':
        case 'name_conflict': return 'bg-destructive';
        case 'drifted':
        case 'repair_held':
        case 'pending':
        case 'pending_state_review':
        case 'evict_blocked':
        case 'withdrawing': return 'bg-warning';
        default: return 'bg-muted-foreground';
    }
}

/** One line of why a deploy failed; the full output stays one click away. */
function FailureNote({ failure }: { failure: FailureSummary }) {
    return (
        <div className="space-y-1">
            <p className="break-words font-mono text-[10px] leading-relaxed text-destructive">{failure.summary}</p>
            {failure.full && (
                <details>
                    <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle hover:text-stat-value">
                        Full output
                    </summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-stat-subtitle">{failure.full}</pre>
                </details>
            )}
        </div>
    );
}

export function BlueprintDeploymentTable({
    deployments, classification, canDeploy, canWithdraw, canRetry, busyNodeId, onWithdraw, onAcceptStateReview, onRetry, pinnedNodeId = null,
}: BlueprintDeploymentTableProps) {
    const { nodes } = useNodes();
    const nodesById = new Map(nodes.map(n => [n.id, n]));

    if (deployments.length === 0) {
        return (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-stat-subtitle">
                No deployments yet. They appear here once a rollout is confirmed.
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-card-border bg-card">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-24 font-mono text-[10px] uppercase tracking-[0.18em]">Node</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-[0.18em]">Status</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-[0.18em]">Last activity</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-[0.18em]">Notes</TableHead>
                        <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.18em]">Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {deployments.map(dep => {
                        const node = nodesById.get(dep.node_id);
                        const lastSeen = dep.last_drift_at ?? dep.last_deployed_at ?? dep.last_checked_at;
                        const isStateful = classification === 'stateful' || classification === 'unknown';
                        const failure = summarizeFailure(dep.last_error);
                        return (
                            <TableRow key={dep.id}>
                                <TableCell className="font-medium align-top">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm truncate">{node?.name ?? `node ${dep.node_id}`}</span>
                                        {dep.status === 'active' && isStateful && (
                                            <span title="Data pinned on this node" className="text-warning">
                                                <Lock className="h-3 w-3" strokeWidth={1.5} />
                                            </span>
                                        )}
                                        {pinnedNodeId === dep.node_id && (
                                            <span
                                                title="Blueprint is pinned to this node (Federation)"
                                                className="inline-flex items-center gap-0.5 text-[9px] font-mono uppercase tracking-[0.18em] text-foreground/80"
                                            >
                                                <Pin className="h-3 w-3" strokeWidth={1.5} />
                                                Pinned
                                            </span>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell className="align-top">
                                    <div className="flex items-center gap-2">
                                        <span className={`inline-block w-2 h-2 rounded-full ${statusDotClass(dep.status)}`} aria-hidden />
                                        <span className="text-xs">{STATUS_LABEL[dep.status]}</span>
                                    </div>
                                </TableCell>
                                <TableCell className="text-xs text-stat-subtitle align-top">
                                    {lastSeen ? formatTimeAgo(lastSeen) : '-'}
                                </TableCell>
                                <TableCell className="text-xs text-stat-subtitle align-top max-w-[220px]">
                                    {failure ? (
                                        <FailureNote failure={failure} />
                                    ) : dep.drift_summary ? (
                                        <span className="break-words font-mono text-[10px] leading-relaxed">{dep.drift_summary}</span>
                                    ) : dep.status === 'failed' ? (
                                        <span className="text-muted-foreground">No error output recorded</span>
                                    ) : (
                                        <span className="text-muted-foreground">-</span>
                                    )}
                                </TableCell>
                                <TableCell className="align-top">
                                    <div className="flex items-center justify-end gap-1">
                                        {dep.status === 'pending_state_review' && canDeploy(dep.node_id) && (
                                            <Button
                                                size="sm"
                                                variant="default"
                                                onClick={() => onAcceptStateReview(dep.node_id)}
                                                disabled={busyNodeId === dep.node_id}
                                            >
                                                Confirm deploy
                                            </Button>
                                        )}
                                        {dep.status === 'name_conflict' && (
                                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] font-mono text-destructive">
                                                <ShieldQuestion className="w-3 h-3" strokeWidth={1.5} />
                                                Resolve manually
                                            </span>
                                        )}
                                        {dep.status === 'failed' && canRetry && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => onRetry(dep.node_id)}
                                                disabled={busyNodeId === dep.node_id}
                                            >
                                                Re-apply
                                            </Button>
                                        )}
                                        {(dep.status === 'active' || dep.status === 'drifted' || dep.status === 'repair_held' || dep.status === 'evict_blocked' || dep.status === 'failed') && canWithdraw(dep.node_id) && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onWithdraw(dep.node_id)}
                                                disabled={busyNodeId === dep.node_id}
                                                className="text-destructive hover:text-destructive"
                                            >
                                                {dep.status === 'evict_blocked' ? (
                                                    <span className="inline-flex items-center gap-1">
                                                        <AlertTriangle className="w-3 h-3" strokeWidth={1.5} />
                                                        Evict
                                                    </span>
                                                ) : 'Withdraw'}
                                            </Button>
                                        )}
                                    </div>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

import { useState } from 'react';
import {
    Server, Cpu, MemoryStick, HardDrive, ChevronDown, ChevronRight,
    Layers, Wifi, WifiOff, AlertTriangle, Download, Loader2,
    MoreVertical, Ban,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmModal } from '@/components/ui/modal';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatBytes } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { formatVersion } from '@/lib/version';
import { useLicense } from '@/context/LicenseContext';
import { cordonNode, uncordonNode } from '@/lib/nodesApi';
import { UpdateStatusBadge } from './UpdateStatusBadge';
import { StackSection } from './NodeCardStackList';
import type { Label as StackLabel } from '../label-types';
import type { FleetNode, NodeUpdateStatus } from './types';
import { getNodeCpu, getNodeMem, getNodeDisk, isCritical } from './nodeUtils';

// --- Types ---

export interface NodeCardProps {
    node: FleetNode;
    onNavigate: (nodeId: number, stackName: string) => void;
    labelMap?: Record<string, StackLabel[]>;
    updateStatus?: NodeUpdateStatus;
    onUpdate?: (nodeId: number) => void;
    updatingNodeId?: number | null;
    onRetryUpdate?: (nodeId: number) => void;
    onDismissUpdate?: (nodeId: number) => void;
    onCordonChange?: () => void;
}

// --- Sub-Components ---

function UsageBar({ percent, color }: { percent: number; color: string }) {
    return (
        <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
            <div
                className={`h-full rounded-full transition-all duration-500 ${color}`}
                style={{ width: `${Math.min(100, percent)}%` }}
            />
        </div>
    );
}

// --- Main Export ---

export function NodeCard({ node, onNavigate, labelMap, updateStatus, onUpdate, updatingNodeId, onRetryUpdate, onDismissUpdate, onCordonChange }: NodeCardProps) {
    const [expanded, setExpanded] = useState(false);
    const [stacks, setStacks] = useState<string[] | null>(node.stacks);
    const [loadingStacks, setLoadingStacks] = useState(false);
    const [cordonModalOpen, setCordonModalOpen] = useState(false);
    const [cordonReason, setCordonReason] = useState('');
    const [cordonSubmitting, setCordonSubmitting] = useState(false);

    const { isPaid, license } = useLicense();
    const isAdmiral = isPaid && license?.variant === 'admiral';

    const isOnline = node.status === 'online';
    const isLocal = node.type === 'local';
    const formattedVersion = formatVersion(updateStatus?.version);
    const formattedLatest = formatVersion(updateStatus?.latestVersion);
    const cpuPercent = getNodeCpu(node);
    const memPercent = getNodeMem(node);
    const diskPercent = getNodeDisk(node);

    const openCordonModal = () => {
        setCordonReason('');
        setCordonModalOpen(true);
    };

    const handleCordonConfirm = async () => {
        setCordonSubmitting(true);
        try {
            if (node.cordoned) {
                await uncordonNode(node.id);
                toast.success(`Uncordoned ${node.name}`);
            } else {
                await cordonNode(node.id, cordonReason.trim() || null);
                toast.success(`Cordoned ${node.name}`);
            }
            setCordonModalOpen(false);
            onCordonChange?.();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to update cordon state';
            toast.error(message);
        } finally {
            setCordonSubmitting(false);
        }
    };

    const handleExpand = async () => {
        const next = !expanded;
        setExpanded(next);

        if (next && stacks === null) {
            setLoadingStacks(true);
            try {
                const res = await apiFetch(`/fleet/node/${node.id}/stacks`, { localOnly: true });
                if (res.ok) {
                    setStacks(await res.json());
                } else {
                    toast.error('Failed to load stacks for ' + node.name);
                }
            } catch (error) {
                console.error('Failed to load stacks for', node.name, error);
                toast.error('Failed to load stacks for ' + node.name);
                setExpanded(false);
            } finally {
                setLoadingStacks(false);
            }
        }
    };

    const localRailClasses = isLocal
        ? 'relative overflow-hidden ring-1 ring-brand/30 before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-brand before:rounded-l-xl after:pointer-events-none after:absolute after:inset-0 after:bg-gradient-to-r after:from-brand/[0.06] after:via-transparent after:to-transparent'
        : '';

    return (
        <div className={`rounded-xl border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors hover:border-t-card-border-hover ${localRailClasses} ${isOnline ? '' : 'opacity-60'}`}>
            {/* Card Header */}
            <div className="relative p-4 pb-3">
                {isLocal && (
                    <span className={`absolute top-3 font-mono text-[9px] uppercase tracking-[0.22em] text-brand ${isAdmiral ? 'right-9' : 'right-3'}`}>
                        ★ Local
                    </span>
                )}
                {isAdmiral && (
                    <div className="absolute top-2 right-2">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    aria-label="Node actions"
                                    className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                                >
                                    <MoreVertical className="w-4 h-4" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem onSelect={openCordonModal}>
                                    <Ban className="w-3.5 h-3.5 mr-2" />
                                    {node.cordoned ? 'Uncordon node' : 'Cordon node'}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                )}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${isOnline ? 'bg-success-muted' : 'bg-muted'}`}>
                            <Server className={`w-4 h-4 ${isOnline ? 'text-success' : 'text-muted-foreground'}`} />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-sm font-medium truncate">{node.name}</h3>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                <Badge variant={isOnline ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                    {isOnline ? (
                                        <><Wifi className="w-2.5 h-2.5 mr-0.5" /> Online</>
                                    ) : (
                                        <><WifiOff className="w-2.5 h-2.5 mr-0.5" /> Offline</>
                                    )}
                                </Badge>
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                    {node.type}
                                </Badge>
                                {formattedVersion && (
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono tabular-nums shrink-0">
                                        {formattedVersion}
                                    </Badge>
                                )}
                                {updateStatus?.updateStatus && (
                                    <UpdateStatusBadge
                                        status={updateStatus.updateStatus}
                                        error={updateStatus.error}
                                        onRetry={onRetryUpdate ? () => onRetryUpdate(node.id) : undefined}
                                        onDismiss={onDismissUpdate ? () => onDismissUpdate(node.id) : undefined}
                                    />
                                )}
                                {updateStatus?.updateAvailable && !updateStatus.updateStatus && (
                                    <Badge className="text-[10px] px-1.5 py-0 h-4 bg-warning/15 text-warning border-warning/30 shrink-0">
                                        Update available
                                    </Badge>
                                )}
                                {isOnline && isCritical(node) && (
                                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                        <AlertTriangle className="w-2.5 h-2.5 mr-0.5" /> Critical
                                    </Badge>
                                )}
                                {node.cordoned && (
                                    <Badge
                                        variant="outline"
                                        className="text-[10px] px-1.5 py-0 h-4 shrink-0 bg-warning/15 text-warning border-warning/30"
                                        title={node.cordoned_reason ?? 'Unschedulable: new blueprint deployments skip this node'}
                                    >
                                        <Ban className="w-2.5 h-2.5 mr-0.5" /> Cordoned
                                    </Badge>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Container Stats */}
                {isOnline && node.stats && (
                    <div className="grid grid-cols-3 mb-3 rounded-md border border-card-border overflow-hidden">
                        <div className="border-r border-card-border bg-card px-2.5 py-2 text-center">
                            <div className="text-lg font-medium leading-none tabular-nums text-stat-value">{node.stats.active}</div>
                            <div className="text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-stat-subtitle mt-1">Running</div>
                        </div>
                        <div className="border-r border-card-border bg-card px-2.5 py-2 text-center">
                            <div className="text-lg font-medium leading-none tabular-nums text-stat-value">{node.stats.exited}</div>
                            <div className="text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-stat-subtitle mt-1">Stopped</div>
                        </div>
                        <div className="bg-card px-2.5 py-2 text-center">
                            <div className="text-lg font-medium leading-none tabular-nums text-stat-value">{node.stacks?.length ?? '-'}</div>
                            <div className="text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-stat-subtitle mt-1">Stacks</div>
                        </div>
                    </div>
                )}

                {/* Resource Usage Bars */}
                {isOnline && node.systemStats && (
                    <div className="space-y-2">
                        <div>
                            <div className="flex items-center justify-between text-xs mb-1">
                                <span className="flex items-center gap-1 text-muted-foreground">
                                    <Cpu className="w-3 h-3" /> CPU
                                </span>
                                <span className="font-medium">{node.systemStats.cpu.usage}%</span>
                            </div>
                            <UsageBar percent={cpuPercent} color={cpuPercent > 80 ? 'bg-destructive/80' : cpuPercent > 60 ? 'bg-warning' : 'bg-success'} />
                        </div>
                        <div>
                            <div className="flex items-center justify-between text-xs mb-1">
                                <span className="flex items-center gap-1 text-muted-foreground">
                                    <MemoryStick className="w-3 h-3" /> RAM
                                </span>
                                <span className="font-medium">{formatBytes(node.systemStats.memory.used, 1)} / {formatBytes(node.systemStats.memory.total, 1)}</span>
                            </div>
                            <UsageBar percent={memPercent} color={memPercent > 80 ? 'bg-destructive/80' : memPercent > 60 ? 'bg-warning' : 'bg-brand/60'} />
                        </div>
                        {node.systemStats.disk && (
                            <div>
                                <div className="flex items-center justify-between text-xs mb-1">
                                    <span className="flex items-center gap-1 text-muted-foreground">
                                        <HardDrive className="w-3 h-3" /> Disk
                                    </span>
                                    <span className="font-medium">{formatBytes(node.systemStats.disk.used, 1)} / {formatBytes(node.systemStats.disk.total, 1)}</span>
                                </div>
                                <UsageBar percent={diskPercent} color={diskPercent > 90 ? 'bg-destructive/80' : diskPercent > 75 ? 'bg-warning' : 'bg-brand'} />
                            </div>
                        )}
                    </div>
                )}

                {/* Update button */}
                {isOnline && updateStatus?.updateAvailable && !updateStatus.updateStatus && onUpdate && (
                    <div className="mt-3 pt-3 border-t border-border/50">
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full h-7 text-xs"
                            onClick={() => onUpdate(node.id)}
                            disabled={updatingNodeId === node.id}
                        >
                            {updatingNodeId === node.id ? (
                                <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Triggering...</>
                            ) : (
                                <><Download className="w-3 h-3 mr-1.5" strokeWidth={1.5} />{formattedLatest ? `Update to ${formattedLatest}` : 'Update'}</>
                            )}
                        </Button>
                    </div>
                )}

                {/* Offline placeholder */}
                {!isOnline && (
                    <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
                        Node unreachable
                    </div>
                )}
            </div>

            <ConfirmModal
                open={cordonModalOpen}
                onOpenChange={(open) => {
                    if (!cordonSubmitting) setCordonModalOpen(open);
                }}
                kicker="Federation"
                title={node.cordoned ? `Uncordon ${node.name}` : `Cordon ${node.name}`}
                description={node.cordoned
                    ? 'Re-enable this node for new blueprint placements. Existing deployments are unchanged.'
                    : 'Mark this node as unschedulable. New blueprint deployments will skip it. Existing deployments remain in place.'}
                confirmLabel={node.cordoned ? 'Uncordon node' : 'Cordon node'}
                confirming={cordonSubmitting}
                onConfirm={handleCordonConfirm}
            >
                {!node.cordoned && (
                    <div className="space-y-1.5">
                        <label htmlFor={`cordon-reason-${node.id}`} className="text-xs font-medium text-muted-foreground">
                            Reason (optional)
                        </label>
                        <input
                            id={`cordon-reason-${node.id}`}
                            type="text"
                            maxLength={256}
                            value={cordonReason}
                            onChange={(e) => setCordonReason(e.target.value)}
                            placeholder="e.g. draining for maintenance"
                            className="w-full h-8 px-2 text-sm rounded-md border border-input bg-background"
                            disabled={cordonSubmitting}
                        />
                    </div>
                )}
            </ConfirmModal>

            {/* Expandable Stack List with Container Drill-Down */}
            {isOnline && (
                <div className="border-t">
                    <button
                        onClick={handleExpand}
                        className="flex items-center gap-2 w-full px-4 py-2.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
                    >
                        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        <Layers className="w-3.5 h-3.5" />
                        Stack details
                        {stacks !== null && (
                            <span className="ml-auto text-[10px]">{stacks.length} stacks</span>
                        )}
                    </button>
                    {expanded && (
                        <div className="px-2 pb-3">
                            {loadingStacks ? (
                                <div className="space-y-2 px-2">
                                    <Skeleton className="h-6 w-full" />
                                    <Skeleton className="h-6 w-3/4" />
                                </div>
                            ) : stacks && stacks.length > 0 ? (
                                <div className="space-y-0.5">
                                    {stacks.map(stack => (
                                        <StackSection
                                            key={stack}
                                            stackName={stack}
                                            nodeId={node.id}
                                            onNavigate={onNavigate}
                                            labelMap={labelMap}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground py-1 px-2">No stacks found</p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

import { useState } from 'react';
import {
    Server, Cpu, MemoryStick, HardDrive, ChevronDown, ChevronRight,
    Layers, WifiOff, Ban,
    MoreVertical, Pencil, Trash2, Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BusyButton } from '@/components/ui/busy-button';
import { Skeleton } from '@/components/ui/skeleton';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NodeMuteSubmenu } from '@/components/mute/MuteMenuItems';
import { useNodeMuteActions } from '@/hooks/useMuteRuleActions';
import type { MuteRuleDraft } from '@/lib/muteRules';
import { cn, formatBytes } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { formatVersion } from '@/lib/version';
import type { StatusTone } from '@/lib/statusTone';
import { useAuth } from '@/context/AuthContext';
import { useNodes, type Node } from '@/context/NodeContext';
import { UpdateStatusBadge } from './UpdateStatusBadge';
import { StackSection } from './NodeCardStackList';
import { NodeCordonModal } from './NodeCordonModal';
import { useNodeVerbs } from './hooks/useNodeVerbs';
import { deriveNodeStatus, type NetworkingSignal } from './nodeStatus';
import { VERB_ICON } from './verbIcons';
import type { Label as StackLabel } from '../label-types';
import type { FleetNode, NodeUpdateStatus } from './types';
import { getNodeCpu, getNodeMem, getNodeMemUsed, getNodeMemTotal, getNodeDisk } from './nodeUtils';

// --- Types ---

export interface NodeCardProps {
    node: FleetNode;
    onNavigate: (nodeId: number, stackName: string) => void;
    /** GitOps applications needing attention that involve this node, if loaded. */
    gitopsAttention?: number;
    /** Which networking signals this node carries, if loaded. */
    networkingSignal?: NetworkingSignal;
    labelMap?: Record<string, StackLabel[]>;
    updateStatus?: NodeUpdateStatus;
    onUpdate?: (nodeId: number) => void;
    updatingNodeId?: number | null;
    onRetryUpdate?: (nodeId: number) => void;
    onDismissUpdate?: (nodeId: number) => void;
    onCordonChange?: () => void;
    onEdit?: (node: Node) => void;
    onDelete?: (node: Node) => void;
    onOpenMuteRulesWithPrefill?: (draft: MuteRuleDraft) => void;
    /** Switches to the node's Networking page. */
    onOpenNetworking?: (nodeId: number) => void;
    /** Runs after a connection test so the overview picks up the new state. */
    onTested?: () => void;
    /** Opens the Node details sheet. Available to any role that can see the card. */
    onOpenDetails?: (nodeId: number) => void;
}

/** Card chip colours per tone: tinted outline, never a solid fill. */
const CHIP_TONE: Record<StatusTone, string> = {
    destructive: 'bg-destructive/10 text-destructive border-destructive/30',
    warning: 'bg-warning/15 text-warning border-warning/30',
    brand: 'bg-brand/10 text-brand border-brand/30',
    neutral: 'bg-muted text-muted-foreground border-card-border/40',
    success: '',
};

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

export function NodeCard({ node, onNavigate, gitopsAttention, networkingSignal, labelMap, updateStatus, onUpdate, updatingNodeId, onRetryUpdate, onDismissUpdate, onCordonChange, onEdit, onDelete, onOpenMuteRulesWithPrefill, onOpenNetworking, onTested, onOpenDetails }: NodeCardProps) {
    const [expanded, setExpanded] = useState(false);
    const [stacks, setStacks] = useState<string[] | null>(node.stacks);
    const [loadingStacks, setLoadingStacks] = useState(false);
    const [cordonModalOpen, setCordonModalOpen] = useState(false);

    const { isAdmin, can } = useAuth();
    const { nodes: registryNodes } = useNodes();
    const registryNode = registryNodes.find(n => n.id === node.id);
    const isLastLocal = registryNode?.type === 'local' && registryNodes.filter(n => n.type === 'local').length <= 1;
    const canManageNode = can('node:manage', 'node', String(node.id));
    const canEdit = Boolean(canManageNode && onEdit && registryNode);
    const canDelete = Boolean(canManageNode && onDelete && registryNode && !registryNode.is_default && !isLastLocal);
    // Cordon is permission-gated only (node:manage), matching the backend route guard.
    const canCordon = canManageNode;
    const nodeMuteActions = useNodeMuteActions(
        node.id,
        node.name,
        onOpenMuteRulesWithPrefill ?? (() => {}),
    );
    // "Node details" is always available to anyone who can see the card (same
    // node:read gate that already governs Fleet card visibility), so the kebab
    // itself is no longer conditional. This flag now only decides whether the
    // manage items (which stay node:manage-gated) render below the separator.
    const hasManageMenuItems = canEdit || canDelete || canCordon || (nodeMuteActions.canMute && Boolean(onOpenMuteRulesWithPrefill));

    const isOnline = node.status === 'online';
    const isLocal = node.type === 'local';
    const isPilot = (registryNode?.mode ?? node.mode) === 'pilot_agent';
    const status = deriveNodeStatus({ node, isPilot, updateStatus, gitopsAttention, networking: networkingSignal });
    const { answer } = status;
    const hasReadings = isOnline && (node.stats !== null || node.systemStats !== null);
    const verbs = useNodeVerbs({
        node,
        handlers: { onUpdate, updatingNodeId, onRetryUpdate, onOpenNetworking, onTested },
        openCordon: () => setCordonModalOpen(true),
    });
    // An update record (running, failed, just finished) keeps its own badge with
    // Retry and Dismiss, even when a louder state such as Offline is the chip.
    // When the update is itself the Answer the badge IS the chip, and its verb is
    // not repeated as a button.
    const updateIsAnswer = answer.kind === 'update-failed' || answer.kind === 'updating';
    const verb = answer.verb && answer.verb.id !== 'retry-update' && verbs.isAllowed(answer.verb) ? answer.verb : null;
    const VerbIcon = verb ? VERB_ICON[verb.id] : null;
    const formattedVersion = formatVersion(updateStatus?.version);
    const cpuPercent = getNodeCpu(node);
    const memPercent = getNodeMem(node);
    const memUsed = getNodeMemUsed(node);
    const memTotal = getNodeMemTotal(node);
    const diskPercent = getNodeDisk(node);

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

    const verbButton = verb && VerbIcon ? (
        verb.id === 'update-dev' ? (
            <BusyButton
                size="sm"
                className="w-full h-7 text-xs bg-brand text-brand-foreground hover:bg-brand/90 border-0"
                onClick={() => verbs.run(verb)}
                pending={verbs.isPending(verb)}
                busyLabel="Triggering..."
            >
                <VerbIcon className="w-3 h-3 mr-1.5" strokeWidth={1.5} />{verb.label}
            </BusyButton>
        ) : (
            <BusyButton
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => verbs.run(verb)}
                pending={verbs.isPending(verb)}
                busyLabel={verb.id === 'test-connection' ? 'Testing...' : 'Triggering...'}
            >
                <VerbIcon className="w-3 h-3 mr-1.5" strokeWidth={1.5} />{verb.label}
            </BusyButton>
        )
    ) : null;

    return (
        <div className={`rounded-xl border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors hover:border-t-card-border-hover ${localRailClasses}`}>
            {/* Card Header */}
            <div className="relative p-4 pb-3">
                {isLocal ? (
                    <span className="absolute top-3 right-9 font-mono text-[9px] uppercase tracking-[0.22em] text-brand">
                        ★ Local
                    </span>
                ) : (
                    <span
                        className="absolute top-3 right-9 font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground"
                        title={isPilot ? 'Pilot agent: this node connects out to the control instance over a tunnel' : 'Proxy: the control instance reaches this node over its API'}
                    >
                        {isPilot ? 'Pilot' : 'Proxy'}
                    </span>
                )}
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
                            {onOpenDetails && (
                                <DropdownMenuItem onSelect={() => onOpenDetails(node.id)}>
                                    <Info className="w-3.5 h-3.5 mr-2" />
                                    Node details
                                </DropdownMenuItem>
                            )}
                            {onOpenDetails && hasManageMenuItems && <DropdownMenuSeparator />}
                            {canEdit && registryNode && (
                                <DropdownMenuItem onSelect={() => onEdit!(registryNode)}>
                                    <Pencil className="w-3.5 h-3.5 mr-2" />
                                    Edit node
                                </DropdownMenuItem>
                            )}
                            {canDelete && registryNode && (
                                <DropdownMenuItem
                                    onSelect={() => onDelete!(registryNode)}
                                    className="text-destructive focus:text-destructive"
                                >
                                    <Trash2 className="w-3.5 h-3.5 mr-2" />
                                    Delete node
                                </DropdownMenuItem>
                            )}
                            {canCordon && (
                                <DropdownMenuItem onSelect={() => setCordonModalOpen(true)}>
                                    <Ban className="w-3.5 h-3.5 mr-2" />
                                    {node.cordoned ? 'Uncordon node' : 'Cordon node'}
                                </DropdownMenuItem>
                            )}
                            {onOpenMuteRulesWithPrefill && <NodeMuteSubmenu actions={nodeMuteActions} />}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${isOnline ? 'bg-success-muted' : 'bg-muted'}`}>
                            <Server className={`w-4 h-4 ${isOnline ? 'text-success' : 'text-muted-foreground'}`} />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-sm font-medium truncate">{node.name}</h3>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                {formattedVersion && (
                                    <span className="font-mono text-[10px] tabular-nums text-stat-subtitle">
                                        {formattedVersion}{updateStatus?.isDevImage ? ' · integration' : ''}
                                    </span>
                                )}
                                {answer.kind !== 'healthy' && !updateIsAnswer && (
                                    <Badge
                                        variant="outline"
                                        className={cn('text-[10px] px-1.5 py-0 h-4 shrink-0', CHIP_TONE[answer.tone])}
                                        title={answer.line}
                                    >
                                        {answer.kind === 'offline' && <WifiOff className="w-2.5 h-2.5 mr-0.5" />}
                                        {answer.title}
                                    </Badge>
                                )}
                                {updateStatus?.updateStatus && (
                                    <UpdateStatusBadge
                                        status={updateStatus.updateStatus}
                                        error={updateStatus.error}
                                        onRetry={isAdmin && onRetryUpdate ? () => onRetryUpdate(node.id) : undefined}
                                        onDismiss={isAdmin && onDismissUpdate ? () => onDismissUpdate(node.id) : undefined}
                                    />
                                )}
                                {status.otherCount > 0 && onOpenDetails && (
                                    <button
                                        type="button"
                                        className="rounded-sm px-1 font-mono text-[10px] text-stat-subtitle hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                                        title={`${status.otherCount} more: ${status.conditions.slice(1).map(c => c.title).join(', ')}`}
                                        aria-label={`+${status.otherCount} more states: ${status.conditions.slice(1).map(c => c.title).join(', ')}. Open node details`}
                                        onClick={() => onOpenDetails(node.id)}
                                    >
                                        +{status.otherCount}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Container Stats */}
                {hasReadings && node.stats && (
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
                {hasReadings && node.systemStats && (
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
                                <span className="font-medium">{formatBytes(memUsed, 1)} / {formatBytes(memTotal, 1)}</span>
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

                {/* No readings: say why, once, and offer the one verb that helps */}
                {!hasReadings && (
                    <div className="space-y-3 pt-1">
                        <p className="text-sm text-muted-foreground text-center">{answer.line}</p>
                        {verbButton}
                    </div>
                )}

                {/* The Answer's resolving verb (mutating actions are gated by the session's permission) */}
                {hasReadings && verbButton && (
                    <div className="mt-3 pt-3 border-t border-border/50">{verbButton}</div>
                )}
            </div>

            <NodeCordonModal
                node={node}
                open={cordonModalOpen}
                onOpenChange={setCordonModalOpen}
                onChanged={onCordonChange}
            />

            {/* Expandable Stack List with Container Drill-Down */}
            {hasReadings && (
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
                                            labelMap={labelMap ?? {}}
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

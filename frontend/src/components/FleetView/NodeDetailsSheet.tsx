import { useEffect, useState, type ReactNode } from 'react';
import { Cpu, MemoryStick, HardDrive, Globe, Monitor, Terminal, Ban, Pencil, KeyRound, Network } from 'lucide-react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { NodeLabelPicker } from '@/components/blueprints/NodeLabelPicker';
import { useNodes, type Node } from '@/context/NodeContext';
import { formatVersion } from '@/lib/version';
import { formatTimeAgo } from '@/lib/relativeTime';
import { formatBytes } from '@/lib/utils';
import { PinnedUpdateBadge } from './PinnedUpdateBadge';
import type { FleetNode, NodeUpdateStatus } from './types';

interface NodeDetailsSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    node: FleetNode | null;
    registryNode: Node | null;
    updateStatus?: NodeUpdateStatus;
    networkingSignal?: { exposed: boolean; unknown: boolean; drift: boolean };
    canManageNode: boolean;
    onOpenNetworking?: (nodeId: number) => void;
    onEdit?: (node: Node) => void;
}

// A small nice-to-have translation for the most operator-relevant capability
// strings; anything not listed here just renders its raw identifier.
const CAPABILITY_LABELS: Partial<Record<string, string>> = {
    'cross-node-rbac': 'Cross-node RBAC',
    'self-update': 'Self-update',
    'fleet': 'Fleet management',
    'compose-networking': 'Networking inventory',
};

function formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleString();
}

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

function Field({ label, children, span }: { label: string; children: ReactNode; span?: 1 | 2 }) {
    return (
        <div className={span === 2 ? 'col-span-2' : undefined}>
            <span className="text-xs text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

export function NodeDetailsSheet({
    open, onOpenChange, node, registryNode, updateStatus, networkingSignal,
    canManageNode, onOpenNetworking, onEdit,
}: NodeDetailsSheetProps) {
    const { nodeMeta, refreshNodeMeta } = useNodes();
    const [capabilitiesExpanded, setCapabilitiesExpanded] = useState(false);
    const nodeId = node?.id ?? null;

    useEffect(() => {
        if (open && nodeId !== null) void refreshNodeMeta(nodeId);
    }, [open, nodeId, refreshNodeMeta]);

    useEffect(() => {
        if (!open) setCapabilitiesExpanded(false);
    }, [open]);

    if (!node) return null;

    const meta = nodeMeta.get(node.id) ?? null;
    const isLocal = node.type === 'local';
    const isPilot = registryNode?.mode === 'pilot_agent';
    const connectionModeLabel = isLocal ? 'Local' : isPilot ? 'Pilot Agent' : 'API Proxy';
    const versionLabel = formatVersion(updateStatus?.version ?? meta?.version ?? null);
    const cpuPercent = node.systemStats ? parseFloat(node.systemStats.cpu.usage) : 0;
    const memPercent = node.systemStats ? parseFloat(node.systemStats.memory.usagePercent) : 0;
    const diskPercent = node.systemStats?.disk ? parseFloat(node.systemStats.disk.usagePercent) : 0;
    const hasNetworkingSignal = Boolean(
        networkingSignal && (networkingSignal.exposed || networkingSignal.unknown || networkingSignal.drift),
    );

    const metaLine = [
        connectionModeLabel,
        node.status === 'online' ? 'Online' : node.status === 'offline' ? 'Offline' : 'Unknown',
        versionLabel,
        node.stacks ? `${node.stacks.length} stack${node.stacks.length === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');

    const footerContext = node.status === 'online'
        ? 'Live · refreshes with the fleet overview'
        : node.last_successful_contact
            ? `Last seen ${formatTimeAgo(node.last_successful_contact)}`
            : 'Never contacted';

    return (
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Fleet', 'Node', node.name]}
            name={node.name}
            meta={metaLine}
            primaryAction={canManageNode && onEdit && registryNode ? {
                label: 'Edit node',
                icon: Pencil,
                onClick: () => onEdit(registryNode),
            } : undefined}
            secondaryActions={onOpenNetworking && hasNetworkingSignal ? [{
                label: 'View networking',
                icon: Network,
                onClick: () => onOpenNetworking(node.id),
            }] : undefined}
            footerContext={footerContext}
            size="md"
        >
            <SheetSection title="Connectivity">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <Field label="Connection mode">
                        <p className="text-xs mt-0.5 flex items-center gap-1.5">
                            {isLocal ? <Monitor className="w-3 h-3" strokeWidth={1.5} /> : isPilot ? <Terminal className="w-3 h-3" strokeWidth={1.5} /> : <Globe className="w-3 h-3" strokeWidth={1.5} />}
                            {connectionModeLabel}
                        </p>
                    </Field>
                    <Field label="Management endpoint">
                        <p className="font-mono text-xs mt-0.5 break-all">
                            {isLocal
                                ? 'docker.sock'
                                : isPilot
                                    ? (registryNode?.pilot_last_seen ? `Tunnel (seen ${formatTimeAgo(registryNode.pilot_last_seen)})` : 'Tunnel (waiting)')
                                    : (registryNode?.api_url || '-')}
                        </p>
                    </Field>
                    {typeof node.latency_ms === 'number' && (
                        <Field label="Latency">
                            <p className="font-mono text-xs mt-0.5 tabular-nums">{node.latency_ms} ms</p>
                        </Field>
                    )}
                    <Field label="Last successful contact">
                        <p className="text-xs mt-0.5" title={node.last_successful_contact ? formatTimestamp(node.last_successful_contact) : undefined}>
                            {node.last_successful_contact ? formatTimeAgo(node.last_successful_contact) : 'Never'}
                        </p>
                    </Field>
                    {isPilot && (
                        <>
                            <Field label="Pilot heartbeat">
                                <p className="text-xs mt-0.5">
                                    {node.pilot_last_seen ? formatTimeAgo(node.pilot_last_seen) : 'Never'}
                                </p>
                            </Field>
                            <Field label="Pilot Agent version">
                                <p className="font-mono text-xs mt-0.5">{formatVersion(registryNode?.pilot_agent_version) ?? 'Unknown'}</p>
                            </Field>
                        </>
                    )}
                    <Field label="Token configured">
                        <p className="text-xs mt-0.5">
                            <Badge variant="outline" className="text-[10px] h-5 gap-1">
                                <KeyRound className="w-2.5 h-2.5" strokeWidth={1.5} />
                                {registryNode?.has_token ? 'Yes' : 'No'}
                            </Badge>
                        </p>
                    </Field>
                </div>
            </SheetSection>

            <SheetSection title="Capacity">
                {node.systemStats ? (
                    <div className="space-y-2">
                        <div>
                            <div className="flex items-center justify-between text-xs mb-1">
                                <span className="flex items-center gap-1 text-muted-foreground">
                                    <Cpu className="w-3 h-3" /> CPU · {node.systemStats.cpu.cores} cores
                                </span>
                                <span className="font-medium">{node.systemStats.cpu.usage}%</span>
                            </div>
                            <UsageBar percent={cpuPercent} color={cpuPercent > 80 ? 'bg-destructive/80' : cpuPercent > 60 ? 'bg-warning' : 'bg-success'} />
                        </div>
                        <div>
                            <div className="flex items-center justify-between text-xs mb-1">
                                <span className="flex items-center gap-1 text-muted-foreground">
                                    <MemoryStick className="w-3 h-3" /> Memory
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
                ) : (
                    <p className="text-xs text-muted-foreground italic">Unavailable while the node is offline.</p>
                )}
            </SheetSection>

            <SheetSection title={`Compose workload · ${node.stacks?.length ?? 0} stacks`}>
                {node.stats ? (
                    <div className="grid grid-cols-4 rounded-md border border-card-border overflow-hidden text-center mb-2">
                        <div className="border-r border-card-border bg-card px-2 py-2">
                            <div className="text-base font-medium leading-none tabular-nums text-stat-value">{node.stats.active}</div>
                            <div className="text-[9px] leading-3 font-mono uppercase tracking-[0.16em] text-stat-subtitle mt-1">Running</div>
                        </div>
                        <div className="border-r border-card-border bg-card px-2 py-2">
                            <div className="text-base font-medium leading-none tabular-nums text-stat-value">{node.stats.exited}</div>
                            <div className="text-[9px] leading-3 font-mono uppercase tracking-[0.16em] text-stat-subtitle mt-1">Stopped</div>
                        </div>
                        <div className="border-r border-card-border bg-card px-2 py-2">
                            <div className="text-base font-medium leading-none tabular-nums text-stat-value">{node.stats.managed}</div>
                            <div className="text-[9px] leading-3 font-mono uppercase tracking-[0.16em] text-stat-subtitle mt-1">Managed</div>
                        </div>
                        <div className="bg-card px-2 py-2">
                            <div className="text-base font-medium leading-none tabular-nums text-stat-value">{node.stats.unmanaged}</div>
                            <div className="text-[9px] leading-3 font-mono uppercase tracking-[0.16em] text-stat-subtitle mt-1">Unmanaged</div>
                        </div>
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground italic">Unavailable while the node is offline.</p>
                )}
                {onOpenNetworking && hasNetworkingSignal && networkingSignal && (
                    <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 h-5 cursor-pointer bg-warning/10 text-warning border-warning/30 hover:bg-warning/20"
                        onClick={() => onOpenNetworking(node.id)}
                    >
                        Networking · {networkingSignal.drift ? 'drift' : networkingSignal.exposed ? 'exposed' : 'unknown exposure'}
                    </Badge>
                )}
            </SheetSection>

            <SheetSection title="Compatibility">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-3">
                    <Field label="Sencho version">
                        <p className="font-mono text-xs mt-0.5">{versionLabel ?? 'Unknown'}</p>
                    </Field>
                    <Field label="Image channel">
                        <p className="text-xs mt-0.5 capitalize">{updateStatus?.imageChannel ?? 'Unknown'}</p>
                    </Field>
                    <Field label="Pin type">
                        <p className="text-xs mt-0.5 capitalize">{updateStatus?.imagePinKind ?? 'Unknown'}</p>
                    </Field>
                    <Field label="Update status">
                        <p className="text-xs mt-0.5">
                            {updateStatus?.updateBlocked ? (
                                <PinnedUpdateBadge reason={updateStatus.updateBlockedReason} className="text-[10px] px-1.5 py-0 h-5" />
                            ) : updateStatus?.updateAvailable ? (
                                <Badge className="text-[10px] px-1.5 py-0 h-5 bg-warning/15 text-warning border-warning/30">Update available</Badge>
                            ) : (
                                <Badge className="text-[10px] px-1.5 py-0 h-5 bg-success-muted text-success border-success/30">Up to date</Badge>
                            )}
                        </p>
                    </Field>
                </div>
                {meta ? (
                    <div>
                        <button
                            type="button"
                            onClick={() => setCapabilitiesExpanded(v => !v)}
                            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
                        >
                            {meta.capabilities.length} capabilities advertised {capabilitiesExpanded ? '(hide)' : '(show)'}
                        </button>
                        {capabilitiesExpanded && (
                            <ul className="mt-2 flex flex-wrap gap-1">
                                {meta.capabilities.map(c => (
                                    <li key={c}>
                                        <Badge variant="outline" className="text-[10px] h-5 font-mono">{CAPABILITY_LABELS[c] ?? c}</Badge>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                ) : (
                    <Skeleton className="h-4 w-40" />
                )}
            </SheetSection>

            <SheetSection title="Governance">
                <div className="space-y-3">
                    <div>
                        <span className="text-xs text-muted-foreground">Labels</span>
                        <div className="mt-1">
                            <NodeLabelPicker nodeId={node.id} canEdit={canManageNode} />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Field label="Cordon status">
                            <p className="text-xs mt-0.5">
                                {node.cordoned ? (
                                    <Badge variant="outline" className="text-[10px] h-5 gap-1 bg-warning/15 text-warning border-warning/30">
                                        <Ban className="w-2.5 h-2.5" strokeWidth={1.5} /> Cordoned
                                    </Badge>
                                ) : (
                                    <span className="text-muted-foreground">Schedulable</span>
                                )}
                            </p>
                        </Field>
                        {node.cordoned && (
                            <>
                                <Field label="Cordoned since">
                                    <p className="text-xs mt-0.5">{node.cordoned_at ? formatTimestamp(node.cordoned_at) : 'Unknown'}</p>
                                </Field>
                                <Field label="Reason" span={2}>
                                    <p className="text-xs mt-0.5">{node.cordoned_reason ?? 'No reason given'}</p>
                                </Field>
                            </>
                        )}
                        <Field label="Default node">
                            <p className="text-xs mt-0.5">{registryNode?.is_default ? 'Yes' : 'No'}</p>
                        </Field>
                        <Field label="Compose directory">
                            <p className="font-mono text-xs mt-0.5 break-all">{registryNode?.compose_dir ?? '-'}</p>
                        </Field>
                        <Field label="Registered" span={2}>
                            <p className="text-xs mt-0.5">{registryNode?.created_at ? formatTimestamp(registryNode.created_at) : 'Unknown'}</p>
                        </Field>
                    </div>
                </div>
            </SheetSection>
        </SystemSheet>
    );
}

import { useEffect, useState, type ReactNode } from 'react';
import { Cpu, MemoryStick, HardDrive, Pencil, Ban, X } from 'lucide-react';
import { SystemSheet, SheetSection, type SystemSheetAction } from '@/components/ui/system-sheet';
import { StatusPath, type StatusPathStage } from '@/components/ui/status-path';
import { BusyButton } from '@/components/ui/busy-button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { NodeLabelPicker } from '@/components/blueprints/NodeLabelPicker';
import { useAuth } from '@/context/AuthContext';
import { useNodes, type Node } from '@/context/NodeContext';
import { formatVersion } from '@/lib/version';
import { formatTimeAgo } from '@/lib/relativeTime';
import { formatBytes } from '@/lib/utils';
import { NodeCordonModal } from './NodeCordonModal';
import { useNodeVerbs, type NodeVerbHandlers } from './hooks/useNodeVerbs';
import { deriveNodeStatus, type NetworkingSignal } from './nodeStatus';
import { VERB_ICON } from './verbIcons';
import type { FleetNode, NodeUpdateStatus } from './types';

/** Everything the sheet can do for a node: the shared verbs plus the object-level actions. */
export interface NodeSheetHandlers extends NodeVerbHandlers {
    onDismissUpdate?: (nodeId: number) => void;
    onCordonChange?: () => void;
    onEdit?: (node: Node) => void;
    onDelete?: (node: Node) => void;
}

interface NodeDetailsSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    node: FleetNode | null;
    registryNode: Node | null;
    updateStatus?: NodeUpdateStatus;
    networkingSignal?: NetworkingSignal;
    gitopsAttention?: number;
    handlers: NodeSheetHandlers;
}

type SheetTab = 'overview' | 'resources' | 'settings';

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

// `FleetNode.last_successful_contact` and `FleetNode.pilot_last_seen` come from
// the fleet-overview endpoint in Unix SECONDS (DatabaseService.updateNodeLastContact
// writes Math.floor(Date.now()/1000); fleet.ts's pilotLastSeenSeconds() divides the
// millisecond DB value by 1000 for this same response). `formatTimeAgo`/`formatTimestamp`
// both expect milliseconds, so any FleetNode-sourced timestamp must convert here before
// use. `registryNode`-sourced timestamps (e.g. pilot_last_seen from /api/nodes) are
// already in milliseconds and must NOT be passed through this helper.
function fleetSecondsToMs(seconds: number): number {
    return seconds * 1000;
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

/**
 * The Fleet node sheet. The body is keyed by node, so switching nodes (or a
 * deep link landing on another one) starts on Overview with a fresh action state.
 */
export function NodeDetailsSheet(props: NodeDetailsSheetProps) {
    if (!props.node) return null;
    return <NodeDetailsSheetBody key={props.node.id} {...props} node={props.node} />;
}

function NodeDetailsSheetBody({
    open, onOpenChange, node, registryNode, updateStatus, networkingSignal, gitopsAttention, handlers,
}: NodeDetailsSheetProps & { node: FleetNode }) {
    const { isAdmin } = useAuth();
    const { nodes: registryNodes, nodeMeta, refreshNodeMeta } = useNodes();
    const [capabilitiesExpanded, setCapabilitiesExpanded] = useState(false);
    const [cordonOpen, setCordonOpen] = useState(false);
    const [tab, setTab] = useState<SheetTab>('overview');
    const nodeId = node.id;

    useEffect(() => {
        if (open) void refreshNodeMeta(nodeId);
    }, [open, nodeId, refreshNodeMeta]);

    const verbs = useNodeVerbs({
        node,
        handlers,
        openCordon: () => setCordonOpen(true),
    });

    const meta = nodeMeta.get(node.id) ?? null;
    const isLocal = node.type === 'local';
    // Same expression as the card, so the two read the connection mode alike.
    const isPilot = (registryNode?.mode ?? node.mode) === 'pilot_agent';
    const connectionModeLabel = isLocal ? 'Local' : isPilot ? 'Pilot Agent' : 'API Proxy';
    const versionLabel = formatVersion(updateStatus?.version ?? meta?.version ?? null);
    const status = deriveNodeStatus({ node, isPilot, updateStatus, gitopsAttention, networking: networkingSignal });
    const { answer } = status;
    const hasReadings = node.status === 'online' && (node.stats !== null || node.systemStats !== null);
    const cpuPercent = node.systemStats ? parseFloat(node.systemStats.cpu.usage) : 0;
    const memPercent = node.systemStats ? parseFloat(node.systemStats.memory.usagePercent) : 0;
    const diskPercent = node.systemStats?.disk ? parseFloat(node.systemStats.disk.usagePercent) : 0;

    const tabs = [
        { id: 'overview', label: 'Overview' },
        ...(hasReadings ? [{ id: 'resources', label: 'Resources' }] : []),
        { id: 'settings', label: 'Settings' },
    ];
    const activeTab: SheetTab = tabs.some(t => t.id === tab) ? tab : 'overview';

    const handleOpenChange = (next: boolean) => {
        if (!next) {
            setTab('overview');
            setCapabilitiesExpanded(false);
        }
        onOpenChange(next);
    };

    // Structural summary only: the Answer carries the state, so the meta line does not.
    const metaLine = [
        connectionModeLabel,
        versionLabel,
        node.stacks ? `${node.stacks.length} stack${node.stacks.length === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');

    const footerContext = node.status === 'online'
        ? 'Live · refreshes with the fleet overview'
        : node.last_successful_contact
            ? `Last seen ${formatTimeAgo(fleetSecondsToMs(node.last_successful_contact))}`
            : 'Never contacted';

    const isLastLocal = registryNode?.type === 'local' && registryNodes.filter(n => n.type === 'local').length <= 1;
    const canDelete = Boolean(verbs.canManage && handlers.onDelete && registryNode && !registryNode.is_default && !isLastLocal);
    // Uncordon lives in the toolbar (it is the object-level cordon toggle), so the Answer does not repeat it.
    const verb = answer.verb && answer.verb.id !== 'uncordon' && verbs.isAllowed(answer.verb) ? answer.verb : null;

    // Toolbar: the object-level cordon toggle, then the verbs of every other
    // condition (the Answer speaks for its own), then Dismiss for a failed update.
    const secondaryActions: SystemSheetAction[] = [];
    if (verbs.canManage) {
        secondaryActions.push({
            label: node.cordoned ? 'Uncordon node' : 'Cordon node',
            icon: Ban,
            onClick: () => setCordonOpen(true),
        });
    }
    for (const condition of status.conditions.slice(1)) {
        const v = condition.verb;
        if (!v || v.id === 'uncordon' || !verbs.isAllowed(v)) continue;
        secondaryActions.push({ label: v.label, icon: VERB_ICON[v.id], onClick: () => verbs.run(v), pending: verbs.isPending(v) });
    }
    if (status.conditions.some(c => c.kind === 'update-failed') && isAdmin && handlers.onDismissUpdate) {
        secondaryActions.push({ label: 'Dismiss update', icon: X, onClick: () => handlers.onDismissUpdate?.(node.id) });
    }

    const stages: StatusPathStage[] = status.stages.map(stage => ({
        id: stage.id, label: stage.label, tone: stage.tone, word: stage.word, line: stage.line,
    }));

    const VerbIcon = verb ? VERB_ICON[verb.id] : null;
    const answerAction = verb && VerbIcon ? (
        <BusyButton
            variant="outline"
            size="sm"
            className="h-7 text-xs max-md:min-h-11"
            onClick={() => verbs.run(verb)}
            pending={verbs.isPending(verb)}
            busyLabel={verb.id === 'test-connection' ? 'Testing...' : 'Working...'}
        >
            <VerbIcon className="w-3 h-3 mr-1.5" strokeWidth={1.5} />{verb.label}
        </BusyButton>
    ) : undefined;

    return (
        <>
            <SystemSheet
                open={open}
                onOpenChange={handleOpenChange}
                crumb={['Fleet', 'Node', node.name]}
                name={node.name}
                meta={metaLine}
                primaryAction={verbs.canManage && handlers.onEdit && registryNode ? {
                    label: 'Edit node',
                    icon: Pencil,
                    onClick: () => handlers.onEdit?.(registryNode),
                } : undefined}
                secondaryActions={secondaryActions.length > 0 ? secondaryActions : undefined}
                destructiveAction={canDelete && registryNode ? {
                    label: 'Delete node',
                    onClick: () => handlers.onDelete?.(registryNode),
                } : undefined}
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={(id) => setTab(id as SheetTab)}
                footerContext={footerContext}
                size="md"
            >
                {activeTab === 'overview' && (
                    <StatusPath
                        data-testid="node-status"
                        answer={{
                            tone: answer.tone,
                            title: answer.title,
                            line: answer.line,
                            status: answer.kind,
                            action: answerAction,
                        }}
                        stages={stages}
                        proof={{
                            label: 'Details',
                            children: (
                                <div className="space-y-4">
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                        <Field label="Management endpoint">
                                            <p className="font-mono text-xs mt-0.5 break-all">
                                                {isLocal
                                                    ? 'docker.sock'
                                                    : isPilot
                                                        ? 'Tunnel'
                                                        : (registryNode?.api_url || '-')}
                                            </p>
                                        </Field>
                                        {hasReadings && typeof node.latency_ms === 'number' && (
                                            <Field label="Latency">
                                                <p className="font-mono text-xs mt-0.5 tabular-nums">{node.latency_ms} ms</p>
                                            </Field>
                                        )}
                                        {!isLocal && (
                                            <Field label="Last successful contact">
                                                <p className="text-xs mt-0.5" title={node.last_successful_contact ? formatTimestamp(fleetSecondsToMs(node.last_successful_contact)) : undefined}>
                                                    {node.last_successful_contact ? formatTimeAgo(fleetSecondsToMs(node.last_successful_contact)) : 'Never'}
                                                </p>
                                            </Field>
                                        )}
                                        {isPilot && (
                                            <>
                                                <Field label="Last connected">
                                                    <p className="text-xs mt-0.5">
                                                        {node.pilot_last_seen ? formatTimeAgo(fleetSecondsToMs(node.pilot_last_seen)) : 'Never'}
                                                    </p>
                                                </Field>
                                                <Field label="Pilot Agent version">
                                                    <p className="font-mono text-xs mt-0.5">{formatVersion(registryNode?.pilot_agent_version) ?? 'Unknown'}</p>
                                                </Field>
                                            </>
                                        )}
                                        <Field label="Token configured">
                                            <p className="text-xs mt-0.5">{registryNode?.has_token ? 'Yes' : 'No'}</p>
                                        </Field>
                                        <Field label="Image channel">
                                            <p className="text-xs mt-0.5 capitalize">{updateStatus?.imageChannel ?? 'Unknown'}</p>
                                        </Field>
                                        <Field label="Pin type">
                                            <p className="text-xs mt-0.5 capitalize">{updateStatus?.imagePinKind ?? 'Unknown'}</p>
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
                                    ) : hasReadings ? (
                                        <Skeleton className="h-4 w-40" />
                                    ) : null}
                                </div>
                            ),
                        }}
                    />
                )}

                {activeTab === 'resources' && node.systemStats && (
                    <SheetSection title={`CPU · memory · disk`}>
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
                    </SheetSection>
                )}
                {activeTab === 'resources' && node.stats && (
                    <SheetSection title={`Compose workload · ${node.stacks?.length ?? 0} stacks`}>
                        <div className="grid grid-cols-4 rounded-md border border-card-border overflow-hidden text-center">
                            {([
                                ['Running', node.stats.active],
                                ['Stopped', node.stats.exited],
                                ['Managed', node.stats.managed],
                                ['Unmanaged', node.stats.unmanaged],
                            ] as const).map(([label, value], i) => (
                                <div key={label} className={`bg-card px-2 py-2 ${i < 3 ? 'border-r border-card-border' : ''}`}>
                                    <div className="text-base font-medium leading-none tabular-nums text-stat-value">{value}</div>
                                    <div className="text-[9px] leading-3 font-mono uppercase tracking-[0.16em] text-stat-subtitle mt-1">{label}</div>
                                </div>
                            ))}
                        </div>
                    </SheetSection>
                )}

                {activeTab === 'settings' && (
                    <>
                        <SheetSection title="Labels">
                            <NodeLabelPicker nodeId={node.id} canEdit={verbs.canManage} />
                        </SheetSection>
                        <SheetSection title="Configuration">
                            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                <Field label="Scheduling">
                                    <p className="text-xs mt-0.5">{node.cordoned ? 'Cordoned' : 'Schedulable'}</p>
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
                        </SheetSection>
                    </>
                )}
            </SystemSheet>

            <NodeCordonModal
                node={node}
                open={cordonOpen}
                onOpenChange={setCordonOpen}
                onChanged={handlers.onCordonChange}
            />
        </>
    );
}

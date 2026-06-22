import { useState } from 'react';
import {
    ChevronsUpDown,
    Star,
    Settings2,
    CircleDashed,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useNodes, type Node, type NodeMode } from '@/context/NodeContext';
import { formatTimeAgo } from '@/lib/relativeTime';
import { isValidVersion } from '@/lib/version';

interface NodeSwitcherProps {
    onManageNodes: () => void;
    /** One-line chip for the mobile Stacks masthead kicker (node name + chevron),
     *  instead of the full bordered card. */
    compact?: boolean;
}

function dotClass(status: Node['status']): string {
    if (status === 'online') {
        return 'bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success)_20%,transparent)]';
    }
    if (status === 'offline') return 'bg-destructive';
    return 'bg-muted-foreground/40';
}

function typeLabel(type: Node['type'], mode: NodeMode | undefined): string {
    if (type === 'local') return 'Local';
    if (mode === 'pilot_agent') return 'Agent';
    return 'Remote';
}

export function NodeSwitcher({ onManageNodes, compact = false }: NodeSwitcherProps) {
    const { nodes, activeNode, setActiveNode, nodeMeta, isLoading } = useNodes();
    const [open, setOpen] = useState(false);

    const hasNodes = nodes.length > 0;
    const hasMultiple = nodes.length > 1;
    const kickerType = activeNode
        ? typeLabel(activeNode.type, activeNode.mode).toUpperCase()
        : hasNodes
            ? 'UNKNOWN'
            : 'LOADING';

    const triggerContent = (
        <div
            className={cn(
                'flex w-full items-center gap-3 rounded-md border border-card-border/60 bg-card/40 px-3.5 py-2.5 text-left transition-colors',
                hasMultiple && 'cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                !hasMultiple && 'cursor-default',
            )}
        >
            {activeNode ? (
                <span
                    aria-hidden
                    className={cn('h-2 w-2 flex-shrink-0 rounded-full', dotClass(activeNode.status))}
                />
            ) : (
                <CircleDashed
                    className="h-3 w-3 flex-shrink-0 text-stat-icon"
                    strokeWidth={1.5}
                    aria-hidden
                />
            )}
            <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                    Node · {kickerType}
                </div>
                <div className="mt-0.5 truncate font-sans text-sm leading-none text-stat-value">
                    {activeNode?.name ?? (isLoading ? '—' : 'No node')}
                </div>
            </div>
            {hasMultiple ? (
                <ChevronsUpDown
                    className="h-3.5 w-3.5 flex-shrink-0 text-stat-icon"
                    strokeWidth={1.5}
                    aria-hidden
                />
            ) : null}
        </div>
    );

    const compactTrigger = (
        <span className="inline-flex max-w-[55vw] items-center gap-1.5">
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                {activeNode?.name ?? (isLoading ? '…' : 'No node')}
            </span>
            {hasMultiple ? <ChevronsUpDown className="h-3 w-3 flex-shrink-0 text-stat-icon" strokeWidth={1.5} aria-hidden /> : null}
        </span>
    );
    const trigger = compact ? compactTrigger : triggerContent;

    if (!hasMultiple) {
        return trigger;
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button type="button" className={compact ? 'text-left' : 'w-full'} aria-label="Switch node">
                    {trigger}
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                sideOffset={8}
                className="overflow-hidden rounded-md p-0"
                style={{ width: 'var(--radix-popover-trigger-width)', minWidth: '260px' }}
            >
                <div className="relative overflow-hidden">
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/[0.05] via-transparent to-transparent" />
                    <div className="absolute inset-y-0 left-0 w-[2px] bg-brand/60" />
                    <div className="relative flex items-center justify-between px-[var(--density-row-x)] py-[var(--density-tile-y)]">
                        <div className="flex items-baseline gap-2.5">
                            <span className="font-heading text-xl leading-none text-stat-value">
                                Connected
                            </span>
                            <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] tabular-nums text-brand">
                                {nodes.length} nodes
                            </span>
                        </div>
                    </div>
                </div>

                <div className="max-h-[320px] overflow-y-auto border-t border-card-border/60">
                    {nodes.map((node) => {
                        const meta = nodeMeta.get(node.id);
                        const isActive = activeNode?.id === node.id;
                        const version = isValidVersion(meta?.version) ? meta.version : null;
                        const typePart = typeLabel(node.type, node.mode).toUpperCase();
                        const metaParts: string[] = [typePart];
                        if (node.type === 'remote' && node.mode === 'pilot_agent') {
                            metaParts.push(
                                node.pilot_last_seen
                                    ? `SEEN ${formatTimeAgo(node.pilot_last_seen).toUpperCase()}`
                                    : 'WAITING',
                            );
                        }
                        if (version) metaParts.push(`v${version}`);
                        return (
                            <button
                                key={node.id}
                                type="button"
                                onClick={() => {
                                    setActiveNode(node);
                                    setOpen(false);
                                }}
                                aria-current={isActive ? 'true' : undefined}
                                className={cn(
                                    'group relative flex w-full items-center gap-3 px-[var(--density-row-x)] py-[var(--density-row-y)] text-left transition-colors',
                                    'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                                )}
                            >
                                {isActive ? (
                                    <div
                                        className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-brand"
                                        aria-hidden
                                    />
                                ) : null}
                                <span
                                    aria-hidden
                                    className={cn('h-2 w-2 flex-shrink-0 rounded-full', dotClass(node.status))}
                                />
                                <div className="min-w-0 flex-1">
                                    <div
                                        className={cn(
                                            'truncate text-sm leading-snug',
                                            isActive ? 'font-medium text-stat-value' : 'text-stat-value',
                                        )}
                                    >
                                        {node.name}
                                    </div>
                                    <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">
                                        {metaParts.join(' · ')}
                                    </div>
                                </div>
                                {node.is_default ? (
                                    <Star
                                        className="h-3 w-3 flex-shrink-0 fill-brand text-brand"
                                        strokeWidth={1.5}
                                        aria-label="Default node"
                                    />
                                ) : null}
                            </button>
                        );
                    })}
                </div>

                <div className="border-t border-card-border/60">
                    <button
                        type="button"
                        onClick={() => {
                            setOpen(false);
                            onManageNodes();
                        }}
                        className="flex w-full items-center gap-2.5 px-[var(--density-row-x)] py-[var(--density-row-y)] text-left text-sm text-stat-value transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                        <Settings2 className="h-4 w-4 text-stat-icon" strokeWidth={1.5} />
                        <span className="flex-1 truncate">Manage nodes</span>
                    </button>
                </div>
            </PopoverContent>
        </Popover>
    );
}

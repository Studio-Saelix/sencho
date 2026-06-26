import { useMemo, useState } from 'react';
import {
    Bell,
    BellOff,
    Info,
    AlertTriangle,
    AlertOctagon,
    X,
    Trash2,
    SlidersHorizontal,
    CheckCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { NotificationCategory, NotificationItem } from './dashboard/types';
import type { Node } from '@/context/NodeContext';
import { CATEGORY_LABELS } from '@/lib/notificationCategories';

const NODE_FILTER_ALL = 'all' as const;
const CATEGORY_FILTER_ALL = 'all' as const;
type NotifFilter = 'all' | 'unread' | 'alerts';
type NodeFilter = typeof NODE_FILTER_ALL | number;
type CategoryFilter = typeof CATEGORY_FILTER_ALL | NotificationCategory;

const FILTER_LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.14em]';
const FILTER_TRIGGER_CLASS = `h-7 w-[140px] border-card-border bg-card px-2 text-stat-subtitle shadow-none focus:ring-0 ${FILTER_LABEL_CLASS}`;

type LevelConfig = {
    icon: LucideIcon;
    iconClass: string;
    railClass: string;
};

const LEVEL_CONFIG: Record<NotificationItem['level'], LevelConfig> = {
    info: { icon: Info, iconClass: 'text-brand', railClass: 'bg-brand' },
    warning: { icon: AlertTriangle, iconClass: 'text-warning', railClass: 'bg-warning' },
    error: { icon: AlertOctagon, iconClass: 'text-destructive', railClass: 'bg-destructive' },
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type GroupLabel = 'Today' | 'Yesterday' | 'This week' | 'Earlier';
const GROUP_ORDER: GroupLabel[] = ['Today', 'Yesterday', 'This week', 'Earlier'];

function startOfDay(d: Date): number {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c.getTime();
}

function groupByDay(items: NotificationItem[]): { label: GroupLabel; items: NotificationItem[] }[] {
    const today = startOfDay(new Date());
    const yesterday = today - DAY_MS;
    const weekStart = today - 6 * DAY_MS;

    const buckets: Record<GroupLabel, NotificationItem[]> = {
        Today: [],
        Yesterday: [],
        'This week': [],
        Earlier: [],
    };

    for (const item of items) {
        const ts = item.timestamp;
        if (ts >= today) buckets.Today.push(item);
        else if (ts >= yesterday) buckets.Yesterday.push(item);
        else if (ts >= weekStart) buckets['This week'].push(item);
        else buckets.Earlier.push(item);
    }

    return GROUP_ORDER.map((label) => ({ label, items: buckets[label] })).filter(
        (g) => g.items.length > 0,
    );
}

function formatRelative(ms: number): string {
    const diff = Date.now() - ms;
    if (diff < MINUTE_MS) return 'just now';
    if (diff < HOUR_MS) return `${Math.round(diff / MINUTE_MS)}m ago`;
    if (diff < DAY_MS) return `${Math.round(diff / HOUR_MS)}h ago`;
    if (diff < 2 * DAY_MS) return 'yesterday';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const USER_OP_CATEGORIES = new Set([
    'deploy_success', 'stack_started', 'stack_stopped', 'stack_restarted', 'image_update_applied',
]);

function isUserInitiatedSuccess(n: NotificationItem): boolean {
    return n.level === 'info'
        && n.category !== undefined
        && USER_OP_CATEGORIES.has(n.category)
        && n.actor_username != null
        && n.actor_username !== 'system';
}

function applyFilter(
    items: NotificationItem[],
    filter: NotifFilter,
    nodeFilter: NodeFilter,
    categoryFilter: CategoryFilter,
): NotificationItem[] {
    let result = items.filter(n => !isUserInitiatedSuccess(n));
    if (filter === 'unread') result = result.filter((n) => !n.is_read);
    else if (filter === 'alerts') result = result.filter((n) => n.level === 'warning' || n.level === 'error');
    if (nodeFilter !== NODE_FILTER_ALL) result = result.filter((n) => n.nodeId === nodeFilter);
    if (categoryFilter !== CATEGORY_FILTER_ALL) result = result.filter((n) => n.category === categoryFilter);
    return result;
}

interface NotificationPanelProps {
    notifications: NotificationItem[];
    nodes: Node[];
    onMarkAllRead: () => void;
    onClearAll: () => void;
    onDelete: (notif: NotificationItem) => void;
    onNavigate?: (notif: NotificationItem) => void;
    onNavigateChangelog?: (notif: NotificationItem) => void;
}

export function NotificationPanel({
    notifications,
    nodes,
    onMarkAllRead,
    onClearAll,
    onDelete,
    onNavigate,
    onNavigateChangelog,
}: NotificationPanelProps) {
    const [filter, setFilter] = useState<NotifFilter>('all');
    const [nodeFilter, setNodeFilter] = useState<NodeFilter>(NODE_FILTER_ALL);
    const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(CATEGORY_FILTER_ALL);
    const [open, setOpen] = useState(false);
    const [showFilters, setShowFilters] = useState(false);

    const hasActiveFilters =
        nodeFilter !== NODE_FILTER_ALL || categoryFilter !== CATEGORY_FILTER_ALL;

    const unreadCount = useMemo(
        () => notifications.filter((n) => !n.is_read).length,
        [notifications],
    );

    const hasNodeUpdateNotifs = useMemo(
        () => notifications.some((n) => !n.is_read && n.category === 'node_update_available'),
        [notifications],
    );

    const remoteNodeIds = useMemo(() => {
        const ids = new Set<number>();
        for (const n of nodes) if (n.type === 'remote') ids.add(n.id);
        return ids;
    }, [nodes]);

    const showNodeFilter = nodes.length > 1;

    // Derive the effective filter at render time so a removed node falls back
    // to "all" without needing a state-syncing effect (which the
    // react-hooks/set-state-in-effect rule forbids).
    const effectiveNodeFilter: NodeFilter =
        nodeFilter === NODE_FILTER_ALL || nodes.some((n) => n.id === nodeFilter)
            ? nodeFilter
            : NODE_FILTER_ALL;

    const filtered = useMemo(
        () => applyFilter(notifications, filter, effectiveNodeFilter, categoryFilter),
        [notifications, filter, effectiveNodeFilter, categoryFilter],
    );
    const groups = useMemo(() => groupByDay(filtered), [filtered]);

    const filterOptions = useMemo(
        () => [
            { value: 'all' as const, label: 'All' },
            {
                value: 'unread' as const,
                label: 'Unread',
                badge: unreadCount > 0 ? unreadCount : undefined,
            },
            { value: 'alerts' as const, label: 'Alerts' },
        ],
        [unreadCount],
    );

    const bellBadge =
        unreadCount > 0 ? (
            <span aria-hidden="true" className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
                <span className={cn(
                    "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                    hasNodeUpdateNotifs ? 'bg-brand' : 'bg-destructive',
                )} />
                <span className={cn(
                    "relative inline-flex h-2.5 w-2.5 rounded-full",
                    hasNodeUpdateNotifs ? 'bg-brand' : 'bg-destructive',
                )} />
            </span>
        ) : null;

    const handleNavigate = (notif: NotificationItem) => {
        if (!onNavigate) return;
        if (notif.category === 'node_update_available') {
            onNavigate(notif);
            setOpen(false);
            return;
        }
        if (!notif.stack_name) return;
        onNavigate(notif);
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="relative h-8 w-8 rounded-lg"
                    title="Notifications"
                    aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
                >
                    <Bell className="h-4 w-4" strokeWidth={1.5} />
                    {bellBadge}
                </Button>
            </PopoverTrigger>
            <PopoverContent
                className="w-[360px] overflow-hidden rounded-md p-0"
                align="end"
                sideOffset={8}
            >
                {/* Masthead */}
                <div className="relative overflow-hidden">
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/[0.05] via-transparent to-transparent" />
                    <div className="absolute inset-y-0 left-0 w-[2px] bg-brand/60" />
                    <div className="relative flex items-center justify-between px-[var(--density-row-x)] py-[var(--density-tile-y)]">
                        <span className="font-heading text-xl leading-none text-stat-value">
                            Notifications
                        </span>
                        {unreadCount > 0 ? (
                            <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] tabular-nums text-brand">
                                {unreadCount} unread
                            </span>
                        ) : null}
                    </div>
                </div>

                {/* Filter segment */}
                <div className="space-y-2 border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <div className="flex items-center gap-2">
                        <SegmentedControl
                            value={filter}
                            options={filterOptions}
                            onChange={setFilter}
                            ariaLabel="Filter notifications"
                        />
                        <div className="ml-auto flex items-center gap-0.5">
                            {notifications.length > 0 ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setShowFilters((v) => !v)}
                                    className={cn(
                                        'relative h-7 w-7 hover:text-stat-value',
                                        hasActiveFilters ? 'text-brand' : 'text-stat-subtitle',
                                    )}
                                    title={showFilters ? 'Hide filters' : 'Show filters'}
                                    aria-pressed={showFilters}
                                    aria-label="Toggle filters"
                                >
                                    <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                                    {hasActiveFilters ? (
                                        <span
                                            aria-hidden="true"
                                            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand"
                                        />
                                    ) : null}
                                </Button>
                            ) : null}
                            {unreadCount > 0 ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={onMarkAllRead}
                                    className="h-7 w-7 text-stat-subtitle hover:text-stat-value"
                                    title="Mark all read"
                                    aria-label="Mark all read"
                                >
                                    <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
                                </Button>
                            ) : null}
                            {notifications.length > 0 ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={onClearAll}
                                    className="h-7 w-7 text-stat-subtitle hover:text-destructive"
                                    title="Clear all"
                                    aria-label="Clear all notifications"
                                >
                                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                                </Button>
                            ) : null}
                        </div>
                    </div>
                    {showFilters ? (
                        <div className="flex items-center gap-2">
                            {showNodeFilter ? (
                                <Select
                                    value={effectiveNodeFilter === NODE_FILTER_ALL ? NODE_FILTER_ALL : String(effectiveNodeFilter)}
                                    onValueChange={(v) => setNodeFilter(v === NODE_FILTER_ALL ? NODE_FILTER_ALL : Number(v))}
                                >
                                    <SelectTrigger aria-label="Filter by node" className={FILTER_TRIGGER_CLASS}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NODE_FILTER_ALL} className={FILTER_LABEL_CLASS}>
                                            All nodes
                                        </SelectItem>
                                        {nodes.map((n) => (
                                            <SelectItem key={n.id} value={String(n.id)} className={FILTER_LABEL_CLASS}>
                                                {n.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : null}
                            <Select
                                value={categoryFilter}
                                onValueChange={(v) => setCategoryFilter(v as CategoryFilter)}
                            >
                                <SelectTrigger aria-label="Filter by category" className={FILTER_TRIGGER_CLASS}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={CATEGORY_FILTER_ALL} className={FILTER_LABEL_CLASS}>
                                        All types
                                    </SelectItem>
                                    {(Object.keys(CATEGORY_LABELS) as NotificationCategory[]).map((cat) => (
                                        <SelectItem key={cat} value={cat} className={FILTER_LABEL_CLASS}>
                                            {CATEGORY_LABELS[cat]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    ) : null}
                </div>

                {/* Stream */}
                {groups.length === 0 ? (
                    <EmptyState filter={filter} hasAny={notifications.length > 0} />
                ) : (
                    <div className="max-h-[480px] overflow-y-auto border-t border-card-border/60">
                        {groups.map((group) => (
                            <div key={group.label}>
                                <div className="sticky top-0 z-10 border-b border-card-border/40 bg-popover/95 px-[var(--density-row-x)] py-[var(--density-cell-y)] font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle backdrop-blur-[10px] backdrop-saturate-[1.15]">
                                    {group.label}
                                </div>
                                {group.items.map((notif) => (
                                    <NotificationRow
                                        key={`${notif.nodeId ?? 'local'}:${notif.level}:${notif.id}`}
                                        notif={notif}
                                        showNodeName={
                                            notif.nodeId !== undefined && remoteNodeIds.has(notif.nodeId)
                                        }
                                        onDelete={onDelete}
                                        onNavigate={onNavigate ? handleNavigate : undefined}
                                        onNavigateChangelog={onNavigateChangelog}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}

interface NotificationRowProps {
    notif: NotificationItem;
    showNodeName: boolean;
    onDelete: (notif: NotificationItem) => void;
    onNavigate?: (notif: NotificationItem) => void;
    onNavigateChangelog?: (notif: NotificationItem) => void;
}

function NotificationRow({ notif, showNodeName, onDelete, onNavigate, onNavigateChangelog }: NotificationRowProps) {
    const config = LEVEL_CONFIG[notif.level];
    const Icon = config.icon;
    const isUnread = !notif.is_read;
    const isRoutable = Boolean(onNavigate && (notif.stack_name || notif.category === 'node_update_available'));

    const surfaceClasses = cn(
        'flex w-full items-start gap-3 px-[var(--density-row-x)] py-[var(--density-row-y)] text-left transition-colors',
        isRoutable && 'cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none',
    );

    const content = (
        <>
            <Icon
                className={cn('mt-0.5 h-4 w-4 flex-shrink-0', config.iconClass)}
                strokeWidth={1.5}
            />
            <div className="min-w-0 flex-1">
                <p
                    className={cn(
                        'break-words pr-6 text-sm leading-snug',
                        isUnread ? 'text-stat-value' : 'text-stat-subtitle',
                    )}
                >
                    {notif.message}
                </p>
                <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">
                    {showNodeName && notif.nodeName ? (
                        <>
                            <span className="rounded-sm border border-card-border bg-muted/40 px-1.5 py-0.5 normal-case tracking-normal text-stat-subtitle">
                                {notif.nodeName}
                            </span>
                            <span className="text-stat-icon">·</span>
                        </>
                    ) : null}
                    <span className="tabular-nums">{formatRelative(notif.timestamp)}</span>
                </div>
            </div>
        </>
    );

    const ariaLabel = isRoutable
        ? (notif.category === 'node_update_available'
            ? 'Open Fleet node updates'
            : notif.container_name
                ? `Open ${notif.stack_name} and view logs for ${notif.container_name}`
                : `Open ${notif.stack_name}`)
        : undefined;

    return (
        <div className="group relative border-b border-card-border/40 last:border-b-0">
            <div
                className={cn(
                    'pointer-events-none absolute inset-y-0 left-0 z-10 w-[3px] transition-opacity',
                    config.railClass,
                    isUnread ? 'opacity-100' : 'opacity-30',
                )}
            />
            {isRoutable ? (
                <button
                    type="button"
                    className={surfaceClasses}
                    onClick={() => onNavigate?.(notif)}
                    aria-label={ariaLabel}
                >
                    {content}
                </button>
            ) : (
                <div className={surfaceClasses}>{content}</div>
            )}
            {notif.category === 'node_update_available' && onNavigateChangelog && (
                <div className="flex items-center border-t border-card-border/40 px-[var(--density-row-x)] py-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px] font-sans normal-case tracking-normal text-brand hover:text-brand/80"
                        onClick={(e) => {
                            e.stopPropagation();
                            onNavigateChangelog(notif);
                        }}
                    >
                        View changelog
                    </Button>
                </div>
            )}
            <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 z-20 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onDelete(notif)}
                title="Dismiss"
            >
                <X className="h-3 w-3" strokeWidth={1.5} />
            </Button>
        </div>
    );
}

interface EmptyStateProps {
    filter: NotifFilter;
    hasAny: boolean;
}

function EmptyState({ filter, hasAny }: EmptyStateProps) {
    let title = "You're all caught up";
    let subtitle = 'New notifications appear here in real time.';

    if (hasAny && filter === 'unread') {
        title = 'No unread notifications';
        subtitle = 'Everything in your feed has been read.';
    } else if (hasAny && filter === 'alerts') {
        title = 'No active alerts';
        subtitle = 'Warnings and errors will surface here when they occur.';
    }

    return (
        <div className="flex flex-col items-center gap-2 border-t border-card-border/60 px-[var(--density-row-x)] py-12 text-center">
            <BellOff className="h-8 w-8 text-stat-icon" strokeWidth={1.5} />
            <p className="text-sm text-stat-value">{title}</p>
            <p className="font-mono text-[11px] text-stat-subtitle">{subtitle}</p>
        </div>
    );
}

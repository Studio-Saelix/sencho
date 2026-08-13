import { useEffect, useRef, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table';
import { useTableSort } from '@/hooks/useTableSort';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ConfirmModal } from '@/components/ui/modal';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Info, Search, Unlock } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import { TableSkeleton } from './TableSkeleton';

export type RollbackOperationKind =
    | 'update'
    | 'deployment'
    | 'git_apply'
    | 'manual_backup'
    | 'unknown';

export interface RollbackGeneration {
    id: string;
    shortId: string;
    stackName: string;
    status: 'active' | 'restored_current' | 'superseded' | 'recovery_required';
    isCurrent: boolean;
    phase: string;
    createdAt: number;
    artifactExpiresAt: number | null;
    createdBy: string | null;
    operationKind: RollbackOperationKind | null;
    /** Best-effort UI hint only; the server revalidates eligibility on release. */
    releasable: boolean;
}

interface RollbackGenerationsTabProps {
    generations: RollbackGeneration[];
    isLoading: boolean;
    isAdmin: boolean;
    nodeId?: number;
    /** Refetches the Resources page's data after a successful release. */
    onReleased: () => void | Promise<void>;
}

/** Displayed State badge values; used by both StateBadge and the State comparator. */
type DisplayedRollbackState = 'current' | 'recovery_required' | 'superseded';

function getDisplayedState(gen: RollbackGeneration): DisplayedRollbackState {
    if (gen.status === 'recovery_required') return 'recovery_required';
    if (gen.isCurrent) return 'current';
    return 'superseded';
}

const DISPLAYED_STATE_ORDER: Record<DisplayedRollbackState, number> = {
    current: 0,
    recovery_required: 1,
    superseded: 2,
};

function formatExpiry(gen: RollbackGeneration): string {
    if (gen.isCurrent) return 'Protected while current';
    if (gen.status === 'recovery_required') return 'Recovery required';
    if (gen.artifactExpiresAt === null) return 'Pending';
    const days = (gen.artifactExpiresAt - Date.now()) / (24 * 60 * 60 * 1000);
    if (days <= 0) return 'Expiring now';
    if (days < 1) return `Expires in ${Math.max(1, Math.round(days * 24))}h`;
    return `Expires in ${Math.round(days)}d`;
}

function StateBadge({ gen }: { gen: RollbackGeneration }) {
    const displayed = getDisplayedState(gen);
    switch (displayed) {
        case 'recovery_required':
            return <Badge variant="destructive" className="text-[10px] h-5">Recovery required</Badge>;
        case 'current':
            return <Badge variant="default" className="text-[10px] h-5">Current</Badge>;
        case 'superseded':
            return <Badge variant="secondary" className="text-[10px] h-5">Superseded</Badge>;
        default: {
            const unhandled: never = displayed;
            return <Badge variant="secondary" className="text-[10px] h-5">{String(unhandled)}</Badge>;
        }
    }
}

function tieBreak(a: RollbackGeneration, b: RollbackGeneration): number {
    // Newer first, then stable id ascending.
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
}

type RollbackSortKey = 'stack' | 'generation' | 'state' | 'retention';

// Stable comparator map (module scope so useTableSort does not re-sort every
// render). Primary keys fall through to createdAt desc then id asc on ties.
const ROLLBACK_COMPARATORS: Record<RollbackSortKey, (a: RollbackGeneration, b: RollbackGeneration) => number> = {
    stack: (a, b) => {
        const byName = a.stackName.localeCompare(b.stackName);
        return byName !== 0 ? byName : tieBreak(a, b);
    },
    generation: (a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id.localeCompare(b.id);
    },
    state: (a, b) => {
        const byState = DISPLAYED_STATE_ORDER[getDisplayedState(a)] - DISPLAYED_STATE_ORDER[getDisplayedState(b)];
        return byState !== 0 ? byState : tieBreak(a, b);
    },
    // Asc: finite expiries ascending, then rows without a finite expiry.
    // Desc is the exact reverse via useTableSort's direction multiplier.
    retention: (a, b) => {
        const aExp = a.artifactExpiresAt;
        const bExp = b.artifactExpiresAt;
        if (aExp === null && bExp === null) return tieBreak(a, b);
        if (aExp === null) return 1;
        if (bExp === null) return -1;
        if (aExp !== bExp) return aExp - bExp;
        return tieBreak(a, b);
    },
};

const SORT_HEAD_MOBILE = 'max-md:[&_button]:min-h-11 max-md:[&_button]:py-2';

const ROLLBACK_HELP =
    'Rollback-protected images from full-stack updates. Each generation is kept so a failed update can be automatically rolled back, and clears on its own once it is superseded and its retention window passes (configurable under Settings → Infrastructure → Stacks → Deploy Guardrails).';

type RollbackStateFilter = 'all' | 'current' | 'superseded';

const FILTER_OPTIONS: { key: RollbackStateFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'current', label: 'Current' },
    { key: 'superseded', label: 'Superseded' },
];

function FilterToggle({
    value,
    onChange,
    counts,
}: {
    value: RollbackStateFilter;
    onChange: (v: RollbackStateFilter) => void;
    counts: Record<RollbackStateFilter, number>;
}) {
    return (
        <div className="flex items-center gap-1">
            {FILTER_OPTIONS.map(({ key, label }) => (
                <Button
                    key={key}
                    type="button"
                    variant={value === key ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2.5 gap-1.5 max-md:min-h-11"
                    onClick={() => onChange(key)}
                >
                    {label}
                    <span className="font-mono tabular-nums text-[10px] opacity-70">{counts[key]}</span>
                </Button>
            ))}
        </div>
    );
}

/**
 * Full-stack rollback generations (the sencho-rb/<id>/<service>:hold images
 * StackUpdateRecoveryService creates). Kept in its own tab rather than the
 * generic Images list: this is durable recovery state with its own lifecycle
 * (stack, generation, retention, release), not ordinary Docker image inventory.
 */
export function RollbackGenerationsTab({ generations, isLoading, isAdmin, nodeId, onReleased }: RollbackGenerationsTabProps) {
    const [confirmRelease, setConfirmRelease] = useState<RollbackGeneration | null>(null);
    const [isReleasing, setIsReleasing] = useState(false);
    const [search, setSearch] = useState('');
    const [searchExpanded, setSearchExpanded] = useState(false);
    const [stateFilter, setStateFilter] = useState<RollbackStateFilter>('all');
    const searchRef = useRef<HTMLInputElement>(null);
    useEffect(() => { if (searchExpanded) searchRef.current?.focus(); }, [searchExpanded]);

    const filterCounts: Record<RollbackStateFilter, number> = {
        all: generations.length,
        current: 0,
        superseded: 0,
    };
    for (const gen of generations) {
        // Recovery-required rows count under Current so mid-recovery generations
        // stay visible when that filter is active (badge still says Recovery required).
        if (getDisplayedState(gen) === 'superseded') filterCounts.superseded++;
        else filterCounts.current++;
    }

    const searchQuery = search.toLowerCase();
    const filtered = generations.filter((gen) => {
        const displayed = getDisplayedState(gen);
        if (stateFilter === 'superseded' && displayed !== 'superseded') return false;
        if (stateFilter === 'current' && displayed === 'superseded') return false;
        if (searchQuery === '') return true;
        return gen.stackName.toLowerCase().includes(searchQuery)
            || gen.shortId.toLowerCase().includes(searchQuery);
    });
    // Default Generation descending preserves the API's newest-first order.
    const { sorted, sortKey, sortDir, toggleSort } = useTableSort(filtered, ROLLBACK_COMPARATORS, 'generation', 'desc');

    const handleRelease = async () => {
        if (!confirmRelease) return;
        setIsReleasing(true);
        const loadingId = toast.loading(`Releasing rollback protection for ${confirmRelease.shortId}...`);
        try {
            const res = await apiFetch(`/system/rollback/generations/${confirmRelease.id}/release`, { method: 'POST' });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to release rollback protection');
            }
            toast.success(data?.message || 'Rollback protection released');
            await onReleased();
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || 'Failed to release rollback protection'));
        } finally {
            toast.dismiss(loadingId);
            setIsReleasing(false);
            setConfirmRelease(null);
        }
    };

    return (
        <>
            <div className="flex flex-wrap items-center gap-2 mb-4">
                {search !== '' || searchExpanded ? (
                    <div className="relative flex-1 min-w-[200px] max-w-sm">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                        <Input
                            ref={searchRef}
                            placeholder="Search stack or generation..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onBlur={() => { if (search === '') setSearchExpanded(false); }}
                            className="pl-9 h-9 max-md:min-h-11"
                            aria-label="Search rollback generations"
                        />
                    </div>
                ) : (
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-9 w-9 p-0 shrink-0 max-md:min-h-11 max-md:min-w-11"
                                    onClick={() => setSearchExpanded(true)}
                                    aria-label="Search rollback generations"
                                >
                                    <Search className="w-4 h-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Search rollback generations</TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )}
                <FilterToggle
                    value={stateFilter}
                    onChange={setStateFilter}
                    counts={filterCounts}
                />
                <div className="flex-1" />
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-9 w-9 p-0 shrink-0 text-muted-foreground hover:text-foreground max-md:min-h-11 max-md:min-w-11"
                                aria-label="About rollback generations"
                            >
                                <Info className="w-4 h-4" strokeWidth={1.5} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-sm">
                            <p className="text-sm leading-relaxed">{ROLLBACK_HELP}</p>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            </div>
            <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
            <ScrollArea className="h-[62vh] max-md:h-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <SortableTableHead label="Stack" columnKey="stack" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className={SORT_HEAD_MOBILE} />
                            <SortableTableHead label="Generation" columnKey="generation" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className={SORT_HEAD_MOBILE} />
                            <TableHead>Trigger</TableHead>
                            <SortableTableHead label="State" columnKey="state" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className={`text-center ${SORT_HEAD_MOBILE}`} />
                            <SortableTableHead label="Retention" columnKey="retention" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className={SORT_HEAD_MOBILE} />
                            <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    {isLoading ? <TableSkeleton cols={6} /> : (
                    <TableBody>
                        {generations.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                                    No rollback-protected generations on this node.
                                </TableCell>
                            </TableRow>
                        ) : sorted.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                                    No generations match this filter.
                                </TableCell>
                            </TableRow>
                        ) : sorted.map((gen, i) => (
                            <TableRow
                                key={gen.id}
                                className="animate-in fade-in-0 duration-200 hover:bg-muted/30 transition-colors"
                                style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                            >
                                <TableCell className="font-medium">
                                    <button
                                        type="button"
                                        disabled={nodeId === undefined}
                                        className="hover:underline underline-offset-2 disabled:no-underline disabled:cursor-default"
                                        onClick={() => nodeId !== undefined && window.dispatchEvent(
                                            new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, { detail: { nodeId, stackName: gen.stackName } }),
                                        )}
                                    >
                                        {gen.stackName}
                                    </button>
                                </TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground">{gen.shortId}</TableCell>
                                <TableCell className="text-xs text-stat-subtitle">
                                    {[gen.operationKind, gen.createdBy].filter(Boolean).join(' · ') || 'unknown'}
                                </TableCell>
                                <TableCell className="text-center"><StateBadge gen={gen} /></TableCell>
                                <TableCell className="text-xs text-stat-subtitle">{formatExpiry(gen)}</TableCell>
                                <TableCell className="text-right">
                                    {isAdmin && (
                                        <TooltipProvider>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 text-muted-foreground hover:text-destructive transition-colors"
                                                        disabled={!gen.releasable}
                                                        onClick={() => setConfirmRelease(gen)}
                                                        aria-label={`Release rollback protection for ${gen.shortId}`}
                                                    >
                                                        <Unlock className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                    {gen.releasable
                                                        ? 'Release rollback protection'
                                                        : 'Not releasable right now (mid-recovery or observing a health gate)'}
                                                </TooltipContent>
                                            </Tooltip>
                                        </TooltipProvider>
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                    )}
                </Table>
            </ScrollArea>
            </div>

            <ConfirmModal
                open={!!confirmRelease}
                onOpenChange={(open) => !open && setConfirmRelease(null)}
                variant="destructive"
                kicker="ROLLBACK · RELEASE · IRREVERSIBLE"
                title={`Release rollback protection for ${confirmRelease?.stackName ?? ''}`}
                confirmLabel={isReleasing ? 'Releasing...' : 'Release'}
                confirming={isReleasing}
                onConfirm={handleRelease}
            >
                <p className="text-sm text-stat-subtitle">
                    {confirmRelease?.isCurrent ? (
                        <>
                            This is <span className="font-medium text-stat-value">{confirmRelease?.stackName}</span>'s
                            current rollback point. Releasing it now means Sencho will not be able to automatically
                            roll this stack back until its next successful full-stack update.
                        </>
                    ) : (
                        <>
                            Permanently removes the held rollback image for generation{' '}
                            <span className="font-mono font-medium text-stat-value">{confirmRelease?.shortId}</span>{' '}
                            ahead of its normal retention window.
                        </>
                    )}
                </p>
            </ConfirmModal>
        </>
    );
}

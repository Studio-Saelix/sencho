import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Masthead, MobileSubTabs, type Tone } from '@/components/mobile/mobile-ui';
import { PageMasthead, type MastheadTone } from '@/components/ui/PageMasthead';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from "@/components/ui/tabs";
import { springs } from '@/lib/motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmModal } from "@/components/ui/modal";
import { ScrollArea } from "@/components/ui/scroll-area";
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Trash2, ShieldCheck, Eye, Loader2, History, FolderOpen, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SeverityBadge } from '@/components/ui/SeverityBadge';
import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import { useImageScan } from '@/hooks/useImageScan';
import { VulnerabilityScanSheet } from './VulnerabilityScanSheet';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from './NodeManager';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import type { ScanSummary } from '@/types/security';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { formatBytes } from '@/lib/utils';
import { ResourcesActions } from './resources/ResourcesActions';
import { deriveResourcesMastheadState, type UsageLoad } from './resources/resourcesMasthead';
import { ImageDetailsSheet } from './resources/ImageDetailsSheet';
import { RollbackGenerationsTab, type RollbackGeneration } from './resources/RollbackGenerationsTab';
import { TableSkeleton, TableLoadError } from './resources/TableSkeleton';
import { VolumeBrowserSheet } from './resources/VolumeBrowserSheet';
import { VolumeNameLabel } from './resources/VolumeNameLabel';
import { useTableSort } from '@/hooks/useTableSort';
import { useRegionData } from '@/hooks/useRegionData';
import {
    assertReadOk,
    classifyRemoteReadError,
    classifyRemoteReadFailure,
    isNamedReadFailure,
    isUnreadableNode,
    remoteReadFailureMessage,
    remoteReadFailureOf,
    type RemoteReadFailure,
} from '@/lib/remoteReadFailure';
import { SortableTableHead } from '@/components/ui/sortable-table';
import { isPrunePlan, type PrunePlan, type PruneScope, type PruneTarget } from '@/lib/prunePlan';

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface DockerImage {
    Id: string;
    RepoTags: string[];
    Size: number;
    Containers: number;
    usedByStacks: string[];
    managedBy: string | null;
    managedStatus: 'managed' | 'unmanaged' | 'unused';
    isSencho: boolean;
    /** True when a rollback hold protects this image from pruning; additive, independent of managedStatus. */
    rollbackProtected: boolean;
    rollbackProtectionKind?: 'stack' | 'service';
}

interface DockerVolume {
    Name: string;
    Driver: string;
    Mountpoint: string;
    Size: number;
    CreatedAt: string | null;
    managedBy: string | null;
    managedStatus: 'managed' | 'unmanaged';
    isSencho: boolean;
}

export interface DockerNetwork {
    Id: string;
    Name: string;
    Driver: string;
    Scope: string;
    managedBy: string | null;
    managedStatus: 'managed' | 'unmanaged' | 'system';
    isSencho: boolean;
}

interface UnmanagedContainer {
    Id: string;
    Names: string[];
    State: string;
    Status: string;
    Image: string;
}

type ResourceFilter = 'all' | 'managed' | 'unmanaged';

const PLAN_PREVIEW_CAP = 30;

const MOBILE_STATE_TONE: Record<MastheadTone, Tone> = { warn: 'warning', live: 'success', idle: 'brand', error: 'destructive' };

function PrunePlanPreview({
    plan,
    loading,
    error,
}: {
    plan: PrunePlan | null;
    loading: boolean;
    error: string | null;
}) {
    if (loading) {
        return <p className="text-sm text-stat-subtitle">Building prune plan...</p>;
    }
    if (error) {
        return <p className="text-sm text-destructive">{error}</p>;
    }
    if (!plan) return null;
    if (plan.items.length === 0) {
        return <p className="text-sm text-stat-subtitle">Nothing eligible to prune right now.</p>;
    }
    const shown = plan.items.slice(0, PLAN_PREVIEW_CAP);
    const remaining = plan.items.length - shown.length;
    return (
        <div className="space-y-2">
            <p className="text-xs font-mono text-stat-subtitle/90">
                {plan.items.length} {plan.items.length === 1 ? 'item' : 'items'}
                {plan.reclaimableBytes > 0 ? ` · ${formatBytes(plan.reclaimableBytes)}` : ''}
            </p>
            <ScrollArea type="hover" className="max-h-40">
                <ul className="space-y-1 font-mono text-[12px] text-stat-subtitle/90">
                    {shown.map((item) => (
                        <li key={`${item.target}:${item.id}`} className="block">
                            <span className="block truncate">
                                <span className="text-stat-subtitle/60">{item.target}</span>
                                {' · '}
                                {item.name}
                                {item.sizeBytes != null && item.sizeBytes > 0 ? ` · ${formatBytes(item.sizeBytes)}` : ''}
                            </span>
                            {item.target === 'images' && item.image.references
                                .filter((ref) => ref !== item.name)
                                .map((ref) => (
                                    <span key={ref} className="block break-all">{ref}</span>
                                ))}
                        </li>
                    ))}
                </ul>
            </ScrollArea>
            {remaining > 0 && (
                <p className="text-xs text-stat-subtitle/70">and {remaining} more</p>
            )}
        </div>
    );
}

// ── Filter + search toolbar pieces ─────────────────────────────────────────────

function ResourceFilterControl({ value, onChange, counts, noun }: {
    value: ResourceFilter;
    onChange: (v: ResourceFilter) => void;
    counts: { all: number; managed: number; unmanaged: number };
    noun: string;
}) {
    return (
        <SegmentedControl<ResourceFilter>
            ariaLabel={`Filter ${noun}`}
            value={value}
            onChange={onChange}
            options={[
                { value: 'all', label: 'All', badge: counts.all },
                { value: 'managed', label: 'Managed', badge: counts.managed },
                { value: 'unmanaged', label: 'External', badge: counts.unmanaged },
            ]}
        />
    );
}

/** Icon-only until clicked; stays open while a query is active. */
function CollapsibleSearch({ value, onChange, noun }: { value: string; onChange: (v: string) => void; noun: string }) {
    const [expanded, setExpanded] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { if (expanded) inputRef.current?.focus(); }, [expanded]);

    if (value !== '' || expanded) {
        return (
            <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                    ref={inputRef}
                    placeholder={`Search ${noun}...`}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={() => { if (value === '') setExpanded(false); }}
                    className="pl-9 h-9"
                />
            </div>
        );
    }
    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 w-9 p-0 shrink-0" onClick={() => setExpanded(true)} aria-label={`Search ${noun}`}>
                        <Search className="w-4 h-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Search {noun}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

// ── Managed Status Badge ───────────────────────────────────────────────────────

function ManagedBadge({ status, managedBy, usedByStacks, onOpenStack }: {
    status: 'managed' | 'unmanaged' | 'unused' | 'system';
    managedBy: string | null;
    /** When length > 1, render one chip per stack (images shared across stacks). */
    usedByStacks?: string[];
    /** When provided on a managed resource, the owning-stack badge becomes a link to that stack. */
    onOpenStack?: (stack: string) => void;
}) {
    if (status === 'managed') {
        const stacks = (usedByStacks && usedByStacks.length > 0)
            ? usedByStacks
            : (managedBy ? [managedBy] : []);
        const cls = "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-success/25 bg-success/8 text-success text-[10px] font-medium";
        return (
            <span className="inline-flex items-center gap-1 flex-wrap">
                {stacks.map((stack) => {
                    const inner = (<><span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />{stack}</>);
                    if (onOpenStack) {
                        return (
                            <TooltipProvider key={stack}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button type="button" className={`${cls} hover:bg-success/15 transition-colors`} onClick={() => onOpenStack(stack)}>
                                            {inner}
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent>Open stack {stack}</TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                        );
                    }
                    return <span key={stack} className={cls}>{inner}</span>;
                })}
            </span>
        );
    }
    if (status === 'unmanaged') {
        return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-warning/25 bg-warning/8 text-warning text-[10px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
                External
            </span>
        );
    }
    if (status === 'system') {
        return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-muted/40 text-muted-foreground text-[10px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                System
            </span>
        );
    }
    return null;
}

// ── Sencho Self-Protection Badge ───────────────────────────────────────────────

function SenchoBadge() {
    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-brand/25 bg-brand/8 text-brand text-[10px] font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-brand shrink-0" />
                        Sencho
                    </span>
                </TooltipTrigger>
                <TooltipContent>Protected · running Sencho instance</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

function RollbackProtectedBadge({ kind, onOpen }: { kind?: 'stack' | 'service'; onOpen: () => void }) {
    const badge = (
        <Badge variant="outline" className="text-[10px] h-5 gap-1 border-brand/40 text-brand">
            <ShieldCheck className="w-3 h-3" strokeWidth={2} />
            Rollback protected
        </Badge>
    );
    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    {kind === 'stack' ? (
                        <button type="button" onClick={onOpen} aria-label="Rollback protected, show rollback generations" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
                            {badge}
                        </button>
                    ) : badge}
                </TooltipTrigger>
                <TooltipContent>
                    {kind === 'stack'
                        ? 'Held as a full-stack rollback point. Click to open the Rollback tab.'
                        : 'Held for a pending per-service update rollback.'}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

// Stable comparator maps for the resource tables (module scope so useTableSort
// does not re-sort on every render). Mirrors the Security Images sort standard.
const IMAGE_COMPARATORS: Record<'repo' | 'size' | 'status', (a: DockerImage, b: DockerImage) => number> = {
    repo: (a, b) => (a.RepoTags?.[0] || '').localeCompare(b.RepoTags?.[0] || ''),
    size: (a, b) => a.Size - b.Size,
    status: (a, b) => Number(a.Containers > 0) - Number(b.Containers > 0),
};
const VOLUME_COMPARATORS: Record<'name' | 'driver', (a: DockerVolume, b: DockerVolume) => number> = {
    name: (a, b) => a.Name.localeCompare(b.Name),
    driver: (a, b) => a.Driver.localeCompare(b.Driver),
};

// ── Main Component ─────────────────────────────────────────────────────────────

interface ResourcesViewProps {
    /** Notifications + more-menu cluster for the mobile masthead, rehomed from the dropped TopBar. */
    headerActions?: ReactNode;
}

export default function ResourcesView({ headerActions }: ResourcesViewProps = {}) {
    const isMobile = useIsMobile();
    const [resourceTab, setResourceTab] = useState<'images' | 'volumes' | 'unmanaged' | 'rollback'>('images');
    const { isAdmin, can } = useAuth();
    const canReadResources = can('stack:read');
    const canDeployResources = can('stack:deploy');
    const canEditSecurityPolicy = can('stack:edit');
    const { activeNode } = useNodes();

    // Loading ownership follows data ownership. The inventory tables, the
    // external-container list, rollback generations, and scan summaries each
    // hydrate from their own request, so a slow read in one region cannot hold
    // the others and an ordinary failure stays in its own region. The one
    // exception is a failure that proves the node unreadable, which the tables
    // and the usage card name while the slow inventory read is still pending
    // (see siblingUnreadable). Disk usage keeps its own loader below because its
    // figures are deliberately dropped when a read fails.
    const nodeScope = activeNode?.id;

    // One warning covers a failed background refresh, whichever region failed:
    // the rows stay on screen, so the failure is reported once here instead of
    // replacing trusted data with an error surface or stacking one toast per
    // region. A first read that fails has no rows to keep and shows its own
    // Retry row instead, so it does not also toast.
    const refreshWarnedRef = useRef(false);
    const notifyRefreshFailed = (_error: unknown, hadData: boolean) => {
        if (!hadData || refreshWarnedRef.current) return;
        refreshWarnedRef.current = true;
        toast.error('Failed to refresh resources');
    };

    const inventoryRegion = useRegionData(nodeScope, async (signal) => {
        const res = await apiFetch('/system/resources', { signal });
        assertReadOk(res, '/system/resources');
        const body = await res.json() as {
            images?: DockerImage[];
            volumes?: DockerVolume[];
            networks?: DockerNetwork[];
        };
        return {
            images: body.images ?? [],
            volumes: body.volumes ?? [],
            networks: body.networks ?? [],
        };
    }, 0, { onError: notifyRefreshFailed });

    const orphansRegion = useRegionData(nodeScope, async (signal) => {
        const res = await apiFetch('/system/orphans', { signal });
        assertReadOk(res, '/system/orphans');
        return await res.json() as Record<string, UnmanagedContainer[]>;
    }, 0, { onError: notifyRefreshFailed });

    const rollbackRegion = useRegionData(nodeScope, async (signal) => {
        const res = await apiFetch('/system/rollback/generations', { signal });
        assertReadOk(res, '/system/rollback/generations');
        const body: unknown = await res.json();
        if (!Array.isArray(body)) throw new Error('/system/rollback/generations returned a malformed body');
        return body as RollbackGeneration[];
    }, 0, { onError: notifyRefreshFailed });

    const scanSummariesRegion = useRegionData(nodeScope, async (signal) => {
        const res = await apiFetch('/security/image-summaries', { signal });
        assertReadOk(res, '/security/image-summaries');
        const body: unknown = await res.json();
        return (body ?? {}) as Record<string, ScanSummary>;
    }, 0, { onError: notifyRefreshFailed });

    const images = inventoryRegion.data?.images ?? [];
    const volumes = inventoryRegion.data?.volumes ?? [];
    const networks = inventoryRegion.data?.networks ?? [];
    const orphans = orphansRegion.data ?? {};
    const rollbackGenerations = rollbackRegion.data ?? [];
    const scanSummaries = scanSummariesRegion.data ?? {};

    const [isActioning, setIsActioning] = useState(false);

    // Filter state
    const [imageFilter, setImageFilter] = useState<ResourceFilter>('all');
    const [volumeFilter, setVolumeFilter] = useState<ResourceFilter>('all');

    // Search state
    const [imageSearch, setImageSearch] = useState('');
    const [volumeSearch, setVolumeSearch] = useState('');

    // Modal states
    const [confirmPrune, setConfirmPrune] = useState<{ target: PruneTarget; scope: PruneScope } | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<{ type: 'images' | 'volumes' | 'networks'; id: string; name?: string } | null>(null);
    const [confirmReclaim, setConfirmReclaim] = useState(false);
    const [prunePlan, setPrunePlan] = useState<PrunePlan | null>(null);
    const [planLoading, setPlanLoading] = useState(false);
    const [planError, setPlanError] = useState<string | null>(null);
    const planFetchGenRef = useRef(0);

    // Classified image selection is node-bound so a node switch cannot leave
    // the previous node's usedByStacks visible beside a new node's inspect.
    const [inspectImage, setInspectImage] = useState<(DockerImage & { nodeId: string | number }) | null>(null);
    const [browseVolume, setBrowseVolume] = useState<string | null>(null);

    // External (unmanaged) container state. A selection belongs to the read it
    // was made on: `list` is that read's payload, so a fresh read (or another
    // node's list) starts with nothing selected instead of carrying the old ids
    // over. Derived at render, so no effect copies the list back into state.
    const [orphanSelection, setOrphanSelection] = useState<{
        list: Record<string, UnmanagedContainer[]> | null;
        ids: string[];
    }>({ list: null, ids: [] });
    const [bulkPurgeConfirm, setBulkPurgeConfirm] = useState(false);

    // Vulnerability scanning state
    const { status: trivy } = useTrivyStatus();
    const [inspectScanId, setInspectScanId] = useState<number | null>(null);
    const { scanningRef: scanningImageRef, scanImage, cancelScan } = useImageScan({
        onComplete: setInspectScanId,
        onSummaries: scanSummariesRegion.apply,
    });

    // Disk usage loads on its own clock, separate from the tables, so the
    // inventory never waits on `docker system df`.
    const [usageLoad, setUsageLoad] = useState<UsageLoad>({ status: 'loading' });
    // Generation counter so a slow fetch for a previously-active node cannot
    // stomp the visible figures after the user switches nodes.
    const usageGenerationRef = useRef(0);
    // A node switch abandons the read started for the previous node, so the
    // backend stops working on an answer nobody will read.
    const usageAbortRef = useRef<AbortController | null>(null);

    // A failed usage load drops the figures rather than keeping stale ones: the
    // masthead then reads "Disk usage unknown" with a Retry instead of a number
    // that may already be out of date.
    const failUsage = (reason: unknown, failure?: RemoteReadFailure) => {
        console.error('Failed to fetch disk usage', reason);
        setUsageLoad({ status: 'error', failure });
    };

    const loadUsage = async ({ background = false }: { background?: boolean } = {}) => {
        const generation = ++usageGenerationRef.current;
        usageAbortRef.current?.abort();
        const controller = new AbortController();
        usageAbortRef.current = controller;
        if (!background) setUsageLoad({ status: 'loading' });
        try {
            const res = await apiFetch('/system/docker-df', { signal: controller.signal });
            const data = res.ok ? await res.json() : null;
            if (usageGenerationRef.current !== generation || controller.signal.aborted) return;
            if (data) {
                setUsageLoad({ status: 'ready', data });
            } else {
                failUsage(res.status, classifyRemoteReadFailure(res) ?? undefined);
            }
        } catch (err) {
            if (usageGenerationRef.current !== generation || controller.signal.aborted) return;
            failUsage(err, classifyRemoteReadError(err));
        }
    };

    /** After a mutation: refresh every region. The tables keep their current rows
     *  until each response lands, so the page never drops back to a cold skeleton;
     *  disk usage is not awaited, because the tables must not wait on it. The
     *  table regions are awaited so a mutation stays busy until the payload that
     *  still lists the removed rows is replaced: a second click on a control that
     *  targets them must not reach the server ("no such container"). The warning
     *  flag resets so each refresh reports at most one failure. */
    const refreshAll = async () => {
        refreshWarnedRef.current = false;
        void loadUsage({ background: true });
        await Promise.all([
            inventoryRegion.refresh(),
            orphansRegion.refresh(),
            rollbackRegion.refresh(),
            scanSummariesRegion.refresh(),
        ]);
    };

    useEffect(() => {
        // Nothing from the previous node may show under the new one while its
        // data loads, including when that load fails. The inventory, external,
        // rollback, and scan-summary regions are scope-bound and reset
        // themselves; disk usage owns its own figures.
        setUsageLoad({ status: 'loading' });
        void loadUsage();
    }, [activeNode]);

    // A selected image belongs to the node it was listed on.
    useEffect(() => {
        setInspectImage(null);
    }, [activeNode?.id]);

    // Stop following an in-flight scan on node switch; its result belongs to
    // the node it started on (the hook also stops it on unmount).
    useEffect(() => cancelScan, [activeNode?.id, cancelScan]);

    // Bump the usage generation on unmount so a fetch that resolves after the
    // view is gone cannot run state setters.
    useEffect(() => () => {
        usageGenerationRef.current += 1;
        usageAbortRef.current?.abort();
    }, []);

    type PrunePlanRequest = { target?: PruneTarget; targets?: PruneTarget[]; scope: PruneScope };

    const fetchPrunePlan = async (body: PrunePlanRequest) => {
        const generation = ++planFetchGenRef.current;
        setPlanLoading(true);
        setPlanError(null);
        setPrunePlan(null);
        try {
            const res = await apiFetch('/system/prune/plan', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => null);
            if (planFetchGenRef.current !== generation) return null;
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to build prune plan');
            }
            if (!isPrunePlan(data)) throw new Error('The node returned a malformed prune plan');
            setPrunePlan(data);
            return data;
        } catch (error) {
            if (planFetchGenRef.current !== generation) return null;
            const err = error as { message?: string };
            const message = err?.message || 'Failed to build prune plan';
            setPlanError(message);
            console.error('Failed to build prune plan', error);
            return null;
        } finally {
            if (planFetchGenRef.current === generation) setPlanLoading(false);
        }
    };

    /** POST /prune/system with fingerprint. On stale 409, refresh the plan and
     *  require another confirm rather than executing a set the user never saw. */
    const executeFingerprintPrune = async (body: PrunePlanRequest, fingerprint: string) => {
        const res = await apiFetch('/system/prune/system', {
            method: 'POST',
            body: JSON.stringify({ ...body, planFingerprint: fingerprint }),
        });
        const data = await res.json().catch(() => null);
        if (res.status === 409 && data?.code === 'PRUNE_PLAN_STALE') {
            await fetchPrunePlan(body);
            throw new Error('Prune plan changed; review the updated list and confirm again');
        }
        return { res, data };
    };

    // Fetch an itemized plan whenever a prune confirm dialog opens.
    useEffect(() => {
        if (!confirmPrune) return;
        void fetchPrunePlan({ target: confirmPrune.target, scope: confirmPrune.scope });
    }, [confirmPrune]);

    useEffect(() => {
        if (!confirmReclaim) return;
        void fetchPrunePlan({ targets: ['volumes', 'containers', 'images'], scope: 'all' });
    }, [confirmReclaim]);

    useEffect(() => {
        if (confirmPrune || confirmReclaim) return;
        planFetchGenRef.current += 1;
        setPrunePlan(null);
        setPlanLoading(false);
        setPlanError(null);
    }, [confirmPrune, confirmReclaim]);

    const handlePrune = async () => {
        if (!confirmPrune || !prunePlan) return;
        setIsActioning(true);
        const loadingId = toast.loading(`Pruning ${confirmPrune.target}...`);
        try {
            const { res, data } = await executeFingerprintPrune(
                { target: confirmPrune.target, scope: confirmPrune.scope },
                prunePlan.fingerprint,
            );
            if (!res.ok) {
                throw new Error(data?.error || `Failed to prune ${confirmPrune.target}`);
            }
            const scopeLabel = confirmPrune.scope === 'managed' ? 'Sencho-managed' : 'all';
            const reclaimed = typeof data?.reclaimedBytes === 'number' ? data.reclaimedBytes : undefined;
            const outcomes = Array.isArray(data?.outcomes) ? data.outcomes : [];
            const failed = outcomes.filter((o: { status?: string }) => o.status === 'failed');
            const reclaimedLabel = reclaimed !== undefined
                ? ` Reclaimed ${formatBytes(reclaimed)}.`
                : '';
            if (failed.length > 0 && failed.length === outcomes.length) {
                toast.error(`Failed to prune ${confirmPrune.target}.`);
            } else if (failed.length > 0) {
                toast.warning(`Some ${confirmPrune.target} could not be pruned.${reclaimedLabel}`);
            } else {
                toast.success(`Pruned ${scopeLabel} ${confirmPrune.target}.${reclaimedLabel}`);
            }
            await refreshAll();
            setConfirmPrune(null);
        } catch (error) {
            console.error('Failed to prune', error);
            const err = error as { message?: string };
            toast.error(err?.message || `Failed to prune ${confirmPrune.target}`);
            // Keep the dialog open on stale-plan so the operator can re-confirm.
        } finally {
            toast.dismiss(loadingId);
            setIsActioning(false);
        }
    };

    const handleDelete = async () => {
        if (!confirmDelete) return;
        setIsActioning(true);
        const loadingId = toast.loading(`Deleting ${confirmDelete.type.slice(0, -1)}...`);
        try {
            const res = await apiFetch(`/system/${confirmDelete.type}/delete`, {
                method: 'POST',
                body: JSON.stringify({ id: confirmDelete.id })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || `Failed to delete ${confirmDelete.type.slice(0, -1)}`);
            }
            toast.success(`Deleted ${confirmDelete.type.slice(0, -1)}`);
            await refreshAll();
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || `Failed to delete ${confirmDelete.type.slice(0, -1)}`));
        } finally {
            toast.dismiss(loadingId);
            setIsActioning(false);
            setConfirmDelete(null);
        }
    };

    const totalOrphansCount = Object.values(orphans).flat().length;
    // The selection is valid only for the read it was made on: a different
    // payload (a refresh, or another node's list) reads as empty even when it
    // re-lists the same ids, and only ids this payload holds can be selected,
    // so a purge never carries one the operator cannot see.
    const orphanIdSet = new Set(Object.values(orphans).flat().map(c => c.Id));
    const selectedOrphans = orphanSelection.list === orphansRegion.data
        ? orphanSelection.ids.filter(id => orphanIdSet.has(id))
        : [];
    const toggleOrphan = (id: string) =>
        setOrphanSelection(prev => {
            const ids = prev.list === orphansRegion.data ? prev.ids : [];
            return {
                list: orphansRegion.data,
                ids: ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id],
            };
        });
    const selectAllOrphans = () => {
        const allIds = [...orphanIdSet];
        setOrphanSelection({
            list: orphansRegion.data,
            ids: selectedOrphans.length === allIds.length ? [] : allIds,
        });
    };

    const handlePurgeOrphans = async () => {
        setIsActioning(true);
        const loadingId = toast.loading('Purging external containers...');
        try {
            const res = await apiFetch('/system/prune/orphans', {
                method: 'POST',
                body: JSON.stringify({ containerIds: selectedOrphans })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to purge selected containers');
            }
            const data: { results?: Array<{ success: boolean; error?: string }> } | null = await res.json().catch(() => null);
            if (!data?.results) {
                // Nothing says which containers were removed, so success is not claimed.
                toast.warning('The purge finished but its result could not be read. Check the list below.');
                await refreshAll();
                return;
            }
            const failed = data.results.filter(r => !r.success);
            if (failed.length === 0) {
                toast.success(`Purged ${selectedOrphans.length} external container(s)`);
            } else if (failed.length === selectedOrphans.length) {
                toast.error(failed[0].error || 'Failed to purge selected containers.');
            } else {
                toast.warning(`Purged ${selectedOrphans.length - failed.length} of ${selectedOrphans.length} external containers. ${failed[0].error ?? 'Some could not be removed.'}`);
            }
            await refreshAll();
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || 'Failed to purge selected containers.'));
        } finally {
            toast.dismiss(loadingId);
            setIsActioning(false);
            setBulkPurgeConfirm(false);
        }
    };

    const filteredImages = images.filter(img =>
        (imageFilter === 'managed' ? img.managedStatus === 'managed' :
            imageFilter === 'unmanaged' ? img.managedStatus !== 'managed' : true) &&
        (imageSearch === '' || (img.RepoTags?.[0] || '').toLowerCase().includes(imageSearch.toLowerCase()))
    );
    const filteredVolumes = volumes.filter(vol =>
        (volumeFilter === 'managed' ? vol.managedStatus === 'managed' :
            volumeFilter === 'unmanaged' ? vol.managedStatus !== 'managed' : true) &&
        (volumeSearch === '' || vol.Name.toLowerCase().includes(volumeSearch.toLowerCase()))
    );

    const imageSort = useTableSort(filteredImages, IMAGE_COMPARATORS, 'repo');
    const volumeSort = useTableSort(filteredVolumes, VOLUME_COMPARATORS, 'name');

    // The inventory read is slow by design (the gateway gives it a 30 second
    // budget) while the other regions answer on the interactive budget. A node
    // that is not answering is established by the first of those reads to
    // fail, so the tables and the usage card name it from that read instead of
    // sitting on a skeleton for the slow read's whole budget. The slow read's
    // own answer replaces it if it lands.
    const siblingRegions = [orphansRegion, rollbackRegion, scanSummariesRegion];
    let siblingUnreadable: RemoteReadFailure | null = null;
    for (const region of siblingRegions) {
        if (region.data !== null || region.status !== 'failed') continue;
        const failure = remoteReadFailureOf(region.error);
        if (isUnreadableNode(failure)) {
            siblingUnreadable = failure;
            break;
        }
    }
    const inventoryFailure: RemoteReadFailure | null = inventoryRegion.data !== null
        ? null
        : inventoryRegion.status === 'failed'
            ? remoteReadFailureOf(inventoryRegion.error)
            : siblingUnreadable;
    const inventoryUnavailable = inventoryFailure !== null;
    const inventoryLoading = inventoryRegion.data === null && !inventoryUnavailable;
    // Every cause the page can name is named; only the catch-alls (a plain
    // status or an unclassified error) keep the existing short copy.
    const nodeName = activeNode?.name;
    const reasonFor = (failure: RemoteReadFailure | null): string | null => (
        isNamedReadFailure(failure) ? remoteReadFailureMessage(failure, { nodeName }) : null
    );
    const inventoryFailureReason = reasonFor(inventoryFailure);
    // The external tab names its own read's cause, never the inventory read's.
    const orphansFailureReason = reasonFor(
        orphansRegion.data === null && orphansRegion.status === 'failed' ? remoteReadFailureOf(orphansRegion.error) : null,
    );
    // The usage figures settle from the same sibling read; a usage answer of its
    // own, success or failure, takes precedence.
    const usage: UsageLoad = usageLoad.status === 'ready' || (usageLoad.status === 'error' && usageLoad.failure)
        ? usageLoad
        : siblingUnreadable !== null
            ? { status: 'error', failure: siblingUnreadable }
            : usageLoad;

    /**
     * The recovery action behind a Retry. The regions and disk usage are
     * independent reads, but they fail together on the same node, so one Retry
     * must recover everything that is unavailable: retrying only the table left
     * the header on "Disk usage unknown" beside a loaded table. A region that
     * already has rows is left alone.
     */
    const retryPage = () => {
        // A slow inventory read that is still pending is healthy as far as the
        // page knows: refreshing it would abort it and restart its budget.
        if (inventoryRegion.data === null && inventoryRegion.status === 'failed') void inventoryRegion.refresh();
        for (const region of siblingRegions) {
            if (region.data === null && region.status === 'failed') void region.refresh();
        }
        // The derived usage state can be a sibling's cause while the disk-usage
        // read is still pending; only its own failure is retried, so a slow
        // read that may still land is not aborted.
        if (usageLoad.status === 'error') void loadUsage();
    };

    const mastheadModel = deriveResourcesMastheadState(usage, nodeName);
    const totalReclaimableBytes = mastheadModel.reclaimableBytes;

    // The phone masthead restates the inventory; an unread inventory says so
    // rather than reporting zero images, volumes, and networks.
    const inventoryMeta = inventoryRegion.data !== null
        ? `${images.length} images · ${volumes.length} volumes · ${networks.length} networks`
        : inventoryUnavailable
            ? 'Resource inventory unavailable'
            : 'Reading resource inventory';

    // Reclaim frees everything the masthead advertises. Order matters:
    // volumes first, while stopped containers still hold a reference to their
    // named volumes, so the prune only removes volumes that are already dangling
    // and a stopped stack's data is never cascaded into deletion. Containers
    // next, then images, so images a stopped container pinned become reclaimable.
    // A partial failure is reported as a warning and a total failure as an error
    // (never a false success); the reclaimed figure is shown only when the
    // daemon reports one (the containerd image store returns 0).
    const handleReclaimAll = async () => {
        if (!prunePlan) return;
        setIsActioning(true);
        const loadingId = toast.loading('Reclaiming disk space...');
        try {
            const { res, data } = await executeFingerprintPrune(
                { targets: ['volumes', 'containers', 'images'], scope: 'all' },
                prunePlan.fingerprint,
            );
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to reclaim disk space');
            }
            const reclaimed = typeof data?.reclaimedBytes === 'number' ? data.reclaimedBytes : 0;
            const reclaimedLabel = reclaimed > 0 ? ` Freed ${formatBytes(reclaimed)}.` : '';
            const outcomes = Array.isArray(data?.outcomes) ? data.outcomes : [];
            const failed = outcomes.filter((o: { status?: string }) => o.status === 'failed');
            if (failed.length > 0 && failed.length === outcomes.length) {
                toast.error('Failed to reclaim disk space.');
            } else if (failed.length > 0) {
                toast.warning(`Some items could not be pruned.${reclaimedLabel}`);
            } else {
                toast.success(`Reclaimed unused images, stopped containers, and dangling volumes.${reclaimedLabel}`);
            }
            await refreshAll();
            setConfirmReclaim(false);
        } catch (error) {
            console.error('Failed to reclaim', error);
            const err = error as { message?: string };
            toast.error(err?.message || 'Failed to reclaim disk space.');
            // Keep the dialog open on stale-plan so the operator can re-confirm.
        } finally {
            toast.dismiss(loadingId);
            setIsActioning(false);
        }
    };

    const actions = (
        <ResourcesActions
            isAdmin={isAdmin}
            canReclaim={mastheadModel.reclaimableItems > 0}
            reclaimDisabled={usage.status === 'loading'}
            usageFailed={usage.status === 'error'}
            onRetryUsage={retryPage}
            onReclaim={() => setConfirmReclaim(true)}
            onPrune={(target) => setConfirmPrune({ target, scope: 'managed' })}
        />
    );

    const mainContent = (
        <>
            {/* Resource Tabs */}
            <Tabs
                value={resourceTab}
                onValueChange={(v) => setResourceTab(v as typeof resourceTab)}
                className="flex-1 flex flex-col w-full min-h-[400px]"
            >
                {isMobile ? (
                    <>
                    <div className="mb-3">{actions}</div>
                    <MobileSubTabs
                        ariaLabel="Resource sections"
                        active={resourceTab}
                        onSelect={setResourceTab}
                        tabs={[
                            { value: 'images', label: 'Images', count: inventoryRegion.data === null ? undefined : images.length },
                            { value: 'volumes', label: 'Volumes', count: inventoryRegion.data === null ? undefined : volumes.length },
                            { value: 'unmanaged', label: 'External', count: orphansRegion.data === null ? undefined : totalOrphansCount },
                            { value: 'rollback', label: 'Rollback', count: rollbackRegion.data === null ? undefined : rollbackGenerations.length },
                        ]}
                    />
                    </>
                ) : (
                <div className="flex items-center gap-3 mb-4 flex-wrap rounded-lg border border-card-border bg-card/40 px-2.5 py-1.5">
                    <TabsList className="border-transparent bg-transparent max-md:w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]">
                        <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
                            {(['images', 'volumes'] as const).map(tab => (
                                <TabsHighlightItem key={tab} value={tab}>
                                    <TabsTrigger value={tab}>
                                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                        {inventoryRegion.data !== null && (
                                            <span className="ml-1.5 text-[10px] text-stat-subtitle tabular-nums">
                                                {tab === 'images' ? images.length : volumes.length}
                                            </span>
                                        )}
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            ))}
                            <TabsHighlightItem value="unmanaged">
                                <TabsTrigger value="unmanaged" className="relative">
                                    External
                                    {orphansRegion.data !== null && (
                                        <span className="ml-1.5 text-[10px] text-stat-subtitle tabular-nums">{totalOrphansCount}</span>
                                    )}
                                </TabsTrigger>
                            </TabsHighlightItem>
                            <TabsHighlightItem value="rollback">
                                <TabsTrigger value="rollback" className="relative">
                                    Rollback
                                    {rollbackRegion.data !== null && (
                                        <span className="ml-1.5 text-[10px] text-stat-subtitle tabular-nums">{rollbackGenerations.length}</span>
                                    )}
                                </TabsTrigger>
                            </TabsHighlightItem>
                        </TabsHighlight>
                    </TabsList>
                    <div className="ml-auto">{actions}</div>
                </div>
                )}

                <div className="flex-1 relative">

                    {/* Images */}
                    <TabsContent value="images" className="m-0 border-0 p-0 animate-in fade-in-0 duration-200">
                        <div className="flex flex-wrap items-center gap-2 mb-4">
                            <CollapsibleSearch value={imageSearch} onChange={setImageSearch} noun="images" />
                            <ResourceFilterControl
                                noun="images"
                                value={imageFilter}
                                onChange={setImageFilter}
                                counts={{
                                    all: images.length,
                                    managed: images.filter(i => i.managedStatus === 'managed').length,
                                    unmanaged: images.filter(i => i.managedStatus !== 'managed').length,
                                }}
                            />
                            <div className="flex-1" />
                            {isAdmin && (
                                <Button variant="outline" size="sm" className="h-9 shrink-0 max-md:min-h-11" onClick={() => setConfirmPrune({ target: 'images', scope: 'managed' })}>
                                    Prune unused
                                </Button>
                            )}
                            {trivy.available && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-9 gap-2 shrink-0"
                                    onClick={() => {
                                        window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
                                            detail: { view: 'security', tab: 'history' },
                                        }));
                                    }}
                                    aria-label="Open scan history"
                                >
                                    <History className="w-4 h-4" strokeWidth={1.5} />
                                    Scan history
                                </Button>
                            )}
                        </div>
                        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
                        <ScrollArea className="h-[62vh] max-md:h-auto">
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <TableHead className="w-[120px] text-[11px]">ID</TableHead>
                                    <SortableTableHead label="Repository:Tag" columnKey="repo" activeKey={imageSort.sortKey} dir={imageSort.sortDir} onSort={imageSort.toggleSort} />
                                    <SortableTableHead label="Size" columnKey="size" activeKey={imageSort.sortKey} dir={imageSort.sortDir} onSort={imageSort.toggleSort} />
                                    <SortableTableHead label="Status" columnKey="status" activeKey={imageSort.sortKey} dir={imageSort.sortDir} onSort={imageSort.toggleSort} />
                                    <TableHead className="text-right text-[11px]">Action</TableHead>
                                </TableRow>
                            </TableHeader>
                            {inventoryLoading ? <TableSkeleton cols={5} /> : inventoryUnavailable ? (
                                <TableLoadError cols={5} noun="images" reason={inventoryFailureReason} onRetry={retryPage} />
                            ) : (
                                <TableBody>
                                    {imageSort.sorted.length === 0 ? (
                                        <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">No images found.</TableCell></TableRow>
                                    ) : imageSort.sorted.map((img, i) => (
                                        <TableRow
                                            key={img.Id}
                                            className="animate-in fade-in-0 duration-200 hover:bg-muted/30 transition-colors"
                                            style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                                        >
                                            <TableCell className="font-mono text-xs text-muted-foreground">{img.Id.split(':')[1]?.substring(0, 12)}</TableCell>
                                            <TableCell className="font-medium">{img.RepoTags?.[0] || '<none>:<none>'}</TableCell>
                                            <TableCell className="font-mono text-xs tabular-nums">{formatBytes(img.Size)}</TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <Badge variant={img.Containers > 0 ? "default" : "secondary"} className="text-[10px] h-5">
                                                        {img.Containers > 0 ? "In Use" : "Unused"}
                                                    </Badge>
                                                    <ManagedBadge
                                                        status={img.managedStatus}
                                                        managedBy={img.managedBy}
                                                        usedByStacks={img.usedByStacks}
                                                        onOpenStack={activeNode ? (stack) => window.dispatchEvent(
                                                            new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, { detail: { nodeId: activeNode.id, stackName: stack } }),
                                                        ) : undefined}
                                                    />
                                                    {img.isSencho && <SenchoBadge />}
                                                    {img.rollbackProtected && <RollbackProtectedBadge kind={img.rollbackProtectionKind} onOpen={() => setResourceTab('rollback')} />}
                                                    {(() => {
                                                        const tag = img.RepoTags?.[0];
                                                        const summary = tag ? scanSummaries[tag] : undefined;
                                                        if (!summary) return null;
                                                        return <SeverityBadge summary={summary} onClick={() => setInspectScanId(summary.scan_id)} />;
                                                    })()}
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    <TooltipProvider>
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
                                                                    onClick={() => {
                                                                        if (!activeNode) return;
                                                                        setInspectImage({ ...img, nodeId: activeNode.id });
                                                                    }}
                                                                    aria-label={`Inspect ${img.RepoTags?.[0] || 'image'}`}
                                                                >
                                                                    <Eye className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                                </Button>
                                                            </TooltipTrigger>
                                                            <TooltipContent>Inspect image</TooltipContent>
                                                        </Tooltip>
                                                    </TooltipProvider>
                                                    {trivy.available && canDeployResources && img.RepoTags?.[0] && img.RepoTags[0] !== '<none>:<none>' && (
                                                        <DropdownMenu>
                                                            <TooltipProvider>
                                                                <Tooltip>
                                                                    <TooltipTrigger asChild>
                                                                        <DropdownMenuTrigger asChild>
                                                                            <Button
                                                                                variant="ghost"
                                                                                size="icon"
                                                                                className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
                                                                                disabled={scanningImageRef === img.RepoTags[0]}
                                                                                aria-label={`Scan ${img.RepoTags[0]}`}
                                                                            >
                                                                                {scanningImageRef === img.RepoTags[0] ? (
                                                                                    <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                                                                                ) : (
                                                                                    <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                                                )}
                                                                            </Button>
                                                                        </DropdownMenuTrigger>
                                                                    </TooltipTrigger>
                                                                    <TooltipContent>Scan for vulnerabilities</TooltipContent>
                                                                </Tooltip>
                                                            </TooltipProvider>
                                                            <DropdownMenuContent align="end">
                                                                <DropdownMenuItem
                                                                    onClick={() => void scanImage(img.RepoTags![0], ['vuln'], { force: false })}
                                                                >
                                                                    Scan (vulnerabilities)
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem
                                                                    onClick={() => void scanImage(img.RepoTags![0], ['vuln', 'secret'], { force: false })}
                                                                >
                                                                    Full scan (vulnerabilities + secrets)
                                                                </DropdownMenuItem>
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                    )}
                                                    {isAdmin && (
                                                        <TooltipProvider>
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <span className={img.isSencho ? 'cursor-not-allowed' : undefined}>
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="icon"
                                                                            className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-destructive/60"
                                                                            disabled={img.isSencho}
                                                                            aria-label={`Delete image ${img.RepoTags?.[0] || img.Id.substring(0, 12)}`}
                                                                            onClick={() => setConfirmDelete({ type: 'images', id: img.Id, name: img.RepoTags?.[0] })}
                                                                        >
                                                                            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                                        </Button>
                                                                    </span>
                                                                </TooltipTrigger>
                                                                {img.isSencho && <TooltipContent>Protected · running Sencho instance</TooltipContent>}
                                                            </Tooltip>
                                                        </TooltipProvider>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            )}
                        </Table>
                        </ScrollArea>
                        </div>
                    </TabsContent>

                    {/* Volumes */}
                    <TabsContent value="volumes" className="m-0 border-0 p-0 animate-in fade-in-0 duration-200">
                        <div className="flex flex-wrap items-center gap-2 mb-4">
                            <CollapsibleSearch value={volumeSearch} onChange={setVolumeSearch} noun="volumes" />
                            <ResourceFilterControl
                                noun="volumes"
                                value={volumeFilter}
                                onChange={setVolumeFilter}
                                counts={{
                                    all: volumes.length,
                                    managed: volumes.filter(v => v.managedStatus === 'managed').length,
                                    unmanaged: volumes.filter(v => v.managedStatus !== 'managed').length,
                                }}
                            />
                            <div className="flex-1" />
                            {isAdmin && (
                                <Button variant="outline" size="sm" className="h-9 shrink-0 max-md:min-h-11" onClick={() => setConfirmPrune({ target: 'volumes', scope: 'managed' })}>
                                    Prune unused
                                </Button>
                            )}
                        </div>
                        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
                        <ScrollArea className="h-[62vh] max-md:h-auto">
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <SortableTableHead label="Name" columnKey="name" activeKey={volumeSort.sortKey} dir={volumeSort.sortDir} onSort={volumeSort.toggleSort} />
                                    <SortableTableHead label="Driver" columnKey="driver" activeKey={volumeSort.sortKey} dir={volumeSort.sortDir} onSort={volumeSort.toggleSort} />
                                    <TableHead className="hidden md:table-cell text-[11px]">Mountpoint</TableHead>
                                    <TableHead className="text-[11px]">Status</TableHead>
                                    <TableHead className="text-right text-[11px]">Action</TableHead>
                                </TableRow>
                            </TableHeader>
                            {inventoryLoading ? <TableSkeleton cols={5} /> : inventoryUnavailable ? (
                                <TableLoadError cols={5} noun="volumes" reason={inventoryFailureReason} onRetry={retryPage} />
                            ) : (
                                <TableBody>
                                    {volumeSort.sorted.length === 0 ? (
                                        <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">No volumes found.</TableCell></TableRow>
                                    ) : volumeSort.sorted.map((vol, i) => (
                                        <TableRow
                                            key={vol.Name}
                                            className="animate-in fade-in-0 duration-200 hover:bg-muted/30 transition-colors"
                                            style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                                        >
                                            <TableCell className="font-mono text-xs max-w-[200px]"><VolumeNameLabel name={vol.Name} showChip /></TableCell>
                                            <TableCell><Badge variant="outline" className="text-[10px] h-5">{vol.Driver}</Badge></TableCell>
                                            <TableCell className="hidden md:table-cell text-xs text-muted-foreground truncate max-w-[300px]">{vol.Mountpoint}</TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <ManagedBadge status={vol.managedStatus} managedBy={vol.managedBy} />
                                                    {vol.isSencho && <SenchoBadge />}
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    {canReadResources && (
                                                        <TooltipProvider>
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
                                                                        onClick={() => setBrowseVolume(vol.Name)}
                                                                        aria-label={`Browse ${vol.Name}`}
                                                                    >
                                                                        <FolderOpen className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                                    </Button>
                                                                </TooltipTrigger>
                                                                <TooltipContent>Browse volume contents</TooltipContent>
                                                            </Tooltip>
                                                        </TooltipProvider>
                                                    )}
                                                    {isAdmin && (
                                                        <TooltipProvider>
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <span className={vol.isSencho ? 'cursor-not-allowed' : undefined}>
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="icon"
                                                                            className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-destructive/60"
                                                                            disabled={vol.isSencho}
                                                                            aria-label={`Delete volume ${vol.Name}`}
                                                                            onClick={() => setConfirmDelete({ type: 'volumes', id: vol.Name, name: vol.Name })}
                                                                        >
                                                                            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                                        </Button>
                                                                    </span>
                                                                </TooltipTrigger>
                                                                {vol.isSencho && <TooltipContent>Protected · running Sencho instance</TooltipContent>}
                                                            </Tooltip>
                                                        </TooltipProvider>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            )}
                        </Table>
                        </ScrollArea>
                        </div>
                    </TabsContent>

                    {/* Unmanaged Containers */}
                    <TabsContent value="unmanaged" className="m-0 border-0 p-0 h-full flex flex-col animate-in fade-in-0 duration-200">
                        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
                        <div className="flex justify-between items-center px-4 py-2.5 border-b bg-muted/10 sticky top-0 z-10">
                            <div className="flex items-center gap-2.5">
                                <Checkbox
                                    id="select-all-external"
                                    aria-label="Select all external containers"
                                    onCheckedChange={selectAllOrphans}
                                    checked={selectedOrphans.length === totalOrphansCount && totalOrphansCount > 0}
                                />
                                <label htmlFor="select-all-external" className="text-xs font-medium text-muted-foreground">Select all</label>
                            </div>
                            {isAdmin && <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs gap-1.5 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                                onClick={() => setBulkPurgeConfirm(true)}
                                disabled={selectedOrphans.length === 0 || isActioning}
                            >
                                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                {`Purge selected (${selectedOrphans.length})`}
                            </Button>}
                        </div>

                        {orphansRegion.data === null ? (
                            orphansRegion.status === 'failed' ? (
                                <div className="flex flex-col items-center gap-3 p-12 text-sm text-muted-foreground">
                                    <span>Could not load external containers.</span>
                                    {orphansFailureReason ? (
                                        <span className="text-xs text-stat-subtitle">{orphansFailureReason}</span>
                                    ) : null}
                                    <Button variant="outline" size="sm" className="text-stat-title" onClick={retryPage}>Retry</Button>
                                </div>
                            ) : (
                                <div className="p-4"><Skeleton className="h-24 w-full rounded-md" /></div>
                            )
                        ) : totalOrphansCount === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center p-12 text-muted-foreground animate-in fade-in-0 duration-300">
                                <div className="w-12 h-12 rounded-full bg-success-muted flex items-center justify-center mb-3">
                                    <ShieldCheck className="w-6 h-6 text-success" />
                                </div>
                                <p className="font-medium text-sm">No external containers</p>
                                <p className="text-xs mt-1 opacity-70">All running containers are managed by Sencho.</p>
                            </div>
                        ) : (
                            <div className="p-4 space-y-3 pb-12">
                                {Object.entries(orphans).map(([project, containers]) => (
                                    <div
                                        key={project}
                                        className="bg-card rounded-lg border shadow-card-bevel overflow-hidden text-sm"
                                    >
                                        {/* Project header */}
                                        <div className="bg-muted/20 border-b border-border/60 px-4 py-2 font-medium text-xs flex items-center gap-2">
                                            <span className="font-mono text-foreground">{project}</span>
                                            <span className="ml-auto text-muted-foreground font-normal">{containers.length} container{containers.length !== 1 ? 's' : ''}</span>
                                        </div>
                                        <div className="divide-y divide-border/50">
                                            {containers.map((container: UnmanagedContainer) => (
                                                <div
                                                    key={container.Id}
                                                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors duration-150"
                                                >
                                                    <Checkbox
                                                        aria-label={`Select ${container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12)}`}
                                                        checked={selectedOrphans.includes(container.Id)}
                                                        onCheckedChange={() => toggleOrphan(container.Id)}
                                                    />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-mono text-xs font-medium truncate">
                                                                {container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12)}
                                                            </span>
                                                            <Badge
                                                                variant={container.State === 'running' ? 'default' : 'secondary'}
                                                                className="text-[9px] h-4 px-1.5"
                                                            >
                                                                {container.State}
                                                            </Badge>
                                                        </div>
                                                        <div className="text-[11px] text-muted-foreground truncate mt-0.5 font-mono">
                                                            {container.Image}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        </div>
                    </TabsContent>

                    {/* Rollback */}
                    <TabsContent value="rollback" className="m-0 border-0 p-0 animate-in fade-in-0 duration-200">
                        <RollbackGenerationsTab
                            generations={rollbackGenerations}
                            isLoading={rollbackRegion.data === null && rollbackRegion.status !== 'failed'}
                            loadError={rollbackRegion.data === null && rollbackRegion.status === 'failed'}
                            loadErrorReason={reasonFor(
                                rollbackRegion.data === null && rollbackRegion.status === 'failed'
                                    ? remoteReadFailureOf(rollbackRegion.error)
                                    : null,
                            )}
                            onRetry={retryPage}
                            isAdmin={isAdmin}
                            nodeId={activeNode?.id}
                            onReleased={refreshAll}
                        />
                    </TabsContent>
                </div>
            </Tabs>
        </>
    );

    const overlays = (
        <>
            {/* ── Dialogs ── */}

            {/* Prune Confirm */}
            <ConfirmModal
                open={!!confirmPrune}
                onOpenChange={(open) => !open && setConfirmPrune(null)}
                variant="destructive"
                kicker="RESOURCES · PRUNE · IRREVERSIBLE"
                title={
                    confirmPrune?.scope === 'all'
                        ? `Prune all Docker ${confirmPrune?.target}`
                        : `Prune Sencho-managed ${confirmPrune?.target}`
                }
                hint={confirmPrune?.scope === 'all' ? 'AFFECTS external Docker resources' : 'KEEPS external resources'}
                confirmLabel={
                    planLoading
                        ? 'Preparing...'
                        : prunePlan && prunePlan.reclaimableBytes > 0
                            ? `Prune · ${formatBytes(prunePlan.reclaimableBytes)}`
                            : (confirmPrune?.scope === 'all' ? 'Prune all' : 'Prune')
                }
                busyConfirmLabel="Pruning..."
                confirming={isActioning}
                confirmDisabled={planLoading || !prunePlan || !!planError || (prunePlan?.items.length ?? 0) === 0}
                onConfirm={handlePrune}
            >
                <div className="space-y-3 text-sm text-stat-subtitle">
                    {confirmPrune && (
                        <SegmentedControl<PruneScope>
                            ariaLabel="Prune scope"
                            value={confirmPrune.scope}
                            disabled={isActioning}
                            onChange={(scope) => setConfirmPrune((current) => (current && current.scope !== scope ? { ...current, scope } : current))}
                            options={[
                                { value: 'managed', label: 'Sencho-managed' },
                                { value: 'all', label: 'All Docker' },
                            ]}
                        />
                    )}
                    <p>
                        {confirmPrune?.scope === 'all' ? (
                            <>
                                Prunes <span className="font-medium text-stat-value">all</span> unused {confirmPrune?.target} from the Docker daemon, including those from{' '}
                                <span className="font-medium text-stat-value">external projects not managed by Sencho</span>.
                            </>
                        ) : (
                            <>
                                Removes only unused {confirmPrune?.target} belonging to your Sencho stacks. External Docker resources are{' '}
                                <span className="font-medium text-stat-value">not affected</span>.
                            </>
                        )}
                    </p>
                    <PrunePlanPreview plan={prunePlan} loading={planLoading} error={planError} />
                </div>
            </ConfirmModal>

            {/* Reclaim Confirm (masthead Reclaim) */}
            <ConfirmModal
                open={confirmReclaim}
                onOpenChange={(open) => !open && setConfirmReclaim(false)}
                variant="destructive"
                kicker="RESOURCES · RECLAIM · IRREVERSIBLE"
                title="Reclaim disk space"
                hint="AFFECTS external Docker resources"
                confirmLabel={
                    planLoading
                        ? 'Preparing...'
                        : `Reclaim ${formatBytes(prunePlan?.reclaimableBytes ?? totalReclaimableBytes)}`
                }
                busyConfirmLabel="Reclaiming..."
                confirming={isActioning}
                confirmDisabled={planLoading || !prunePlan || !!planError || (prunePlan?.items.length ?? 0) === 0}
                onConfirm={handleReclaimAll}
            >
                <div className="space-y-3 text-sm text-stat-subtitle">
                    <p>
                        Removes every unused image, stopped container, and dangling volume on this node, including those from{' '}
                        <span className="font-medium text-stat-value">external projects not managed by Sencho</span>.
                    </p>
                    <PrunePlanPreview plan={prunePlan} loading={planLoading} error={planError} />
                </div>
            </ConfirmModal>

            {/* Delete Confirm */}
            <ConfirmModal
                open={!!confirmDelete}
                onOpenChange={(open) => !open && setConfirmDelete(null)}
                variant="destructive"
                kicker="RESOURCES · DELETE · IRREVERSIBLE"
                title={`Delete ${confirmDelete?.type.slice(0, -1) ?? ''}`}
                confirmLabel="Delete"
                busyConfirmLabel="Deleting..."
                confirming={isActioning}
                onConfirm={handleDelete}
            >
                <p className="text-sm text-stat-subtitle">
                    Permanently deletes{' '}
                    <span className="font-mono font-medium text-stat-value">
                        {confirmDelete?.name || confirmDelete?.id.substring(0, 12)}
                    </span>.
                </p>
            </ConfirmModal>

            {/* External Container Purge Confirm */}
            <ConfirmModal
                open={bulkPurgeConfirm}
                onOpenChange={setBulkPurgeConfirm}
                variant="destructive"
                kicker="RESOURCES · PURGE · IRREVERSIBLE"
                title="Purge selected external containers"
                hint={`AFFECTS ${selectedOrphans.length} container${selectedOrphans.length !== 1 ? 's' : ''}`}
                confirmLabel="Purge"
                busyConfirmLabel="Purging..."
                confirming={isActioning}
                onConfirm={handlePurgeOrphans}
            >
                <p className="text-sm text-stat-subtitle">
                    Force-stops and removes {selectedOrphans.length} container{selectedOrphans.length !== 1 ? 's' : ''} from external projects not managed by Sencho.
                </p>
            </ConfirmModal>

            {/* Image Details Sheet */}
            <ImageDetailsSheet
                image={inspectImage && activeNode && inspectImage.nodeId === activeNode.id ? inspectImage : null}
                onClose={() => setInspectImage(null)}
                onOpenStack={activeNode ? (stack) => window.dispatchEvent(
                    new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, { detail: { nodeId: activeNode.id, stackName: stack } }),
                ) : undefined}
            />

            {/* Volume Browser Sheet */}
            <VolumeBrowserSheet volumeName={browseVolume} onClose={() => setBrowseVolume(null)} />

            <VulnerabilityScanSheet
                scanId={inspectScanId}
                onClose={() => setInspectScanId(null)}
                onRescan={canDeployResources ? (imageRef) => { setInspectScanId(null); void scanImage(imageRef, undefined, { force: true }); } : undefined}
                canGenerateSbom={canReadResources}
                canExportSarif={canReadResources}
                canCompare
                canManageSuppressions={canEditSecurityPolicy}
            />
        </>
    );

    if (isMobile) {
        return (
            <div className="flex h-full min-h-0 flex-col">
                <Masthead
                    kicker="resources · docker"
                    state={mastheadModel.state}
                    stateTone={MOBILE_STATE_TONE[mastheadModel.tone]}
                    live={false}
                    meta={inventoryMeta}
                    right={headerActions}
                />
                <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-4 [&_[data-radix-scroll-area-viewport]>div]:!block [&_table]:min-w-[640px]">
                    {mainContent}
                </div>
                {overlays}
            </div>
        );
    }

    return (
        <div className="p-6 h-full overflow-auto text-foreground flex flex-col gap-6 animate-in fade-in-0 duration-300">
            <PageMasthead
                kicker={`resources · ${activeNode?.name ?? 'local'}`}
                state={mastheadModel.state}
                tone={mastheadModel.tone}
                subtitle={mastheadModel.subtitle}
                metadata={mastheadModel.metadata}
                size="hero"
                className="rounded-lg"
            />
            {mainContent}
            {overlays}
        </div>
    );
}

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Masthead, MobileSubTabs } from '@/components/mobile/mobile-ui';
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from "@/components/ui/tabs";
import { springs } from '@/lib/motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmModal } from "@/components/ui/modal";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Trash2, HardDrive, Network, PackageMinus, MonitorX, MoreVertical, AlertTriangle, ShieldCheck, Eye, Loader2, History, FolderOpen, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SeverityBadge } from '@/components/ui/SeverityBadge';
import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import { VulnerabilityScanSheet } from './VulnerabilityScanSheet';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from './NodeManager';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import type { ScanSummary } from '@/types/security';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { ReclaimHero } from './resources/ReclaimHero';
import { FootprintTreemap } from './resources/FootprintTreemap';
import { ImageDetailsSheet } from './resources/ImageDetailsSheet';
import { RollbackGenerationsTab, type RollbackGeneration } from './resources/RollbackGenerationsTab';
import { TableSkeleton } from './resources/TableSkeleton';
import { VolumeBrowserSheet } from './resources/VolumeBrowserSheet';
import { VolumeNameLabel } from './resources/VolumeNameLabel';
import { useTableSort } from '@/hooks/useTableSort';
import { SortableTableHead } from '@/components/ui/sortable-table';
import { isPrunePlan, type PrunePlan, type PruneScope, type PruneTarget } from '@/lib/prunePlan';

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface UsageData {
    reclaimableImages: number;
    reclaimableContainers: number;
    reclaimableVolumes: number;
    reclaimableImageCount: number;
    reclaimableContainerCount: number;
    reclaimableVolumeCount: number;
    managedImageBytes: number;
    unmanagedImageBytes: number;
    managedVolumeBytes: number;
    unmanagedVolumeBytes: number;
}

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

// Per-node, per-browser snooze for the reclaim banner. We store the reclaimable
// byte total at the moment of dismissal; the banner returns only once the node's
// reclaimable total grows past that snapshot, so a stable residue stays hidden.
const heroDismissKey = (nodeId: string | number | undefined) => `sencho.reclaimHeroDismissed.${nodeId ?? 'local'}`;

function readHeroDismissed(nodeId: string | number | undefined): number | null {
    try {
        const raw = localStorage.getItem(heroDismissKey(nodeId));
        if (raw === null) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch {
        // localStorage is unavailable (private mode / blocked); treat as
        // not-dismissed so the banner still shows.
        return null;
    }
}

function writeHeroDismissed(nodeId: string | number | undefined, bytes: number): void {
    try {
        localStorage.setItem(heroDismissKey(nodeId), String(bytes));
    } catch {
        // Best-effort: if the write fails the banner simply reappears next load.
    }
}

// ── Filter Toggle - Segmented Control ─────────────────────────────────────────

interface FilterToggleProps {
    value: ResourceFilter;
    onChange: (v: ResourceFilter) => void;
    counts: { all: number; managed: number; unmanaged: number };
}

function FilterToggle({ value, onChange, counts }: FilterToggleProps) {
    const options: { key: ResourceFilter; label: string; count: number }[] = [
        { key: 'all', label: 'All', count: counts.all },
        { key: 'managed', label: 'Managed', count: counts.managed },
        { key: 'unmanaged', label: 'External', count: counts.unmanaged },
    ];

    return (
        <div className="flex items-center gap-1">
            {options.map(({ key, label, count }) => (
                <Button
                    key={key}
                    variant={value === key ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2.5 gap-1.5"
                    onClick={() => onChange(key)}
                >
                    {label}
                    <span className="font-mono tabular-nums text-[10px] opacity-70">{count}</span>
                </Button>
            ))}
        </div>
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

function RollbackProtectedBadge({ kind }: { kind?: 'stack' | 'service' }) {
    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-[10px] h-5 gap-1 border-brand/40 text-brand">
                        <ShieldCheck className="w-3 h-3" strokeWidth={2} />
                        Rollback protected
                    </Badge>
                </TooltipTrigger>
                <TooltipContent>
                    {kind === 'stack'
                        ? 'Held as a full-stack rollback point. See Resources → Rollback.'
                        : 'Held for a pending per-service update rollback.'}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

// ── Severity Badge ─────────────────────────────────────────────────────────────

// ── Quick Clean Prune Button ───────────────────────────────────────────────────

interface PruneButtonProps {
    target: PruneTarget;
    icon: React.ReactNode;
    label: string;
    accentClass: string;
    onManaged: () => void;
    onAll: () => void;
}

function PruneButton({ target, icon, label, accentClass, onManaged, onAll }: PruneButtonProps) {
    return (
        <div className={cn(
            'group flex flex-col rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel overflow-hidden',
            'transition-colors duration-200 hover:border-t-card-border-hover',
        )}>
            <button
                onClick={onManaged}
                className="flex-1 flex flex-col items-center justify-center gap-2 p-3 pt-4 hover:bg-muted/40 transition-colors duration-150"
            >
                <span className={cn('transition-transform duration-200 group-hover:scale-110', accentClass)}>
                    {icon}
                </span>
                <span className="text-xs font-medium text-center leading-tight text-foreground">{label}</span>
                <span className="text-[10px] text-brand font-mono tracking-wide">Sencho only</span>
            </button>
            {target !== 'containers' && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button className={cn(
                            'flex items-center justify-center gap-1 border-t h-7 w-full text-[10px] text-muted-foreground',
                            'hover:bg-muted/40 hover:text-foreground transition-colors duration-150',
                        )}>
                            <MoreVertical className="w-3 h-3" />
                            <span>More options</span>
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-52">
                        <DropdownMenuItem
                            className="text-destructive focus:text-destructive focus:bg-destructive/10 gap-2 text-xs"
                            onClick={onAll}
                        >
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>All Docker <span className="text-muted-foreground">(includes external)</span></span>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
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
    const [usage, setUsage] = useState<UsageData | null>(null);
    const [images, setImages] = useState<DockerImage[]>([]);
    const [volumes, setVolumes] = useState<DockerVolume[]>([]);
    const [networks, setNetworks] = useState<DockerNetwork[]>([]);
    const [orphans, setOrphans] = useState<Record<string, UnmanagedContainer[]>>({});
    const [rollbackGenerations, setRollbackGenerations] = useState<RollbackGeneration[]>([]);

    const [isLoading, setIsLoading] = useState(true);
    const [isActioning, setIsActioning] = useState(false);

    // Filter state
    const [imageFilter, setImageFilter] = useState<ResourceFilter>('all');
    const [volumeFilter, setVolumeFilter] = useState<ResourceFilter>('all');

    // Search state
    const [imageSearch, setImageSearch] = useState('');
    const [volumeSearch, setVolumeSearch] = useState('');
    // Collapsible search: icon-only until clicked, stays open while query is active.
    const [imageSearchExpanded, setImageSearchExpanded] = useState(false);
    const [volumeSearchExpanded, setVolumeSearchExpanded] = useState(false);
    const imageSearchRef = useRef<HTMLInputElement>(null);
    const volumeSearchRef = useRef<HTMLInputElement>(null);

    useEffect(() => { if (imageSearchExpanded) imageSearchRef.current?.focus(); }, [imageSearchExpanded]);
    useEffect(() => { if (volumeSearchExpanded) volumeSearchRef.current?.focus(); }, [volumeSearchExpanded]);

    // Modal states
    const [confirmPrune, setConfirmPrune] = useState<{ target: PruneTarget; scope: PruneScope } | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<{ type: 'images' | 'volumes' | 'networks'; id: string; name?: string } | null>(null);
    const [confirmReclaim, setConfirmReclaim] = useState(false);
    const [prunePlan, setPrunePlan] = useState<PrunePlan | null>(null);
    const [planLoading, setPlanLoading] = useState(false);
    const [planError, setPlanError] = useState<string | null>(null);
    const planFetchGenRef = useRef(0);

    // Reclaim banner visibility: the per-node opt-in setting (loaded in
    // fetchAllData) and the per-browser dismiss snapshot for the active node.
    const [reclaimHeroEnabled, setReclaimHeroEnabled] = useState(false);
    const [heroDismissedBytes, setHeroDismissedBytes] = useState<number | null>(null);

    // Classified image selection is node-bound so a node switch cannot leave
    // the previous node's usedByStacks visible beside a new node's inspect.
    const [inspectImage, setInspectImage] = useState<(DockerImage & { nodeId: string | number }) | null>(null);
    const [browseVolume, setBrowseVolume] = useState<string | null>(null);

    // Unmanaged container state
    const [selectedOrphans, setSelectedOrphans] = useState<string[]>([]);
    const [bulkPurgeConfirm, setBulkPurgeConfirm] = useState(false);

    // Vulnerability scanning state
    const { status: trivy } = useTrivyStatus();
    const [scanSummaries, setScanSummaries] = useState<Record<string, ScanSummary>>({});
    const [scanningImageRef, setScanningImageRef] = useState<string | null>(null);
    const [inspectScanId, setInspectScanId] = useState<number | null>(null);
    // Holds the AbortController for the in-flight scan poll so it can be
    // cancelled; the scan keeps running server-side, only the client poll stops.
    const scanAbortRef = useRef<AbortController | null>(null);

    // Generation counter so a slow fetch for a previously-active node cannot
    // stomp the visible resources after the user switches nodes. Each call
    // claims a generation; only the latest call is allowed to write state.
    const fetchGenerationRef = useRef(0);

    const fetchAllData = async () => {
        const generation = ++fetchGenerationRef.current;
        setIsLoading(true);
        try {
            const [usageRes, resourcesRes, orphansRes, summariesRes, settingsRes, rollbackRes] = await Promise.all([
                apiFetch('/system/docker-df'),
                apiFetch('/system/resources'),
                apiFetch('/system/orphans'),
                apiFetch('/security/image-summaries').catch(() => null),
                apiFetch('/settings').catch(() => null),
                apiFetch('/system/rollback/generations').catch(() => null),
            ]);

            // Resolve every body before the staleness check so a stale
            // generation cannot write any subset of the resource slices.
            const usageData = usageRes.ok ? await usageRes.json() : null;
            const resourcesData = resourcesRes.ok ? await resourcesRes.json() : null;
            const orphansData = orphansRes.ok ? await orphansRes.json() : null;
            const summariesData = summariesRes && summariesRes.ok ? await summariesRes.json() : null;
            const settingsData = settingsRes && settingsRes.ok ? await settingsRes.json() : null;
            const rollbackData = rollbackRes && rollbackRes.ok ? await rollbackRes.json() : null;

            if (fetchGenerationRef.current !== generation) return;

            // Set unconditionally: a failed /settings (settingsData null) or a
            // missing key falls back to the default-off state for this node
            // rather than inheriting the previously active node's value.
            setReclaimHeroEnabled(settingsData?.reclaim_hero === '1');
            if (usageData) setUsage(usageData);
            if (resourcesData) {
                setImages(resourcesData.images ?? []);
                setVolumes(resourcesData.volumes ?? []);
                setNetworks(resourcesData.networks ?? []);
            }
            if (orphansData) {
                setOrphans(orphansData);
                setSelectedOrphans([]);
            }
            if (summariesData) setScanSummaries(summariesData);
            setRollbackGenerations(Array.isArray(rollbackData) ? rollbackData : []);
        } catch (err) {
            if (fetchGenerationRef.current !== generation) return;
            console.error('Failed to fetch data', err);
            toast.error('Failed to load resources data');
        } finally {
            if (fetchGenerationRef.current === generation) setIsLoading(false);
        }
    };

    useEffect(() => { fetchAllData(); }, [activeNode]);

    // Load the per-node reclaim-banner dismiss snapshot when the node changes.
    useEffect(() => {
        setHeroDismissedBytes(readHeroDismissed(activeNode?.id));
        setInspectImage(null);
    }, [activeNode?.id]);

    // Cancel an in-flight scan poll on unmount or node switch; its result
    // belongs to the node it started on.
    useEffect(() => {
        return () => scanAbortRef.current?.abort();
    }, [activeNode]);

    // Bump the fetch generation on unmount so a fetch that resolves after the
    // view is gone cannot run state setters or surface a load-error toast.
    useEffect(() => () => { fetchGenerationRef.current += 1; }, []);

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
            await fetchAllData();
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
            await fetchAllData();
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || `Failed to delete ${confirmDelete.type.slice(0, -1)}`));
        } finally {
            toast.dismiss(loadingId);
            setIsActioning(false);
            setConfirmDelete(null);
        }
    };

    const toggleOrphan = (id: string) =>
        setSelectedOrphans(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

    const totalOrphansCount = Object.values(orphans).flat().length;
    const selectAllOrphans = () => {
        const allIds = Object.values(orphans).flat().map(c => c.Id);
        setSelectedOrphans(selectedOrphans.length === allIds.length ? [] : allIds);
    };

    const handlePurgeOrphans = async () => {
        setIsActioning(true);
        const loadingId = toast.loading('Purging unmanaged containers...');
        try {
            const res = await apiFetch('/system/prune/orphans', {
                method: 'POST',
                body: JSON.stringify({ containerIds: selectedOrphans })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to purge selected containers');
            }
            toast.success(`Purged ${selectedOrphans.length} unmanaged container(s)`);
            await fetchAllData();
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || 'Failed to purge selected containers.'));
        } finally {
            toast.dismiss(loadingId);
            setIsActioning(false);
            setBulkPurgeConfirm(false);
        }
    };

    const handleScanImage = async (
        imageRef: string,
        options: { force?: boolean; scanners?: ('vuln' | 'secret')[] } = {},
    ) => {
        const { force = false, scanners } = options;
        // Supersede any prior in-flight scan poll before claiming this one.
        scanAbortRef.current?.abort();
        const controller = new AbortController();
        scanAbortRef.current = controller;
        const { signal } = controller;
        setScanningImageRef(imageRef);
        const loadingId = toast.loading(`Scanning ${imageRef}...`);
        try {
            const res = await apiFetch('/security/scan', {
                method: 'POST',
                body: JSON.stringify({ imageRef, force, scanners }),
                signal,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Failed to start scan');
            const scanId = data.scanId as number;

            const deadline = Date.now() + 5 * 60 * 1000;
            while (Date.now() < deadline) {
                await new Promise<void>((resolve) => {
                    if (signal.aborted) { resolve(); return; }
                    const timer = setTimeout(resolve, 3000);
                    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
                });
                if (signal.aborted) return;
                const poll = await apiFetch(`/security/scans/${scanId}`, { signal });
                if (signal.aborted) return;
                if (!poll.ok) continue;
                const poll_data = await poll.json();
                if (signal.aborted) return;
                if (poll_data.status !== 'in_progress') {
                    if (poll_data.status === 'failed') {
                        throw new Error(poll_data.error || 'Scan failed');
                    }
                    toast.success(`Scan complete: ${poll_data.total_vulnerabilities} vulnerabilities found`);
                    setInspectScanId(scanId);
                    const summariesRes = await apiFetch('/security/image-summaries', { signal });
                    if (signal.aborted) return;
                    if (summariesRes.ok) {
                        const summaries = await summariesRes.json();
                        if (signal.aborted) return;
                        setScanSummaries(summaries ?? {});
                    }
                    return;
                }
            }
            throw new Error('Scan timed out');
        } catch (error) {
            if (signal.aborted) {
                // Suppress the toast for a deliberately cancelled poll, but keep
                // a breadcrumb so a real error racing the abort is not lost.
                console.debug('Scan poll aborted', error);
                return;
            }
            const err = error as { message?: string; error?: string; data?: { error?: string } };
            toast.error(err?.message || err?.error || err?.data?.error || 'Scan failed');
        } finally {
            toast.dismiss(loadingId);
            // Only the owning poll resets shared state; a superseded poll leaves
            // it to the scan that replaced it.
            if (scanAbortRef.current === controller) {
                scanAbortRef.current = null;
                setScanningImageRef(null);
            }
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

    const handleFootprintFilter = (filter: ResourceFilter) => {
        setImageFilter(filter);
        setVolumeFilter(filter);
    };

    const treemapFilterToResourceFilter = (filter: 'managed' | 'unmanaged' | 'reclaimable'): ResourceFilter => {
        if (filter === 'managed') return 'managed';
        if (filter === 'unmanaged') return 'unmanaged';
        return 'unmanaged';
    };

    const totalReclaimableBytes = (usage?.reclaimableImages ?? 0)
        + (usage?.reclaimableContainers ?? 0)
        + (usage?.reclaimableVolumes ?? 0);

    // Banner shows while the opt-in is on and the operator has not dismissed
    // this (or a larger) reclaimable total. A stable residue stays hidden; a
    // fresh pile pushes the total past the snapshot and the banner returns.
    const heroVisible = isAdmin && reclaimHeroEnabled
        && (heroDismissedBytes === null || totalReclaimableBytes > heroDismissedBytes);

    const handleReviewAndPrune = () => {
        setConfirmReclaim(true);
    };

    const handleDismissHero = () => {
        writeHeroDismissed(activeNode?.id, totalReclaimableBytes);
        setHeroDismissedBytes(totalReclaimableBytes);
    };

    // "Review & prune" reclaims everything the banner advertises. Order matters:
    // volumes first, while stopped containers still hold a reference to their
    // named volumes, so the prune only removes volumes that are already dangling
    // and a stopped stack's data is never cascaded into deletion. Containers
    // next, then images, so images a stopped container pinned become reclaimable.
    // Each failed target is reported by name and its server error logged (never a
    // false success); the reclaimed figure is shown only when the daemon reports
    // one (the containerd image store returns 0).
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
            await fetchAllData();
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

    const mainContent = (
        <>
            {/* Reclaim hero */}
            {heroVisible && usage && (
                <ReclaimHero
                    bytes={totalReclaimableBytes}
                    imageCount={usage.reclaimableImageCount}
                    containerCount={usage.reclaimableContainerCount}
                    volumeCount={usage.reclaimableVolumeCount}
                    onReview={handleReviewAndPrune}
                    onDismiss={handleDismissHero}
                    disabled={isLoading}
                />
            )}

            {/* Top row: Footprint + Quick Clean */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                {/* Disk Footprint */}
                <Card className="col-span-1 border-card-border border-t-card-border-top shadow-card-bevel transition-colors hover:border-t-card-border-hover animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-muted-foreground tracking-wide uppercase">
                            Docker Disk Footprint
                        </CardTitle>
                        <CardDescription className="text-xs">
                            Click a segment to filter the tabs below
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {usage ? (
                            <FootprintTreemap
                                managedBytes={usage.managedImageBytes + usage.managedVolumeBytes}
                                unmanagedBytes={usage.unmanagedImageBytes + usage.unmanagedVolumeBytes}
                                reclaimableBytes={totalReclaimableBytes}
                                onFilter={(f) => handleFootprintFilter(treemapFilterToResourceFilter(f))}
                            />
                        ) : (
                            <Skeleton className="h-[150px] w-full rounded-md" />
                        )}
                    </CardContent>
                </Card>

                {/* Quick Clean */}
                {isAdmin && <Card className="col-span-1 md:col-span-2 border-card-border border-t-card-border-top shadow-card-bevel transition-colors hover:border-t-card-border-hover flex flex-col animate-in fade-in-0 slide-in-from-bottom-2 duration-300 delay-75">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-muted-foreground tracking-wide uppercase">
                            Quick Clean
                        </CardTitle>
                        <CardDescription className="text-xs">
                            Primary actions target <span className="text-foreground font-medium">Sencho-managed</span> resources only.
                            Use <MoreVertical className="inline w-3 h-3" /> for all-Docker operations.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 flex flex-col justify-center">
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                            <PruneButton
                                target="images"
                                icon={<PackageMinus className="w-6 h-6" />}
                                label="Prune Unused Images"
                                accentClass="text-brand"
                                onManaged={() => setConfirmPrune({ target: 'images', scope: 'managed' })}
                                onAll={() => setConfirmPrune({ target: 'images', scope: 'all' })}
                            />
                            <PruneButton
                                target="volumes"
                                icon={<HardDrive className="w-6 h-6" />}
                                label="Prune Unused Volumes"
                                accentClass="text-brand"
                                onManaged={() => setConfirmPrune({ target: 'volumes', scope: 'managed' })}
                                onAll={() => setConfirmPrune({ target: 'volumes', scope: 'all' })}
                            />
                            <PruneButton
                                target="networks"
                                icon={<Network className="w-6 h-6" />}
                                label="Prune Dead Networks"
                                accentClass="text-success"
                                onManaged={() => setConfirmPrune({ target: 'networks', scope: 'managed' })}
                                onAll={() => setConfirmPrune({ target: 'networks', scope: 'all' })}
                            />
                            <PruneButton
                                target="containers"
                                icon={<MonitorX className="w-6 h-6" />}
                                label="Purge Unmanaged Containers"
                                accentClass="text-warning"
                                onManaged={() => setConfirmPrune({ target: 'containers', scope: 'managed' })}
                                onAll={() => setConfirmPrune({ target: 'containers', scope: 'all' })}
                            />
                        </div>
                    </CardContent>
                </Card>}
            </div>

            {/* Resource Tabs */}
            <Tabs
                value={resourceTab}
                onValueChange={(v) => setResourceTab(v as typeof resourceTab)}
                className="flex-1 flex flex-col w-full min-h-[400px]"
            >
                {isMobile ? (
                    <MobileSubTabs
                        ariaLabel="Resource sections"
                        active={resourceTab}
                        onSelect={setResourceTab}
                        tabs={[
                            { value: 'images', label: 'Images', count: images.length },
                            { value: 'volumes', label: 'Volumes', count: volumes.length },
                            { value: 'unmanaged', label: 'Unmanaged', count: totalOrphansCount },
                            { value: 'rollback', label: 'Rollback', count: rollbackGenerations.length },
                        ]}
                    />
                ) : (
                <div className="flex items-center gap-3 mb-4 flex-wrap rounded-lg border border-card-border bg-card/40 px-2.5 py-1.5">
                    <TabsList className="border-transparent bg-transparent max-md:w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]">
                        <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
                            {(['images', 'volumes'] as const).map(tab => (
                                <TabsHighlightItem key={tab} value={tab}>
                                    <TabsTrigger value={tab}>
                                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                        <span className="ml-1.5 text-[10px] text-stat-subtitle tabular-nums">
                                            {tab === 'images' ? images.length : volumes.length}
                                        </span>
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            ))}
                            <TabsHighlightItem value="unmanaged">
                                <TabsTrigger value="unmanaged" className="relative">
                                    Unmanaged
                                    <span className="ml-1.5 text-[10px] text-stat-subtitle tabular-nums">{totalOrphansCount}</span>
                                </TabsTrigger>
                            </TabsHighlightItem>
                            <TabsHighlightItem value="rollback">
                                <TabsTrigger value="rollback" className="relative">
                                    Rollback
                                    <span className="ml-1.5 text-[10px] text-stat-subtitle tabular-nums">{rollbackGenerations.length}</span>
                                </TabsTrigger>
                            </TabsHighlightItem>
                        </TabsHighlight>
                    </TabsList>
                </div>
                )}

                <div className="flex-1 relative">

                    {/* Images */}
                    <TabsContent value="images" className="m-0 border-0 p-0 animate-in fade-in-0 duration-200">
                        <div className="flex flex-wrap items-center gap-2 mb-4">
                            {imageSearch !== '' || imageSearchExpanded ? (
                                <div className="relative flex-1 min-w-[200px] max-w-sm">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                                    <Input
                                        ref={imageSearchRef}
                                        placeholder="Search images..."
                                        value={imageSearch}
                                        onChange={(e) => setImageSearch(e.target.value)}
                                        onBlur={() => { if (imageSearch === '') setImageSearchExpanded(false); }}
                                        className="pl-9 h-9"
                                    />
                                </div>
                            ) : (
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button variant="outline" size="sm" className="h-9 w-9 p-0 shrink-0" onClick={() => setImageSearchExpanded(true)} aria-label="Search images">
                                                <Search className="w-4 h-4" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Search images</TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            )}
                            <FilterToggle
                                value={imageFilter}
                                onChange={setImageFilter}
                                counts={{
                                    all: images.length,
                                    managed: images.filter(i => i.managedStatus === 'managed').length,
                                    unmanaged: images.filter(i => i.managedStatus !== 'managed').length,
                                }}
                            />
                            <div className="flex-1" />
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
                            {isLoading ? <TableSkeleton cols={5} /> : (
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
                                                    {img.rollbackProtected && <RollbackProtectedBadge kind={img.rollbackProtectionKind} />}
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
                                                                    onClick={() => handleScanImage(img.RepoTags![0], { scanners: ['vuln'] })}
                                                                >
                                                                    Scan (vulnerabilities)
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem
                                                                    onClick={() => handleScanImage(img.RepoTags![0], { scanners: ['vuln', 'secret'] })}
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
                            {volumeSearch !== '' || volumeSearchExpanded ? (
                                <div className="relative flex-1 min-w-[200px] max-w-sm">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                                    <Input
                                        ref={volumeSearchRef}
                                        placeholder="Search volumes..."
                                        value={volumeSearch}
                                        onChange={(e) => setVolumeSearch(e.target.value)}
                                        onBlur={() => { if (volumeSearch === '') setVolumeSearchExpanded(false); }}
                                        className="pl-9 h-9"
                                    />
                                </div>
                            ) : (
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button variant="outline" size="sm" className="h-9 w-9 p-0 shrink-0" onClick={() => setVolumeSearchExpanded(true)} aria-label="Search volumes">
                                                <Search className="w-4 h-4" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Search volumes</TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            )}
                            <FilterToggle
                                value={volumeFilter}
                                onChange={setVolumeFilter}
                                counts={{
                                    all: volumes.length,
                                    managed: volumes.filter(v => v.managedStatus === 'managed').length,
                                    unmanaged: volumes.filter(v => v.managedStatus !== 'managed').length,
                                }}
                            />
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
                            {isLoading ? <TableSkeleton cols={5} /> : (
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
                                <input
                                    type="checkbox"
                                    onChange={selectAllOrphans}
                                    checked={selectedOrphans.length === totalOrphansCount && totalOrphansCount > 0}
                                    className="rounded border-border focus:ring-ring h-4 w-4 accent-foreground"
                                />
                                <span className="text-xs font-medium text-muted-foreground">Select all</span>
                            </div>
                            {isAdmin && <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs gap-1.5 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                                onClick={() => setBulkPurgeConfirm(true)}
                                disabled={selectedOrphans.length === 0 || isActioning}
                            >
                                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                {isActioning ? 'Purging...' : `Purge Selected (${selectedOrphans.length})`}
                            </Button>}
                        </div>

                        {totalOrphansCount === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center p-12 text-muted-foreground animate-in fade-in-0 duration-300">
                                <div className="w-12 h-12 rounded-full bg-success-muted flex items-center justify-center mb-3">
                                    <ShieldCheck className="w-6 h-6 text-success" />
                                </div>
                                <p className="font-medium text-sm">No unmanaged containers</p>
                                <p className="text-xs mt-1 opacity-70">All running containers are managed by Sencho.</p>
                            </div>
                        ) : (
                            <div className="p-4 space-y-3 pb-12">
                                {Object.entries(orphans).map(([project, containers], gi) => (
                                    <div
                                        key={project}
                                        className="bg-card rounded-lg border shadow-card-bevel overflow-hidden text-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
                                        style={{ animationDelay: `${gi * 60}ms` }}
                                    >
                                        {/* Project header */}
                                        <div className="bg-warning/8 border-b border-warning/15 px-4 py-2 font-medium text-xs flex items-center gap-2">
                                            <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse shrink-0" />
                                            <span className="text-warning">External Project:</span>
                                            <span className="font-mono text-foreground">{project}</span>
                                            <span className="ml-auto text-muted-foreground font-normal">{containers.length} container{containers.length !== 1 ? 's' : ''}</span>
                                        </div>
                                        <div className="divide-y divide-border/50">
                                            {containers.map((container: UnmanagedContainer) => (
                                                <div
                                                    key={container.Id}
                                                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors duration-150"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedOrphans.includes(container.Id)}
                                                        onChange={() => toggleOrphan(container.Id)}
                                                        className="rounded border-border h-4 w-4 accent-foreground"
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
                            isLoading={isLoading}
                            isAdmin={isAdmin}
                            nodeId={activeNode?.id}
                            onReleased={fetchAllData}
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
                    isActioning
                        ? 'Pruning...'
                        : planLoading
                            ? 'Preparing...'
                            : prunePlan && prunePlan.reclaimableBytes > 0
                                ? `Prune · ${formatBytes(prunePlan.reclaimableBytes)}`
                                : (confirmPrune?.scope === 'all' ? 'Prune all' : 'Prune')
                }
                confirming={isActioning}
                confirmDisabled={planLoading || !prunePlan || !!planError || (prunePlan?.items.length ?? 0) === 0}
                onConfirm={handlePrune}
            >
                <div className="space-y-3 text-sm text-stat-subtitle">
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

            {/* Reclaim Confirm (banner "Review & prune") */}
            <ConfirmModal
                open={confirmReclaim}
                onOpenChange={(open) => !open && setConfirmReclaim(false)}
                variant="destructive"
                kicker="RESOURCES · PRUNE · IRREVERSIBLE"
                title="Reclaim disk space"
                hint="AFFECTS external Docker resources"
                confirmLabel={
                    isActioning
                        ? 'Reclaiming...'
                        : planLoading
                            ? 'Preparing...'
                            : `Reclaim ${formatBytes(prunePlan?.reclaimableBytes ?? totalReclaimableBytes)}`
                }
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
                confirmLabel={isActioning ? 'Deleting...' : 'Delete'}
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

            {/* Unmanaged Container Purge Confirm */}
            <ConfirmModal
                open={bulkPurgeConfirm}
                onOpenChange={setBulkPurgeConfirm}
                variant="destructive"
                kicker="RESOURCES · PURGE · IRREVERSIBLE"
                title="Purge selected unmanaged containers"
                hint={`AFFECTS ${selectedOrphans.length} container${selectedOrphans.length !== 1 ? 's' : ''}`}
                confirmLabel={isActioning ? 'Purging...' : 'Purge'}
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
                onRescan={canDeployResources ? (imageRef) => { setInspectScanId(null); handleScanImage(imageRef, { force: true }); } : undefined}
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
                    state={totalReclaimableBytes > 0 ? 'Reclaimable' : 'Tidy'}
                    stateTone={totalReclaimableBytes > 0 ? 'warning' : 'success'}
                    live={false}
                    meta={`${images.length} images · ${volumes.length} volumes · ${networks.length} networks`}
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
            {mainContent}
            {overlays}
        </div>
    );
}

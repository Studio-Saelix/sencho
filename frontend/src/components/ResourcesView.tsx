import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from "@/components/ui/tabs";
import { springs } from '@/lib/motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from "@/components/ui/modal";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TogglePill } from "@/components/ui/toggle-pill";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { Trash2, HardDrive, Network, PackageMinus, MonitorX, MoreVertical, AlertTriangle, ShieldCheck, Plus, Eye, Loader2, History, FolderOpen } from 'lucide-react';
import { CursorProvider, CursorContainer, Cursor, CursorFollow } from '@/components/animate-ui/primitives/animate/cursor';
import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import { VulnerabilityScanSheet } from './VulnerabilityScanSheet';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from './NodeManager';
import type { ScanSummary, VulnSeverity } from '@/types/security';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { CapabilityGate } from './CapabilityGate';
import LazyBoundary from './LazyBoundary';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { SENCHO_OPEN_LOGS_EVENT } from '@/lib/events';
import type { SenchoOpenLogsDetail } from '@/lib/events';
import { lazy, Suspense } from 'react';
import { ReclaimHero } from './resources/ReclaimHero';
import { FootprintTreemap } from './resources/FootprintTreemap';
import { ImageDetailsSheet } from './resources/ImageDetailsSheet';
import { VolumeBrowserSheet } from './resources/VolumeBrowserSheet';
import { NetworkDetailSheet, type NetworkInspectData } from './resources/NetworkDetailSheet';

const NetworkTopologyView = lazy(() => import('./NetworkTopologyView'));

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
    managedBy: string | null;
    managedStatus: 'managed' | 'unmanaged' | 'unused';
}

interface DockerVolume {
    Name: string;
    Driver: string;
    Mountpoint: string;
    Size: number;
    CreatedAt: string | null;
    managedBy: string | null;
    managedStatus: 'managed' | 'unmanaged';
}

const NETWORK_DRIVERS = ['bridge', 'overlay', 'macvlan', 'host', 'none'] as const;
type NetworkDriver = (typeof NETWORK_DRIVERS)[number];

export interface DockerNetwork {
    Id: string;
    Name: string;
    Driver: string;
    Scope: string;
    managedBy: string | null;
    managedStatus: 'managed' | 'unmanaged' | 'system';
}

interface UnmanagedContainer {
    Id: string;
    Names: string[];
    State: string;
    Status: string;
    Image: string;
}

// NetworkInspectData is re-exported from ./resources/NetworkDetailSheet

type ResourceFilter = 'all' | 'managed' | 'unmanaged';
type PruneTarget = 'containers' | 'images' | 'networks' | 'volumes';
type PruneScope = 'managed' | 'all';

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
        <div className="flex items-center gap-1 px-3 py-2.5 border-b bg-muted/10">
            <div className="flex items-center gap-0.5 bg-muted/50 rounded-lg p-0.5">
                {options.map(({ key, label, count }) => (
                    <button
                        key={key}
                        onClick={() => onChange(key)}
                        className={cn(
                            'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all duration-200',
                            value === key
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {label}
                        <span className={cn(
                            'inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-sm text-[10px] font-mono transition-colors duration-200',
                            value === key ? 'bg-muted text-foreground' : 'text-stat-subtitle',
                        )}>
                            {count}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

// ── Managed Status Badge ───────────────────────────────────────────────────────

function ManagedBadge({ status, managedBy }: {
    status: 'managed' | 'unmanaged' | 'unused' | 'system';
    managedBy: string | null;
}) {
    if (status === 'managed') {
        return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-success/25 bg-success/8 text-success text-[10px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                {managedBy}
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

// ── Severity Badge ─────────────────────────────────────────────────────────────

const SEVERITY_BADGE_CLASSES: Record<VulnSeverity | 'CLEAN', string> = {
    CRITICAL: 'border-destructive/25 bg-destructive/8 text-destructive',
    HIGH: 'border-warning/25 bg-warning/8 text-warning',
    MEDIUM: 'border-warning/25 bg-warning/8 text-warning',
    LOW: 'border-border bg-muted/30 text-muted-foreground',
    UNKNOWN: 'border-border bg-muted/20 text-muted-foreground',
    CLEAN: 'border-success/25 bg-success/8 text-success',
};

const SEVERITY_DOT_CLASSES: Record<VulnSeverity | 'CLEAN', string> = {
    CRITICAL: 'bg-destructive',
    HIGH: 'bg-warning',
    MEDIUM: 'bg-warning',
    LOW: 'bg-muted-foreground/60',
    UNKNOWN: 'bg-muted-foreground/40',
    CLEAN: 'bg-success',
};

function SeverityBadge({ summary, onClick }: { summary: ScanSummary; onClick: () => void }) {
    const key: VulnSeverity | 'CLEAN' = summary.highest_severity ?? 'CLEAN';
    const label = key === 'CLEAN' ? 'Clean' : key;
    const [relative, setRelative] = useState<string>('');
    useEffect(() => {
        const compute = () => {
            const scanAge = Math.round((Date.now() - summary.scanned_at) / 60000);
            setRelative(
                scanAge < 1 ? 'just now'
                    : scanAge < 60 ? `${scanAge}m ago`
                    : scanAge < 1440 ? `${Math.round(scanAge / 60)}h ago`
                    : `${Math.round(scanAge / 1440)}d ago`,
            );
        };
        compute();
        const id = setInterval(compute, 60000);
        return () => clearInterval(id);
    }, [summary.scanned_at]);

    return (
        <CursorProvider>
            <CursorContainer className="inline-flex">
                <button
                    type="button"
                    onClick={onClick}
                    className={cn(
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium cursor-pointer hover:brightness-110 transition',
                        SEVERITY_BADGE_CLASSES[key],
                    )}
                >
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', SEVERITY_DOT_CLASSES[key])} />
                    {label}
                </button>
            </CursorContainer>
            <Cursor>
                <div className="h-2 w-2 rounded-full bg-brand" />
            </Cursor>
            <CursorFollow side="bottom" align="end" sideOffset={8}>
                <div className="bg-popover/95 backdrop-blur-[10px] backdrop-saturate-[1.15] border border-card-border shadow-md rounded-md px-3 py-2">
                    <div className="font-mono tabular-nums text-xs space-y-1">
                        <div className="text-stat-subtitle uppercase tracking-wide">Last scanned</div>
                        <div className="text-stat-value">{relative}</div>
                        {summary.total > 0 && (
                            <div className="flex gap-3 mt-1">
                                {summary.critical > 0 && <span className="text-destructive">{summary.critical}C</span>}
                                {summary.high > 0 && <span className="text-warning">{summary.high}H</span>}
                                {summary.medium > 0 && <span className="text-warning">{summary.medium}M</span>}
                                {summary.low > 0 && <span className="text-muted-foreground">{summary.low}L</span>}
                            </div>
                        )}
                        {summary.total === 0 && (
                            <div className="text-success">No vulnerabilities</div>
                        )}
                    </div>
                </div>
            </CursorFollow>
        </CursorProvider>
    );
}

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

// ── Table Skeleton ─────────────────────────────────────────────────────────────

function TableSkeleton({ cols, rows = 5 }: { cols: number; rows?: number }) {
    return (
        <TableBody>
            {Array.from({ length: rows }).map((_, r) => (
                <TableRow key={r} className="animate-in fade-in-0" style={{ animationDelay: `${r * 40}ms` }}>
                    {Array.from({ length: cols }).map((_, c) => (
                        <TableCell key={c}>
                            <Skeleton className={cn('h-4', c === 0 ? 'w-24' : c === 1 ? 'w-48' : 'w-16')} />
                        </TableCell>
                    ))}
                </TableRow>
            ))}
        </TableBody>
    );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ResourcesView() {
    const { isAdmin } = useAuth();
    const { activeNode } = useNodes();
    const { isPaid } = useLicense();
    const [networkViewMode, setNetworkViewMode] = useState<'list' | 'topology'>('list');
    const [usage, setUsage] = useState<UsageData | null>(null);
    const [images, setImages] = useState<DockerImage[]>([]);
    const [volumes, setVolumes] = useState<DockerVolume[]>([]);
    const [networks, setNetworks] = useState<DockerNetwork[]>([]);
    const [orphans, setOrphans] = useState<Record<string, UnmanagedContainer[]>>({});

    const [isLoading, setIsLoading] = useState(true);
    const [isActioning, setIsActioning] = useState(false);

    // Filter state
    const [imageFilter, setImageFilter] = useState<ResourceFilter>('all');
    const [volumeFilter, setVolumeFilter] = useState<ResourceFilter>('all');
    const [networkFilter, setNetworkFilter] = useState<ResourceFilter>('all');

    // Modal states
    const [confirmPrune, setConfirmPrune] = useState<{ target: PruneTarget; scope: PruneScope } | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<{ type: 'images' | 'volumes' | 'networks'; id: string; name?: string } | null>(null);

    // Network create/inspect state
    const [showCreateNetwork, setShowCreateNetwork] = useState(false);
    const [createNetworkForm, setCreateNetworkForm] = useState<{ name: string; driver: NetworkDriver; subnet: string; gateway: string; internal: boolean; attachable: boolean }>({ name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, attachable: false });
    const [isCreatingNetwork, setIsCreatingNetwork] = useState(false);
    const [inspectNetwork, setInspectNetwork] = useState<NetworkInspectData | null>(null);
    const [inspectLoadingId, setInspectLoadingId] = useState<string | null>(null);
    const [inspectImageId, setInspectImageId] = useState<string | null>(null);
    const [browseVolume, setBrowseVolume] = useState<string | null>(null);

    // Unmanaged container state
    const [selectedOrphans, setSelectedOrphans] = useState<string[]>([]);
    const [bulkPurgeConfirm, setBulkPurgeConfirm] = useState(false);

    // Vulnerability scanning state
    const { status: trivy } = useTrivyStatus();
    const [scanSummaries, setScanSummaries] = useState<Record<string, ScanSummary>>({});
    const [scanningImageRef, setScanningImageRef] = useState<string | null>(null);
    const [inspectScanId, setInspectScanId] = useState<number | null>(null);

    const fetchAllData = async () => {
        setIsLoading(true);
        try {
            const [usageRes, resourcesRes, orphansRes, summariesRes] = await Promise.all([
                apiFetch('/system/docker-df'),
                apiFetch('/system/resources'),
                apiFetch('/system/orphans'),
                apiFetch('/security/image-summaries').catch(() => null),
            ]);

            if (usageRes.ok) setUsage(await usageRes.json());
            if (resourcesRes.ok) {
                const resources = await resourcesRes.json();
                setImages(resources.images ?? []);
                setVolumes(resources.volumes ?? []);
                setNetworks(resources.networks ?? []);
            }
            if (orphansRes.ok) {
                setOrphans(await orphansRes.json());
                setSelectedOrphans([]);
            }
            if (summariesRes && summariesRes.ok) {
                const data = await summariesRes.json();
                setScanSummaries(data ?? {});
            }
        } catch (err) {
            console.error('Failed to fetch data', err);
            toast.error('Failed to load resources data');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => { fetchAllData(); }, [activeNode]);

    const handlePrune = async () => {
        if (!confirmPrune) return;
        setIsActioning(true);
        const loadingId = toast.loading(`Pruning ${confirmPrune.target}...`);
        try {
            const res = await apiFetch('/system/prune/system', {
                method: 'POST',
                body: JSON.stringify({ target: confirmPrune.target, scope: confirmPrune.scope })
            });
            const data = await res.json();
            const scopeLabel = confirmPrune.scope === 'managed' ? 'Sencho-managed' : 'all';
            toast.success(
                data.reclaimedBytes !== undefined
                    ? `Pruned ${scopeLabel} ${confirmPrune.target}. Reclaimed ${formatBytes(data.reclaimedBytes)}.`
                    : `Pruned ${scopeLabel} ${confirmPrune.target}.`
            );
            await fetchAllData();
        } catch {
            toast.error(confirmPrune ? `Failed to prune ${confirmPrune.target}` : 'Prune failed');
        } finally {
            toast.dismiss(loadingId);
            setIsActioning(false);
            setConfirmPrune(null);
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
        setScanningImageRef(imageRef);
        const loadingId = toast.loading(`Scanning ${imageRef}...`);
        try {
            const res = await apiFetch('/security/scan', {
                method: 'POST',
                body: JSON.stringify({ imageRef, force, scanners }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Failed to start scan');
            const scanId = data.scanId as number;

            const deadline = Date.now() + 5 * 60 * 1000;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 3000));
                const poll = await apiFetch(`/security/scans/${scanId}`);
                if (!poll.ok) continue;
                const poll_data = await poll.json();
                if (poll_data.status !== 'in_progress') {
                    if (poll_data.status === 'failed') {
                        throw new Error(poll_data.error || 'Scan failed');
                    }
                    toast.success(`Scan complete: ${poll_data.total_vulnerabilities} vulnerabilities found`);
                    setInspectScanId(scanId);
                    const summariesRes = await apiFetch('/security/image-summaries');
                    if (summariesRes.ok) {
                        const summaries = await summariesRes.json();
                        setScanSummaries(summaries ?? {});
                    }
                    return;
                }
            }
            throw new Error('Scan timed out');
        } catch (error) {
            const err = error as { message?: string; error?: string; data?: { error?: string } };
            toast.error(err?.message || err?.error || err?.data?.error || 'Scan failed');
        } finally {
            toast.dismiss(loadingId);
            setScanningImageRef(null);
        }
    };

    const handleCreateNetwork = async () => {
        setIsCreatingNetwork(true);
        try {
            const res = await apiFetch('/system/networks', {
                method: 'POST',
                body: JSON.stringify({
                    name: createNetworkForm.name,
                    driver: createNetworkForm.driver,
                    subnet: createNetworkForm.subnet || undefined,
                    gateway: createNetworkForm.gateway || undefined,
                    internal: createNetworkForm.internal,
                    attachable: createNetworkForm.attachable,
                }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data?.error || 'Failed to create network');
            }
            toast.success(`Network "${createNetworkForm.name}" created`);
            setShowCreateNetwork(false);
            setCreateNetworkForm({ name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, attachable: false });
            await fetchAllData();
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || err?.error || 'Something went wrong.'));
        } finally {
            setIsCreatingNetwork(false);
        }
    };

    const handleInspectNetwork = async (id: string) => {
        setInspectLoadingId(id);
        try {
            const res = await apiFetch(`/system/networks/${id}`);
            if (!res.ok) throw new Error('Failed to inspect network');
            const data = await res.json();
            setInspectNetwork(data);
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || err?.error || 'Something went wrong.'));
        } finally {
            setInspectLoadingId(null);
        }
    };

    // Derived filtered lists
    const filteredImages = images.filter(img =>
        imageFilter === 'managed' ? img.managedStatus === 'managed' :
            imageFilter === 'unmanaged' ? img.managedStatus !== 'managed' : true
    );
    const filteredVolumes = volumes.filter(vol =>
        volumeFilter === 'managed' ? vol.managedStatus === 'managed' :
            volumeFilter === 'unmanaged' ? vol.managedStatus !== 'managed' : true
    );
    const filteredNetworks = networks.filter(net =>
        networkFilter === 'managed' ? net.managedStatus === 'managed' :
            networkFilter === 'unmanaged' ? net.managedStatus !== 'managed' : true
    );

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

    const handleReviewAndPrune = () => {
        setConfirmPrune({ target: 'images', scope: 'all' });
    };

    return (
        <div className="p-6 h-full overflow-auto text-foreground flex flex-col gap-6 animate-in fade-in-0 duration-300">

            {/* Reclaim hero */}
            {usage && isAdmin && (
                <ReclaimHero
                    bytes={totalReclaimableBytes}
                    imageCount={usage.reclaimableImageCount}
                    containerCount={usage.reclaimableContainerCount}
                    volumeCount={usage.reclaimableVolumeCount}
                    onReview={handleReviewAndPrune}
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
                defaultValue="images"
                className="flex-1 flex flex-col w-full rounded-lg border bg-card shadow-card-bevel overflow-hidden min-h-[400px] animate-in fade-in-0 slide-in-from-bottom-2 duration-300 delay-150"
            >
                <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3">
                    <TabsList className="grid grid-cols-4 w-full md:w-[680px] h-9 gap-1 p-0">
                        <TabsHighlight className="rounded-md bg-glass-highlight" transition={springs.snappy}>
                            {(['images', 'volumes', 'networks'] as const).map(tab => (
                                <TabsHighlightItem key={tab} value={tab}>
                                    <TabsTrigger value={tab} className="capitalize text-xs">
                                        {tab}
                                    </TabsTrigger>
                                </TabsHighlightItem>
                            ))}
                            <TabsHighlightItem value="unmanaged">
                                <TabsTrigger value="unmanaged" className="relative text-xs">
                                    Unmanaged
                                    {totalOrphansCount > 0 && (
                                        <span className="absolute -top-1.5 -right-1 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-warning text-[9px] text-warning-foreground font-medium animate-in zoom-in-75 duration-200">
                                            {totalOrphansCount}
                                        </span>
                                    )}
                                </TabsTrigger>
                            </TabsHighlightItem>
                        </TabsHighlight>
                    </TabsList>
                    {trivy.available && isPaid && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="border-border"
                            onClick={() => {
                                window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
                                    detail: { view: 'security-history' },
                                }));
                            }}
                            title="View completed vulnerability scans and compare them"
                            aria-label="Open scan history"
                        >
                            <History className="w-4 h-4 mr-2" strokeWidth={1.5} />
                            Scan history
                        </Button>
                    )}
                </div>

                <ScrollArea className="flex-1 bg-background relative text-sm">

                    {/* Images */}
                    <TabsContent value="images" className="m-0 border-0 p-0 animate-in fade-in-0 duration-200">
                        <FilterToggle
                            value={imageFilter}
                            onChange={setImageFilter}
                            counts={{
                                all: images.length,
                                managed: images.filter(i => i.managedStatus === 'managed').length,
                                unmanaged: images.filter(i => i.managedStatus !== 'managed').length,
                            }}
                        />
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <TableHead className="w-[120px] text-[11px]">ID</TableHead>
                                    <TableHead className="text-[11px]">Repository:Tag</TableHead>
                                    <TableHead className="text-[11px]">Size</TableHead>
                                    <TableHead className="text-[11px]">Status</TableHead>
                                    <TableHead className="text-right text-[11px]">Action</TableHead>
                                </TableRow>
                            </TableHeader>
                            {isLoading ? <TableSkeleton cols={5} /> : (
                                <TableBody>
                                    {filteredImages.length === 0 ? (
                                        <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">No images found.</TableCell></TableRow>
                                    ) : filteredImages.map((img, i) => (
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
                                                    <ManagedBadge status={img.managedStatus} managedBy={img.managedBy} />
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
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
                                                        onClick={() => setInspectImageId(img.Id)}
                                                        title="Inspect image"
                                                        aria-label={`Inspect ${img.RepoTags?.[0] || 'image'}`}
                                                    >
                                                        <Eye className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>
                                                    {trivy.available && isAdmin && img.RepoTags?.[0] && img.RepoTags[0] !== '<none>:<none>' && (
                                                        <DropdownMenu>
                                                            <DropdownMenuTrigger asChild>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
                                                                    disabled={scanningImageRef === img.RepoTags[0]}
                                                                    title="Scan for vulnerabilities"
                                                                >
                                                                    {scanningImageRef === img.RepoTags[0] ? (
                                                                        <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                                                                    ) : (
                                                                        <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                                    )}
                                                                </Button>
                                                            </DropdownMenuTrigger>
                                                            <DropdownMenuContent align="end">
                                                                <DropdownMenuItem
                                                                    onClick={() => handleScanImage(img.RepoTags![0], { scanners: ['vuln'] })}
                                                                >
                                                                    Scan (vulnerabilities)
                                                                </DropdownMenuItem>
                                                                {isPaid && (
                                                                    <DropdownMenuItem
                                                                        onClick={() => handleScanImage(img.RepoTags![0], { scanners: ['vuln', 'secret'] })}
                                                                    >
                                                                        Full scan (vulnerabilities + secrets)
                                                                    </DropdownMenuItem>
                                                                )}
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                    )}
                                                    {isAdmin && <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground transition-colors" onClick={() => setConfirmDelete({ type: 'images', id: img.Id, name: img.RepoTags?.[0] })}>
                                                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            )}
                        </Table>
                    </TabsContent>

                    {/* Volumes */}
                    <TabsContent value="volumes" className="m-0 border-0 p-0 animate-in fade-in-0 duration-200">
                        <FilterToggle
                            value={volumeFilter}
                            onChange={setVolumeFilter}
                            counts={{
                                all: volumes.length,
                                managed: volumes.filter(v => v.managedStatus === 'managed').length,
                                unmanaged: volumes.filter(v => v.managedStatus !== 'managed').length,
                            }}
                        />
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <TableHead className="text-[11px]">Name</TableHead>
                                    <TableHead className="text-[11px]">Driver</TableHead>
                                    <TableHead className="hidden md:table-cell text-[11px]">Mountpoint</TableHead>
                                    <TableHead className="text-[11px]">Status</TableHead>
                                    <TableHead className="text-right text-[11px]">Action</TableHead>
                                </TableRow>
                            </TableHeader>
                            {isLoading ? <TableSkeleton cols={5} /> : (
                                <TableBody>
                                    {filteredVolumes.length === 0 ? (
                                        <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">No volumes found.</TableCell></TableRow>
                                    ) : filteredVolumes.map((vol, i) => (
                                        <TableRow
                                            key={vol.Name}
                                            className="animate-in fade-in-0 duration-200 hover:bg-muted/30 transition-colors"
                                            style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                                        >
                                            <TableCell className="font-mono text-xs max-w-[200px] truncate">{vol.Name}</TableCell>
                                            <TableCell><Badge variant="outline" className="text-[10px] h-5">{vol.Driver}</Badge></TableCell>
                                            <TableCell className="hidden md:table-cell text-xs text-muted-foreground truncate max-w-[300px]">{vol.Mountpoint}</TableCell>
                                            <TableCell><ManagedBadge status={vol.managedStatus} managedBy={vol.managedBy} /></TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    {isAdmin && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
                                                            onClick={() => setBrowseVolume(vol.Name)}
                                                            title="Browse volume contents"
                                                            aria-label={`Browse ${vol.Name}`}
                                                        >
                                                            <FolderOpen className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                        </Button>
                                                    )}
                                                    {isAdmin && <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground transition-colors" onClick={() => setConfirmDelete({ type: 'volumes', id: vol.Name, name: vol.Name })}>
                                                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            )}
                        </Table>
                    </TabsContent>

                    {/* Networks */}
                    <TabsContent value="networks" className="m-0 border-0 p-0 animate-in fade-in-0 duration-200">
                        <div className="flex items-center justify-between">
                            {networkViewMode === 'list' && (
                                <FilterToggle
                                    value={networkFilter}
                                    onChange={setNetworkFilter}
                                    counts={{
                                        all: networks.length,
                                        managed: networks.filter(n => n.managedStatus === 'managed').length,
                                        unmanaged: networks.filter(n => n.managedStatus !== 'managed').length,
                                    }}
                                />
                            )}
                            <div className="flex items-center gap-2 pr-3">
                                <div className="flex items-center gap-0.5 bg-muted/50 rounded-lg p-0.5">
                                    <button
                                        onClick={() => setNetworkViewMode('list')}
                                        className={cn(
                                            'px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-200',
                                            networkViewMode === 'list' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        List
                                    </button>
                                    <button
                                        onClick={() => setNetworkViewMode('topology')}
                                        className={cn(
                                            'px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-200 flex items-center gap-1',
                                            networkViewMode === 'topology' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        Topology
                                    </button>
                                </div>
                                {isAdmin && networkViewMode === 'list' && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 text-xs gap-1.5"
                                        onClick={() => setShowCreateNetwork(true)}
                                    >
                                        <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
                                        Create Network
                                    </Button>
                                )}
                            </div>
                        </div>

                        {networkViewMode === 'topology' ? (
                            <div className="p-4">
                                <CapabilityGate capability="network-topology" featureName="Network Topology">
                                    <LazyBoundary>
                                        <Suspense fallback={
                                            <div className="flex items-center justify-center h-[400px] text-muted-foreground gap-2">
                                                <span className="text-sm">Loading topology...</span>
                                            </div>
                                        }>
                                            <NetworkTopologyView
                                                key={activeNode?.id}
                                                onContainerClick={(id, name) => {
                                                    window.dispatchEvent(new CustomEvent<SenchoOpenLogsDetail>(SENCHO_OPEN_LOGS_EVENT, {
                                                        detail: { containerId: id, containerName: name },
                                                    }));
                                                }}
                                            />
                                        </Suspense>
                                    </LazyBoundary>
                                </CapabilityGate>
                            </div>
                        ) : (
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <TableHead className="w-[120px] text-[11px]">ID</TableHead>
                                    <TableHead className="text-[11px]">Name</TableHead>
                                    <TableHead className="text-[11px]">Driver</TableHead>
                                    <TableHead className="text-[11px]">Scope</TableHead>
                                    <TableHead className="text-[11px]">Status</TableHead>
                                    <TableHead className="text-right text-[11px]">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            {isLoading ? <TableSkeleton cols={6} /> : (
                                <TableBody>
                                    {filteredNetworks.length === 0 ? (
                                        <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">No networks found.</TableCell></TableRow>
                                    ) : filteredNetworks.map((net, i) => (
                                        <TableRow
                                            key={net.Id}
                                            className="animate-in fade-in-0 duration-200 hover:bg-muted/30 transition-colors"
                                            style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                                        >
                                            <TableCell className="font-mono text-xs text-muted-foreground">{net.Id.substring(0, 12)}</TableCell>
                                            <TableCell className="font-medium max-w-[200px] truncate">{net.Name}</TableCell>
                                            <TableCell className="text-xs">{net.Driver}</TableCell>
                                            <TableCell><Badge variant="outline" className="text-[10px] h-5">{net.Scope}</Badge></TableCell>
                                            <TableCell><ManagedBadge status={net.managedStatus} managedBy={net.managedBy} /></TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 hover:text-foreground transition-colors"
                                                        disabled={inspectLoadingId !== null}
                                                        onClick={() => handleInspectNetwork(net.Id)}
                                                    >
                                                        {inspectLoadingId === net.Id ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} /> : <Eye className="w-3.5 h-3.5" strokeWidth={1.5} />}
                                                    </Button>
                                                    {isAdmin && <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground transition-colors disabled:opacity-30"
                                                        disabled={net.managedStatus === 'system'}
                                                        onClick={() => setConfirmDelete({ type: 'networks', id: net.Id, name: net.Name })}
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            )}
                        </Table>
                        )}
                    </TabsContent>

                    {/* Unmanaged Containers */}
                    <TabsContent value="unmanaged" className="m-0 border-0 p-0 h-full flex flex-col animate-in fade-in-0 duration-200">
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
                    </TabsContent>
                </ScrollArea>
            </Tabs>

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
                confirmLabel={isActioning ? 'Pruning...' : (confirmPrune?.scope === 'all' ? 'Prune all' : 'Prune')}
                confirming={isActioning}
                onConfirm={handlePrune}
            >
                <p className="text-sm text-stat-subtitle">
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

            {/* Create Network Modal */}
            <Modal open={showCreateNetwork} onOpenChange={setShowCreateNetwork} size="md">
                <ModalHeader
                    kicker="NETWORKS · NEW"
                    title="Create network"
                    description="Create a new Docker network for inter-container communication."
                />
                <ModalBody>
                    <div className="space-y-2">
                        <Label htmlFor="net-name" className="text-xs font-medium">Name</Label>
                        <Input
                            id="net-name"
                            placeholder="my-network"
                            className="font-mono text-sm"
                            value={createNetworkForm.name}
                            onChange={e => setCreateNetworkForm(f => ({ ...f, name: e.target.value }))}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="net-driver" className="text-xs font-medium">Driver</Label>
                        <Combobox
                            options={NETWORK_DRIVERS.map(d => ({ value: d, label: d }))}
                            value={createNetworkForm.driver}
                            onValueChange={v => setCreateNetworkForm(f => ({ ...f, driver: (v || 'bridge') as NetworkDriver }))}
                            placeholder="Select driver..."
                            searchPlaceholder="Search drivers..."
                            emptyText="No matching driver."
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label htmlFor="net-subnet" className="text-xs font-medium">Subnet <span className="text-muted-foreground">(optional)</span></Label>
                            <Input
                                id="net-subnet"
                                placeholder="172.20.0.0/16"
                                className="font-mono text-sm"
                                value={createNetworkForm.subnet}
                                onChange={e => setCreateNetworkForm(f => ({ ...f, subnet: e.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="net-gateway" className="text-xs font-medium">Gateway <span className="text-muted-foreground">(optional)</span></Label>
                            <Input
                                id="net-gateway"
                                placeholder="172.20.0.1"
                                className="font-mono text-sm"
                                value={createNetworkForm.gateway}
                                onChange={e => setCreateNetworkForm(f => ({ ...f, gateway: e.target.value }))}
                            />
                        </div>
                    </div>
                    <div className="flex items-center gap-6 pt-1">
                        <div className="flex items-center gap-2">
                            <TogglePill
                                id="net-internal"
                                checked={createNetworkForm.internal}
                                onChange={v => setCreateNetworkForm(f => ({ ...f, internal: v }))}
                            />
                            <Label htmlFor="net-internal" className="text-xs cursor-pointer">Internal <span className="text-muted-foreground">(no external access)</span></Label>
                        </div>
                        <div className="flex items-center gap-2">
                            <TogglePill
                                id="net-attachable"
                                checked={createNetworkForm.attachable}
                                onChange={v => setCreateNetworkForm(f => ({ ...f, attachable: v }))}
                            />
                            <Label htmlFor="net-attachable" className="text-xs cursor-pointer">Attachable</Label>
                        </div>
                    </div>
                </ModalBody>
                <ModalFooter
                    hint={`DRIVER ${createNetworkForm.driver}`}
                    secondary={
                        <Button variant="outline" size="sm" onClick={() => setShowCreateNetwork(false)} disabled={isCreatingNetwork}>
                            Cancel
                        </Button>
                    }
                    primary={
                        <Button size="sm" onClick={handleCreateNetwork} disabled={!createNetworkForm.name.trim() || isCreatingNetwork}>
                            {isCreatingNetwork ? 'Creating...' : 'Create network'}
                        </Button>
                    }
                />
            </Modal>

            {/* Image Details Sheet */}
            <ImageDetailsSheet imageId={inspectImageId} onClose={() => setInspectImageId(null)} />

            {/* Volume Browser Sheet */}
            <VolumeBrowserSheet volumeName={browseVolume} onClose={() => setBrowseVolume(null)} />


            {/* Network detail sheet */}
            <NetworkDetailSheet
                network={inspectNetwork}
                onClose={() => setInspectNetwork(null)}
            />

            <VulnerabilityScanSheet
                scanId={inspectScanId}
                onClose={() => setInspectScanId(null)}
                onRescan={(imageRef) => { setInspectScanId(null); handleScanImage(imageRef, { force: true }); }}
                canGenerateSbom={isPaid}
                canCompare={isPaid}
                canManageSuppressions={isPaid && isAdmin}
            />
        </div>
    );
}

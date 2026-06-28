import { useState, useEffect, useCallback } from 'react';
import {
    Camera, ArrowLeft, Server, Layers, FileText, AlertTriangle, Trash2,
    Eye, ChevronDown, ChevronLeft, ChevronRight, Plus, Loader2, RotateCcw,
    Cloud, CloudUpload, Download, BookText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ConfirmModal } from '@/components/ui/modal';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { toast } from '@/components/ui/toast-store';
import { FleetTabHeading, FleetEmptyState, FleetEmptyCard } from './fleet/FleetEmptyState';

// --- Types ---

interface FleetSnapshot {
    id: number;
    description: string;
    created_by: string;
    node_count: number;
    stack_count: number;
    skipped_nodes: string; // JSON string
    skipped_stacks: string; // JSON string
    created_at: number;
    has_documentation?: number;
}

interface SnapshotStackFile {
    filename: string;
    content: string;
}

interface SnapshotStack {
    stackName: string;
    files: SnapshotStackFile[];
}

interface SnapshotNode {
    nodeId: number;
    nodeName: string;
    stacks: SnapshotStack[];
}

/** Operator-authored dossier fields preserved with the snapshot. */
type SnapshotDossierFields = Record<string, string>;

interface SnapshotDocumentationStack {
    nodeId: number;
    nodeName: string;
    stackName: string;
    dossier: SnapshotDossierFields;
}

interface SnapshotDocumentation {
    generated_at: string;
    stacks: SnapshotDocumentationStack[];
    warnings: Array<{ nodeId: number; nodeName: string; stackName: string; reason: string }>;
}

interface FleetSnapshotDetail extends FleetSnapshot {
    nodes: SnapshotNode[];
    documentation?: SnapshotDocumentation;
}

// Ordered labels for the read-only dossier block; only non-empty fields render.
const DOSSIER_FIELD_LABELS: ReadonlyArray<[string, string]> = [
    ['purpose', 'Purpose'],
    ['owner', 'Owner'],
    ['access_urls', 'Access URLs'],
    ['static_ip', 'Static IP'],
    ['vlan', 'VLAN'],
    ['firewall_notes', 'Firewall'],
    ['reverse_proxy_notes', 'Reverse proxy'],
    ['backup_notes', 'Backup'],
    ['upgrade_notes', 'Upgrade'],
    ['recovery_notes', 'Recovery'],
    ['custom_notes', 'Notes'],
];

interface SkippedNode {
    nodeId: number;
    nodeName: string;
    reason: string;
}

interface SkippedStack {
    nodeId: number;
    nodeName: string;
    stackName: string;
    reason: string;
}

const PAGE_SIZE = 10;

// --- Main Component ---

export default function FleetSnapshots() {
    const { isAdmin } = useAuth();
    const { isPaid } = useLicense();

    // Cloud-upload affordance is reachable when the saved provider is custom
    // (every tier) or sencho on a paid license. A downgraded admin whose
    // saved provider is still 'sencho' sees no upload button — they cannot
    // call POST /cloud-backup/upload/:id because gateForCurrentProvider would
    // 403 anyway, so the UI must not advertise an action that is gated away.
    const [cloudEnabled, setCloudEnabled] = useState(false);
    const [snapshots, setSnapshots] = useState<FleetSnapshot[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [description, setDescription] = useState('');
    const [selectedSnapshot, setSelectedSnapshot] = useState<FleetSnapshotDetail | null>(null);
    const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
    const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());
    const [previewFiles, setPreviewFiles] = useState<Set<string>>(new Set());
    const [restoringStack, setRestoringStack] = useState<string | null>(null);
    const [restoringAll, setRestoringAll] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
    const [page, setPage] = useState(0);
    const [cloudSnapshotIds, setCloudSnapshotIds] = useState<Set<number>>(new Set());
    const [uploadingId, setUploadingId] = useState<number | null>(null);

    const totalPages = Math.max(1, Math.ceil(snapshots.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const pagedSnapshots = snapshots.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const needsPagination = snapshots.length > PAGE_SIZE;

    // --- Data Fetching ---

    const fetchSnapshots = useCallback(async () => {
        try {
            const res = await apiFetch('/fleet/snapshots', { localOnly: true });
            if (res.ok) {
                const data: { snapshots: FleetSnapshot[]; total: number } = await res.json();
                setSnapshots(data.snapshots);
            } else {
                const err = await res.json().catch(() => null);
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to load snapshots.');
            }
        } catch (error: unknown) {
            const err = error as Record<string, unknown> | null;
            toast.error(err?.message as string || err?.error as string || 'Something went wrong.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSnapshots();
    }, [fetchSnapshots]);

    const fetchCloudConfig = useCallback(async () => {
        try {
            const res = await apiFetch('/cloud-backup/config', { localOnly: true });
            if (!res.ok) return;
            const data = await res.json() as { provider: 'disabled' | 'sencho' | 'custom' };
            setCloudEnabled(data.provider === 'custom' || (data.provider === 'sencho' && isPaid));
        } catch {
            // best-effort; cloud affordances stay hidden on failure
        }
    }, [isPaid]);

    const fetchCloudSnapshots = useCallback(async () => {
        if (!cloudEnabled) return;
        try {
            const res = await apiFetch('/cloud-backup/snapshots', { localOnly: true });
            if (!res.ok) return;
            const data = await res.json() as Array<{ snapshotId: number | null }>;
            setCloudSnapshotIds(new Set(data.map(d => d.snapshotId).filter((id): id is number => id != null)));
        } catch {
            // best-effort; cloud indicators stay hidden on failure
        }
    }, [cloudEnabled]);

    useEffect(() => {
        fetchCloudConfig();
    }, [fetchCloudConfig]);

    useEffect(() => {
        fetchCloudSnapshots();
    }, [fetchCloudSnapshots]);

    const handleCloudUpload = async (id: number) => {
        setUploadingId(id);
        try {
            const res = await apiFetch(`/cloud-backup/upload/${id}`, { method: 'POST', localOnly: true });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error((data as { error?: string }).error || `Upload failed (${res.status})`);
            toast.success('Snapshot uploaded to cloud.');
            await fetchCloudSnapshots();
        } catch (err) {
            toast.error((err as Error)?.message || 'Cloud upload failed.');
        } finally {
            setUploadingId(null);
        }
    };

    const handleCreate = async () => {
        setCreating(true);
        const loadingId = toast.loading('Creating fleet snapshot...');
        try {
            const res = await apiFetch('/fleet/snapshots', {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({ description: description.trim() || undefined }),
            });
            if (res.ok) {
                toast.success('Snapshot created successfully.');
                setShowCreateForm(false);
                setDescription('');
                await fetchSnapshots();
            } else {
                const err = await res.json().catch(() => null);
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to create snapshot.');
            }
        } catch (error: unknown) {
            const err = error as Record<string, unknown> | null;
            toast.error(err?.message as string || err?.error as string || 'Something went wrong.');
        } finally {
            toast.dismiss(loadingId);
            setCreating(false);
        }
    };

    const handleViewDetail = async (snapshot: FleetSnapshot) => {
        setLoadingDetail(true);
        setViewMode('detail');
        setExpandedNodes(new Set());
        setExpandedStacks(new Set());
        setPreviewFiles(new Set());
        try {
            const res = await apiFetch(`/fleet/snapshots/${snapshot.id}`, { localOnly: true });
            if (res.ok) {
                const data: FleetSnapshotDetail = await res.json();
                setSelectedSnapshot(data);
            } else {
                const err = await res.json().catch(() => null);
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to load snapshot details.');
                setViewMode('list');
            }
        } catch (error: unknown) {
            const err = error as Record<string, unknown> | null;
            toast.error(err?.message as string || err?.error as string || 'Something went wrong.');
            setViewMode('list');
        } finally {
            setLoadingDetail(false);
        }
    };

    const handleDelete = async (id: number) => {
        setDeletingId(id);
        try {
            const res = await apiFetch(`/fleet/snapshots/${id}`, {
                method: 'DELETE',
                localOnly: true,
            });
            if (res.ok) {
                toast.success('Snapshot deleted.');
                setSnapshots(prev => prev.filter(s => s.id !== id));
            } else {
                const err = await res.json().catch(() => null);
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to delete snapshot.');
            }
        } catch (error: unknown) {
            const err = error as Record<string, unknown> | null;
            toast.error(err?.message as string || err?.error as string || 'Something went wrong.');
        } finally {
            setDeletingId(null);
        }
    };

    const handleRestore = async (nodeId: number, stackName: string, redeploy: boolean, restoreNotes: boolean) => {
        if (!selectedSnapshot) return;
        const key = `${nodeId}:${stackName}`;
        setRestoringStack(key);
        try {
            const res = await apiFetch(`/fleet/snapshots/${selectedSnapshot.id}/restore`, {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({ nodeId, stackName, redeploy, restoreNotes }),
            });
            if (res.ok) {
                const data: { message: string; redeployed: boolean; notesRestored: boolean; notesError?: string } = await res.json();
                const base = data.redeployed ? 'Stack restored and redeployed.' : 'Stack restored successfully.';
                if (data.notesError) {
                    // Files restored; only the optional notes write failed.
                    toast.warning(`${base} Documentation notes could not be restored.`);
                } else {
                    toast.success(base + (data.notesRestored ? ' Documentation notes restored.' : ''));
                }
            } else {
                const err = await res.json().catch(() => null);
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to restore stack.');
            }
        } catch (error: unknown) {
            const err = error as Record<string, unknown> | null;
            toast.error(err?.message as string || err?.error as string || 'Something went wrong.');
        } finally {
            setRestoringStack(null);
        }
    };

    const handleDownloadFile = (stackName: string, file: SnapshotStackFile) => {
        try {
            const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${stackName}-${file.filename}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 100);
        } catch (error: unknown) {
            const err = error as Record<string, unknown> | null;
            toast.error((err?.message as string) || 'Download failed.');
        }
    };

    const handleRestoreAll = async (redeploy: boolean, restoreNotes: boolean) => {
        if (!selectedSnapshot) return;
        setRestoringAll(true);
        try {
            const res = await apiFetch(`/fleet/snapshots/${selectedSnapshot.id}/restore-all`, {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({ redeploy, restoreNotes }),
            });
            if (res.ok) {
                const data: {
                    restored: number;
                    failed: number;
                    redeploy: boolean;
                    results: Array<{ stackName: string; success: boolean; error?: string; notesError?: string }>;
                } = await res.json();
                const noun = (n: number) => `${n} stack${n === 1 ? '' : 's'}`;
                const firstFailed = data.results?.find(r => !r.success);
                const failDetail = firstFailed
                    ? ` First failure: ${firstFailed.stackName} · ${firstFailed.error || 'unknown error'}`
                    : '';
                // Files restored but the optional notes write failed on some stacks.
                const notesFailed = data.results?.filter(r => r.notesError).length ?? 0;
                const notesSuffix = notesFailed > 0 ? ` Documentation notes could not be restored for ${noun(notesFailed)}.` : '';
                if (data.failed === 0 && notesFailed === 0) {
                    toast.success(data.redeploy
                        ? `Restored and redeployed ${noun(data.restored)}.`
                        : `Restored ${noun(data.restored)}.`);
                } else if (data.restored === 0) {
                    toast.error(`Restore failed for ${noun(data.failed)}.${failDetail}`);
                } else if (data.failed === 0) {
                    toast.warning(`Restored ${noun(data.restored)}.${notesSuffix}`);
                } else {
                    toast.warning(`${data.restored} restored, ${data.failed} failed.${failDetail}${notesSuffix}`);
                }
            } else {
                const err = await res.json().catch(() => null);
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to restore snapshot.');
            }
        } catch (error: unknown) {
            const err = error as Record<string, unknown> | null;
            toast.error(err?.message as string || err?.error as string || 'Something went wrong.');
        } finally {
            setRestoringAll(false);
        }
    };

    // --- Toggle helpers ---

    const toggleNode = (nodeId: number) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    };

    const toggleStack = (key: string) => {
        setExpandedStacks(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const togglePreview = (key: string) => {
        setPreviewFiles(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    // --- Parse JSON-array warning columns safely ---

    function parseJsonArray<T>(raw: string): T[] {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed as T[];
        } catch { /* invalid JSON */ }
        return [];
    }

    // --- Detail View ---

    if (viewMode === 'detail') {
        return (
            <div className="space-y-4">
                {/* Back button */}
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 -ml-2"
                    onClick={() => { setViewMode('list'); setSelectedSnapshot(null); }}
                >
                    <ArrowLeft className="w-4 h-4" strokeWidth={1.5} />
                    Back to Snapshots
                </Button>

                {loadingDetail ? (
                    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel p-6 space-y-4">
                        <Skeleton className="h-6 w-64" />
                        <Skeleton className="h-4 w-48" />
                        <div className="flex gap-2">
                            <Skeleton className="h-5 w-20 rounded-full" />
                            <Skeleton className="h-5 w-20 rounded-full" />
                        </div>
                        <Skeleton className="h-32 w-full" />
                    </div>
                ) : selectedSnapshot ? (
                    <>
                        {/* Header card */}
                        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel p-4 space-y-3">
                            <div className="flex items-start justify-between gap-3">
                                <div className="space-y-1 min-w-0">
                                    <h2 className="text-lg font-semibold">
                                        {selectedSnapshot.description || 'Untitled Snapshot'}
                                    </h2>
                                    <p className="text-sm text-muted-foreground">
                                        Created by {selectedSnapshot.created_by} on{' '}
                                        {new Date(selectedSnapshot.created_at).toLocaleString()}
                                    </p>
                                </div>
                                {isAdmin && selectedSnapshot.nodes.length > 0 && (
                                    <RestoreAllButton
                                        restoring={restoringAll}
                                        hasDocumentation={(selectedSnapshot.documentation?.stacks.length ?? 0) > 0}
                                        onRestoreAll={handleRestoreAll}
                                    />
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <Badge variant="secondary" className="font-mono tabular-nums">
                                    {selectedSnapshot.node_count} node{selectedSnapshot.node_count !== 1 ? 's' : ''}
                                </Badge>
                                <Badge variant="secondary" className="font-mono tabular-nums">
                                    {selectedSnapshot.stack_count} stack{selectedSnapshot.stack_count !== 1 ? 's' : ''}
                                </Badge>
                                {(selectedSnapshot.documentation?.stacks.length ?? 0) > 0 && (
                                    <Badge variant="outline" className="gap-1">
                                        <BookText className="w-3 h-3" strokeWidth={1.5} />
                                        Documentation captured
                                    </Badge>
                                )}
                            </div>
                        </div>

                        {/* Skipped nodes warning */}
                        {(() => {
                            const skipped = parseJsonArray<SkippedNode>(selectedSnapshot.skipped_nodes);
                            if (skipped.length === 0) return null;
                            return (
                                <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                                        <span className="text-sm font-medium text-warning">
                                            Some nodes were unreachable during snapshot creation:
                                        </span>
                                    </div>
                                    <ul className="ml-6 space-y-1">
                                        {skipped.map(node => (
                                            <li key={node.nodeId} className="text-sm text-muted-foreground">
                                                <span className="font-medium">{node.nodeName}</span>
                                                {' - '}
                                                {node.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            );
                        })()}

                        {/* Partially captured stacks warning */}
                        {(() => {
                            const skipped = parseJsonArray<SkippedStack>(selectedSnapshot.skipped_stacks);
                            if (skipped.length === 0) return null;
                            return (
                                <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                                        <span className="text-sm font-medium text-warning">
                                            Some stacks were not fully captured:
                                        </span>
                                    </div>
                                    <ul className="ml-6 space-y-1">
                                        {skipped.map((stack, i) => (
                                            <li key={`${stack.nodeId}:${stack.stackName}:${i}`} className="text-sm text-muted-foreground">
                                                <span className="font-medium">{stack.nodeName}</span>
                                                {' / '}
                                                <span className="font-mono">{stack.stackName}</span>
                                                {' - '}
                                                {stack.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            );
                        })()}

                        {/* Documentation capture warnings (notes that could not be fetched) */}
                        {(() => {
                            const warnings = selectedSnapshot.documentation?.warnings ?? [];
                            if (warnings.length === 0) return null;
                            return (
                                <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                                        <span className="text-sm font-medium text-warning">
                                            Some stack documentation could not be captured:
                                        </span>
                                    </div>
                                    <ul className="ml-6 space-y-1">
                                        {warnings.map((w, i) => (
                                            <li key={`${w.nodeId}:${w.stackName}:${i}`} className="text-sm text-muted-foreground">
                                                <span className="font-medium">{w.nodeName}</span>
                                                {' / '}
                                                <span className="font-mono">{w.stackName}</span>
                                                {' - '}
                                                {w.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            );
                        })()}

                        {/* Node / Stack / File tree */}
                        <div className="space-y-2">
                            {selectedSnapshot.nodes.map(node => {
                                const nodeExpanded = expandedNodes.has(node.nodeId);
                                return (
                                    <div key={node.nodeId} className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel overflow-hidden transition-colors hover:border-t-card-border-hover">
                                        {/* Node header */}
                                        <button
                                            onClick={() => toggleNode(node.nodeId)}
                                            className="flex items-center gap-2.5 w-full px-4 py-3 text-left hover:bg-muted/50 transition-colors"
                                        >
                                            {nodeExpanded
                                                ? <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
                                                : <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
                                            }
                                            <Server className="w-4 h-4 text-muted-foreground shrink-0" />
                                            <span className="text-sm font-medium flex-1 truncate">{node.nodeName}</span>
                                            <Badge variant="outline" className="text-xs font-mono tabular-nums shrink-0">
                                                {node.stacks.length} stack{node.stacks.length !== 1 ? 's' : ''}
                                            </Badge>
                                        </button>

                                        {/* Stacks */}
                                        {nodeExpanded && (
                                            <div className="border-t px-2 pb-3">
                                                {node.stacks.map(stack => {
                                                    const stackKey = `${node.nodeId}:${stack.stackName}`;
                                                    const stackExpanded = expandedStacks.has(stackKey);
                                                    const dossier = selectedSnapshot.documentation?.stacks
                                                        .find(s => s.nodeId === node.nodeId && s.stackName === stack.stackName)?.dossier;
                                                    return (
                                                        <div key={stackKey}>
                                                            <div className="flex items-center gap-2 pr-3 rounded-md hover:bg-muted/50 transition-colors">
                                                                <button
                                                                    onClick={() => toggleStack(stackKey)}
                                                                    className="flex items-center gap-2 flex-1 min-w-0 px-3 py-2 text-left"
                                                                >
                                                                    {stackExpanded
                                                                        ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                                                                        : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                                                                    }
                                                                    <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                                                    <span className="text-xs font-mono font-medium flex-1 truncate">
                                                                        {stack.stackName}
                                                                    </span>
                                                                    <Badge variant="outline" className="text-[10px] font-mono tabular-nums px-1.5 py-0 h-4 shrink-0">
                                                                        {stack.files.length} file{stack.files.length !== 1 ? 's' : ''}
                                                                    </Badge>
                                                                </button>
                                                                {isAdmin && (
                                                                    <RestoreButton
                                                                        nodeId={node.nodeId}
                                                                        nodeName={node.nodeName}
                                                                        stackName={stack.stackName}
                                                                        hasDossier={!!dossier}
                                                                        restoring={restoringStack === `${node.nodeId}:${stack.stackName}`}
                                                                        onRestore={handleRestore}
                                                                    />
                                                                )}
                                                            </div>

                                                            {/* Files */}
                                                            {stackExpanded && (
                                                                <div className="ml-6 space-y-1 mt-1">
                                                                    {stack.files.map(file => {
                                                                        const fileKey = `${stackKey}:${file.filename}`;
                                                                        const showPreview = previewFiles.has(fileKey);
                                                                        return (
                                                                            <div key={fileKey}>
                                                                                <div className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-muted/50 transition-colors">
                                                                                    <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                                                                    <span className="text-xs font-mono flex-1 truncate">{file.filename}</span>
                                                                                    <Button
                                                                                        variant="ghost"
                                                                                        size="sm"
                                                                                        className="h-6 px-2 text-xs"
                                                                                        onClick={() => togglePreview(fileKey)}
                                                                                    >
                                                                                        <Eye className="w-3 h-3 mr-1" strokeWidth={1.5} />
                                                                                        {showPreview ? 'Hide' : 'Preview'}
                                                                                    </Button>
                                                                                    <Button
                                                                                        variant="ghost"
                                                                                        size="sm"
                                                                                        className="h-6 px-2 text-xs"
                                                                                        onClick={() => handleDownloadFile(stack.stackName, file)}
                                                                                    >
                                                                                        <Download className="w-3 h-3 mr-1" strokeWidth={1.5} />
                                                                                        Download
                                                                                    </Button>
                                                                                </div>
                                                                                {showPreview && (
                                                                                    <div className="mx-3 mt-1 mb-2 max-h-[480px] overflow-y-auto rounded-lg bg-background shadow-[inset_0_2px_4px_0_oklch(0_0_0/0.4)]">
                                                                                        <pre className="p-3 text-xs font-mono text-foreground whitespace-pre-wrap break-words">
                                                                                            {file.content}
                                                                                        </pre>
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    })}

                                                                    {/* Preserved dossier notes (read-only) */}
                                                                    {dossier && <DossierBlock dossier={dossier} />}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </>
                ) : null}
            </div>
        );
    }

    // --- List View ---

    return (
        <div className="space-y-4">
            <FleetTabHeading
                title="Fleet Snapshots"
                subtitle="Point-in-time compose backups across every node."
                action={
                    <div className="flex items-center gap-2">
                        {needsPagination && (
                            <div className="flex items-center gap-1.5">
                                <Button variant="ghost" size="icon" className="h-6 w-6" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
                                    <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
                                </Button>
                                <span className="text-xs font-mono tabular-nums text-stat-subtitle min-w-[3rem] text-center">
                                    {safePage + 1} / {totalPages}
                                </span>
                                <Button variant="ghost" size="icon" className="h-6 w-6" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>
                                    <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
                                </Button>
                            </div>
                        )}
                        {isAdmin && !showCreateForm && (
                            <Button size="sm" className="gap-1.5" onClick={() => setShowCreateForm(true)}>
                                <Plus className="w-4 h-4" strokeWidth={1.5} />
                                Create Snapshot
                            </Button>
                        )}
                    </div>
                }
            />

            {/* Create form */}
            {showCreateForm && (
                <div className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel p-4 space-y-3">
                    <Input
                        placeholder="Snapshot description (optional)"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        disabled={creating}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                    />
                    <div className="flex items-center gap-2">
                        <Button size="sm" onClick={handleCreate} disabled={creating} className="gap-1.5">
                            {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            Create
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { setShowCreateForm(false); setDescription(''); }}
                            disabled={creating}
                        >
                            Cancel
                        </Button>
                    </div>
                </div>
            )}

            {/* Loading state */}
            {loading ? (
                <div className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel">
                    <div className="p-4 space-y-3">
                        {Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="flex items-center gap-4">
                                <Skeleton className="h-4 w-32" />
                                <Skeleton className="h-4 w-48 flex-1" />
                                <Skeleton className="h-4 w-28" />
                                <Skeleton className="h-8 w-16" />
                            </div>
                        ))}
                    </div>
                </div>
            ) : snapshots.length === 0 ? (
                <FleetEmptyState>
                    <FleetEmptyCard
                        icon={Camera}
                        title="No snapshots yet"
                        description="Create your first fleet snapshot to back up compose files across all nodes."
                        action={isAdmin && !showCreateForm ? (
                            <Button size="sm" className="gap-1.5" onClick={() => setShowCreateForm(true)}>
                                <Plus className="w-4 h-4" strokeWidth={1.5} />
                                Create Snapshot
                            </Button>
                        ) : undefined}
                    />
                </FleetEmptyState>
            ) : (
                /* Snapshots table */
                <div className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Date</TableHead>
                                <TableHead>Description</TableHead>
                                <TableHead>Scope</TableHead>
                                <TableHead>Warnings</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {pagedSnapshots.map(snapshot => {
                                const skippedNodes = parseJsonArray<SkippedNode>(snapshot.skipped_nodes);
                                const skippedStacks = parseJsonArray<SkippedStack>(snapshot.skipped_stacks);
                                const warningCount = skippedNodes.length + skippedStacks.length;
                                const warningTitle = [
                                    skippedNodes.length > 0 ? `Nodes: ${skippedNodes.map(s => s.nodeName).join(', ')}` : '',
                                    skippedStacks.length > 0 ? `Stacks: ${skippedStacks.map(s => `${s.nodeName}/${s.stackName}`).join(', ')}` : '',
                                ].filter(Boolean).join(' · ');
                                return (
                                    <TableRow key={snapshot.id}>
                                        <TableCell className="text-xs font-mono tabular-nums whitespace-nowrap">
                                            {new Date(snapshot.created_at).toLocaleString()}
                                        </TableCell>
                                        <TableCell className="text-sm max-w-[300px] truncate">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                {snapshot.description ? (
                                                    <span className="truncate">{snapshot.description}</span>
                                                ) : (
                                                    <span className="italic text-muted-foreground">No description</span>
                                                )}
                                                {cloudSnapshotIds.has(snapshot.id) && (
                                                    <Cloud
                                                        className="w-3.5 h-3.5 text-success shrink-0"
                                                        strokeWidth={1.5}
                                                        aria-label="Uploaded to cloud"
                                                    />
                                                )}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-xs font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                                            {snapshot.node_count} node{snapshot.node_count !== 1 ? 's' : ''}
                                            {' · '}
                                            {snapshot.stack_count} stack{snapshot.stack_count !== 1 ? 's' : ''}
                                        </TableCell>
                                        <TableCell>
                                            {warningCount > 0 ? (
                                                <span
                                                    className="flex items-center gap-1 text-warning"
                                                    title={warningTitle}
                                                >
                                                    <AlertTriangle className="w-3.5 h-3.5" />
                                                    <span className="text-xs font-mono tabular-nums">{warningCount}</span>
                                                </span>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">None</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex items-center justify-end gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-7 px-2 text-xs"
                                                    onClick={() => handleViewDetail(snapshot)}
                                                >
                                                    <Eye className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                                    View
                                                </Button>
                                                {isAdmin && cloudEnabled && !cloudSnapshotIds.has(snapshot.id) && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-7 px-2 text-xs"
                                                        title="Upload to cloud"
                                                        disabled={uploadingId === snapshot.id}
                                                        onClick={() => handleCloudUpload(snapshot.id)}
                                                    >
                                                        {uploadingId === snapshot.id ? (
                                                            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                                                        ) : (
                                                            <CloudUpload className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                        )}
                                                    </Button>
                                                )}
                                                {isAdmin && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-7 px-2 text-xs text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                                                        disabled={deletingId === snapshot.id}
                                                        onClick={() => setConfirmDeleteId(snapshot.id)}
                                                    >
                                                        {deletingId === snapshot.id ? (
                                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                        ) : (
                                                            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                        )}
                                                    </Button>
                                                )}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}

            <ConfirmModal
                open={confirmDeleteId !== null}
                onOpenChange={(open) => { if (!open) setConfirmDeleteId(null); }}
                variant="destructive"
                kicker="SNAPSHOTS · DELETE · IRREVERSIBLE"
                title="Delete snapshot"
                confirmLabel="Delete"
                onConfirm={async () => {
                    if (confirmDeleteId !== null) {
                        const id = confirmDeleteId;
                        setConfirmDeleteId(null);
                        await handleDelete(id);
                    }
                }}
            >
                <p className="text-sm text-stat-subtitle">
                    Permanently removes this fleet snapshot.
                </p>
            </ConfirmModal>
        </div>
    );
}

// --- Restore Button Sub-Component ---

function RestoreButton({ nodeId, nodeName, stackName, hasDossier, restoring, onRestore }: {
    nodeId: number;
    nodeName: string;
    stackName: string;
    hasDossier: boolean;
    restoring: boolean;
    onRestore: (nodeId: number, stackName: string, redeploy: boolean, restoreNotes: boolean) => Promise<void>;
}) {
    const [redeploy, setRedeploy] = useState(false);
    const [restoreNotes, setRestoreNotes] = useState(false);
    const [open, setOpen] = useState(false);

    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={restoring}
                onClick={() => setOpen(true)}
            >
                {restoring ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                    <RotateCcw className="w-3 h-3 mr-1" strokeWidth={1.5} />
                )}
                Restore
            </Button>
            <ConfirmModal
                open={open}
                onOpenChange={setOpen}
                kicker="SNAPSHOTS · RESTORE"
                title={`Restore ${stackName} on ${nodeName}`}
                confirmLabel={restoring ? 'Restoring...' : 'Restore'}
                confirming={restoring}
                onConfirm={async () => {
                    try {
                        await onRestore(nodeId, stackName, redeploy, restoreNotes);
                    } finally {
                        setOpen(false);
                    }
                }}
            >
                <p className="text-sm text-stat-subtitle">
                    Overwrites the current compose files with the snapshot version.
                </p>
                <div className="flex items-center space-x-2 pt-1">
                    <Checkbox
                        id={`redeploy-${nodeId}-${stackName}`}
                        checked={redeploy}
                        onCheckedChange={(checked) => setRedeploy(checked === true)}
                    />
                    <Label
                        htmlFor={`redeploy-${nodeId}-${stackName}`}
                        className="text-sm cursor-pointer"
                    >
                        Redeploy stack after restore
                    </Label>
                </div>
                {hasDossier && (
                    <div className="flex items-center space-x-2 pt-1">
                        <Checkbox
                            id={`notes-${nodeId}-${stackName}`}
                            checked={restoreNotes}
                            onCheckedChange={(checked) => setRestoreNotes(checked === true)}
                        />
                        <Label
                            htmlFor={`notes-${nodeId}-${stackName}`}
                            className="text-sm cursor-pointer"
                        >
                            Restore documentation notes (overwrites current notes)
                        </Label>
                    </div>
                )}
            </ConfirmModal>
        </>
    );
}

// --- Preserved Dossier Sub-Component ---

function DossierBlock({ dossier }: { dossier: SnapshotDossierFields }) {
    const entries = DOSSIER_FIELD_LABELS.filter(([key]) => (dossier[key] ?? '').trim() !== '');
    if (entries.length === 0) return null;
    return (
        <div className="ml-3 mt-1 rounded-lg border border-card-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-1.5 mb-1.5">
                <BookText className="w-3 h-3 text-muted-foreground shrink-0" strokeWidth={1.5} />
                <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">Dossier notes</span>
            </div>
            <dl className="space-y-1">
                {entries.map(([key, label]) => (
                    <div key={key} className="grid grid-cols-[7rem_1fr] gap-2">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="text-xs whitespace-pre-wrap break-words">{dossier[key]}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

// --- Restore All Button Sub-Component ---

function RestoreAllButton({ restoring, hasDocumentation, onRestoreAll }: {
    restoring: boolean;
    hasDocumentation: boolean;
    onRestoreAll: (redeploy: boolean, restoreNotes: boolean) => Promise<void>;
}) {
    const [redeploy, setRedeploy] = useState(false);
    const [restoreNotes, setRestoreNotes] = useState(false);
    const [open, setOpen] = useState(false);

    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs shrink-0"
                disabled={restoring}
                onClick={() => setOpen(true)}
            >
                {restoring ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                    <RotateCcw className="w-3 h-3 mr-1" strokeWidth={1.5} />
                )}
                Restore all
            </Button>
            <ConfirmModal
                open={open}
                onOpenChange={setOpen}
                variant="destructive"
                kicker="SNAPSHOTS · RESTORE ALL"
                title="Restore all stacks"
                confirmLabel={restoring ? 'Restoring...' : 'Restore all'}
                confirming={restoring}
                onConfirm={async () => {
                    try {
                        await onRestoreAll(redeploy, restoreNotes);
                    } finally {
                        setOpen(false);
                    }
                }}
            >
                <p className="text-sm text-stat-subtitle">
                    Overwrites the current compose and environment files for every stack on every node in this snapshot.
                </p>
                <div className="flex items-center space-x-2 pt-1">
                    <Checkbox
                        id="redeploy-all"
                        checked={redeploy}
                        onCheckedChange={(checked) => setRedeploy(checked === true)}
                    />
                    <Label htmlFor="redeploy-all" className="text-sm cursor-pointer">
                        Redeploy all stacks after restore
                    </Label>
                </div>
                {hasDocumentation && (
                    <div className="flex items-center space-x-2 pt-1">
                        <Checkbox
                            id="notes-all"
                            checked={restoreNotes}
                            onCheckedChange={(checked) => setRestoreNotes(checked === true)}
                        />
                        <Label htmlFor="notes-all" className="text-sm cursor-pointer">
                            Restore documentation notes (overwrites current notes)
                        </Label>
                    </div>
                )}
            </ConfirmModal>
        </>
    );
}

import { useState, useEffect, useCallback } from 'react';
import {
    Camera, ArrowLeft, Server, Layers, FileText, AlertTriangle, Trash2,
    Eye, ChevronDown, ChevronLeft, ChevronRight, Plus, Loader2, RotateCcw,
    Cloud, CloudUpload,
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { toast } from '@/components/ui/toast-store';

// --- Types ---

interface FleetSnapshot {
    id: number;
    description: string;
    created_by: string;
    node_count: number;
    stack_count: number;
    skipped_nodes: string; // JSON string
    created_at: number;
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

interface FleetSnapshotDetail extends FleetSnapshot {
    nodes: SnapshotNode[];
}

interface SkippedNode {
    nodeId: number;
    nodeName: string;
    reason: string;
}

const PAGE_SIZE = 10;

// --- Main Component ---

export default function FleetSnapshots() {
    const { isAdmin } = useAuth();

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
            setCloudEnabled(data.provider !== 'disabled');
        } catch {
            // best-effort; cloud affordances stay hidden on failure
        }
    }, []);

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

    const handleRestore = async (nodeId: number, stackName: string, redeploy: boolean) => {
        if (!selectedSnapshot) return;
        const key = `${nodeId}:${stackName}`;
        setRestoringStack(key);
        try {
            const res = await apiFetch(`/fleet/snapshots/${selectedSnapshot.id}/restore`, {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({ nodeId, stackName, redeploy }),
            });
            if (res.ok) {
                const data: { message: string; redeployed: boolean } = await res.json();
                toast.success(data.redeployed ? 'Stack restored and redeployed.' : 'Stack restored successfully.');
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

    // --- Parse skipped nodes safely ---

    function parseSkippedNodes(raw: string): SkippedNode[] {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed as SkippedNode[];
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
                            <h2 className="text-lg font-semibold">
                                {selectedSnapshot.description || 'Untitled Snapshot'}
                            </h2>
                            <p className="text-sm text-muted-foreground">
                                Created by {selectedSnapshot.created_by} on{' '}
                                {new Date(selectedSnapshot.created_at).toLocaleString()}
                            </p>
                            <div className="flex items-center gap-2">
                                <Badge variant="secondary" className="font-mono tabular-nums">
                                    {selectedSnapshot.node_count} node{selectedSnapshot.node_count !== 1 ? 's' : ''}
                                </Badge>
                                <Badge variant="secondary" className="font-mono tabular-nums">
                                    {selectedSnapshot.stack_count} stack{selectedSnapshot.stack_count !== 1 ? 's' : ''}
                                </Badge>
                            </div>
                        </div>

                        {/* Skipped nodes warning */}
                        {(() => {
                            const skipped = parseSkippedNodes(selectedSnapshot.skipped_nodes);
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
                                                    return (
                                                        <div key={stackKey}>
                                                            <button
                                                                onClick={() => toggleStack(stackKey)}
                                                                className="flex items-center gap-2 w-full px-3 py-2 text-left rounded-md hover:bg-muted/50 transition-colors"
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
                                                                                </div>
                                                                                {showPreview && (
                                                                                    <ScrollArea className="mx-3 mt-1 mb-2 max-h-64 rounded-lg bg-background shadow-[inset_0_2px_4px_0_oklch(0_0_0/0.4)]">
                                                                                        <pre className="p-3 text-xs font-mono text-foreground whitespace-pre-wrap break-words">
                                                                                            {file.content}
                                                                                        </pre>
                                                                                    </ScrollArea>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    })}

                                                                    {/* Restore button (admin only) */}
                                                                    {isAdmin && (
                                                                        <RestoreButton
                                                                            nodeId={node.nodeId}
                                                                            nodeName={node.nodeName}
                                                                            stackName={stack.stackName}
                                                                            restoring={restoringStack === `${node.nodeId}:${stack.stackName}`}
                                                                            onRestore={handleRestore}
                                                                        />
                                                                    )}
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
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                    <Camera className="w-5 h-5 text-muted-foreground" strokeWidth={1.5} />
                    <h2 className="text-lg font-semibold">Fleet Snapshots</h2>
                </div>
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
            </div>

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
                /* Empty state */
                <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Camera className="w-12 h-12 text-muted-foreground/50 mb-4" />
                    <h3 className="text-sm font-medium mb-1">No snapshots yet</h3>
                    <p className="text-xs text-muted-foreground max-w-sm">
                        Create your first fleet snapshot to back up compose files across all nodes.
                    </p>
                </div>
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
                                const skipped = parseSkippedNodes(snapshot.skipped_nodes);
                                const skippedNames = skipped.map(s => s.nodeName).join(', ');
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
                                            {skipped.length > 0 ? (
                                                <span
                                                    className="flex items-center gap-1 text-warning"
                                                    title={`Skipped: ${skippedNames}`}
                                                >
                                                    <AlertTriangle className="w-3.5 h-3.5" />
                                                    <span className="text-xs font-mono tabular-nums">{skipped.length}</span>
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

function RestoreButton({ nodeId, nodeName, stackName, restoring, onRestore }: {
    nodeId: number;
    nodeName: string;
    stackName: string;
    restoring: boolean;
    onRestore: (nodeId: number, stackName: string, redeploy: boolean) => Promise<void>;
}) {
    const [redeploy, setRedeploy] = useState(false);
    const [open, setOpen] = useState(false);

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs gap-1.5 ml-3 mt-1"
                disabled={restoring}
                onClick={() => setOpen(true)}
            >
                {restoring ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                    <RotateCcw className="w-3 h-3" strokeWidth={1.5} />
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
                        await onRestore(nodeId, stackName, redeploy);
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
            </ConfirmModal>
        </>
    );
}

import { useEffect, useState, useCallback } from 'react';
import { ChevronLeft, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Modal, ModalDestructiveHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
    DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast-store';
import {
    type BlueprintSummary,
    type CreateBlueprintInput,
    type UpdateBlueprintInput,
    type WithdrawConfirm,
    type AcceptMode,
    getBlueprint,
    applyBlueprint,
    updateBlueprint,
    deleteBlueprint,
    withdrawDeployment,
    acceptDeployment,
    describeSelector,
} from '@/lib/blueprintsApi';
import { BlueprintEditor } from './BlueprintEditor';
import { BlueprintDeploymentTable } from './BlueprintDeploymentTable';
import { EvictionDialog } from './EvictionDialog';
import { StateReviewDialog } from './StateReviewDialog';
import { useNodes } from '@/context/NodeContext';
import { formatTimeAgo } from '@/lib/relativeTime';

interface BlueprintDetailProps {
    blueprintId: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
    canEdit: boolean;
    distinctLabels: string[];
}

export function BlueprintDetail({ blueprintId, open, onOpenChange, onChanged, canEdit, distinctLabels }: BlueprintDetailProps) {
    const [summary, setSummary] = useState<BlueprintSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [busyNodeId, setBusyNodeId] = useState<number | null>(null);
    const [evictTarget, setEvictTarget] = useState<{ nodeId: number; nodeName: string } | null>(null);
    const [stateReviewTarget, setStateReviewTarget] = useState<{ nodeId: number; nodeName: string } | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const { nodes } = useNodes();

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const result = await getBlueprint(blueprintId);
            setSummary(result);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to load blueprint');
            onOpenChange(false);
        } finally {
            setLoading(false);
        }
    }, [blueprintId, onOpenChange]);

    useEffect(() => {
        if (open) {
            void refresh();
            setEditMode(false);
        }
    }, [open, refresh]);

    if (!open) return null;

    const blueprint = summary?.blueprint;

    async function handleApply() {
        if (!blueprint) return;
        setSubmitting(true);
        try {
            await applyBlueprint(blueprint.id);
            toast.success('Reconciliation triggered');
            await refresh();
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to apply blueprint');
        } finally {
            setSubmitting(false);
        }
    }

    async function handleSaveEdit(input: CreateBlueprintInput | UpdateBlueprintInput) {
        if (!blueprint) return;
        setSubmitting(true);
        try {
            await updateBlueprint(blueprint.id, input as UpdateBlueprintInput);
            toast.success('Blueprint saved');
            setEditMode(false);
            await refresh();
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save blueprint');
        } finally {
            setSubmitting(false);
        }
    }

    const deleteTypedOk = !!blueprint && deleteConfirmText.trim() === blueprint.name;

    async function performDelete() {
        if (!blueprint) return;
        setSubmitting(true);
        try {
            await deleteBlueprint(blueprint.id);
            toast.success('Blueprint deleted');
            setDeleteOpen(false);
            setDeleteConfirmText('');
            onChanged();
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete blueprint');
        } finally {
            setSubmitting(false);
        }
    }

    async function handleToggleEnabled() {
        if (!blueprint) return;
        setSubmitting(true);
        try {
            await updateBlueprint(blueprint.id, { enabled: !blueprint.enabled });
            toast.success(blueprint.enabled ? 'Reconciler disabled' : 'Reconciler enabled');
            await refresh();
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update blueprint');
        } finally {
            setSubmitting(false);
        }
    }

    async function performWithdraw(nodeId: number, confirm: WithdrawConfirm) {
        if (!blueprint) return;
        setBusyNodeId(nodeId);
        try {
            const result = await withdrawDeployment(blueprint.id, nodeId, confirm);
            if (result.error) toast.error(result.error);
            else if (confirm === 'evict_and_destroy') toast.success('Evicted and data removed');
            else if (confirm === 'snapshot_then_evict' && result.snapshotId !== null) {
                toast.success(`Compose snapshot #${result.snapshotId} captured. Deployment withdrawn.`);
            } else toast.success('Deployment withdrawn');
            await refresh();
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to withdraw');
        } finally {
            setBusyNodeId(null);
            setEvictTarget(null);
        }
    }

    async function performAccept(nodeId: number, mode: AcceptMode) {
        if (!blueprint) return;
        setBusyNodeId(nodeId);
        try {
            await acceptDeployment(blueprint.id, nodeId, mode);
            toast.success(mode === 'fresh' ? 'Deploying with fresh volumes' : 'Restoring from snapshot');
            await refresh();
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to accept deployment');
        } finally {
            setBusyNodeId(null);
            setStateReviewTarget(null);
        }
    }

    /**
     * Row-level retry isn't a backend primitive: the reconciler operates on the whole
     * blueprint, not a single deployment. We surface the row's "Retry" button and
     * trigger a full reconciliation tick, which retries failed deployments naturally.
     * The nodeId argument satisfies BlueprintDeploymentTable.onRetry's signature.
     */
    async function handleRetryRow(nodeId: number): Promise<void> {
        void nodeId;
        await handleApply();
    }

    function openWithdraw(nodeId: number) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        setEvictTarget({ nodeId, nodeName: node.name });
    }

    function openAcceptStateReview(nodeId: number) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        setStateReviewTarget({ nodeId, nodeName: node.name });
    }

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col gap-0 overflow-y-auto p-0">
                <SheetHeader className="sticky top-0 z-10 bg-popover/95 backdrop-blur-md border-b border-border px-6 py-4">
                    <div className="flex items-center justify-between gap-3">
                        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="gap-1.5 -ml-2">
                            <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
                            Back
                        </Button>
                        {blueprint && (
                            <div className="flex items-center gap-1.5">
                                <Button size="sm" onClick={handleApply} disabled={submitting || !blueprint.enabled} className="gap-1.5">
                                    <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
                                    Apply now
                                </Button>
                                {canEdit && !editMode && (
                                    <Button size="sm" variant="outline" onClick={() => setEditMode(true)} className="gap-1.5">
                                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                                        Edit
                                    </Button>
                                )}
                                {canEdit && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button size="icon" variant="ghost" className="h-8 w-8" disabled={submitting}>
                                                <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={handleToggleEnabled} disabled={submitting}>
                                                {blueprint.enabled ? 'Disable reconciler' : 'Enable reconciler'}
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem onClick={() => setDeleteOpen(true)} className="text-destructive">
                                                <Trash2 className="h-3.5 w-3.5 mr-2" strokeWidth={1.5} />
                                                Delete blueprint
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="space-y-1.5">
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">
                            Blueprint
                        </span>
                        <SheetTitle className="font-serif italic text-2xl tracking-[-0.01em] text-stat-value">
                            {blueprint?.name ?? <Skeleton className="h-7 w-40" />}
                        </SheetTitle>
                        {blueprint?.description && (
                            <p className="text-xs text-stat-subtitle">{blueprint.description}</p>
                        )}
                    </div>
                </SheetHeader>

                <div className="px-6 py-5 space-y-5">
                    {loading || !blueprint || !summary ? (
                        <div className="space-y-3">
                            <Skeleton className="h-12 w-full" />
                            <Skeleton className="h-32 w-full" />
                            <Skeleton className="h-40 w-full" />
                        </div>
                    ) : editMode ? (
                        <BlueprintEditor
                            mode="edit"
                            initial={blueprint}
                            distinctLabels={distinctLabels}
                            onCancel={() => setEditMode(false)}
                            onSubmit={handleSaveEdit}
                            submitting={submitting}
                        />
                    ) : (
                        <>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                <Stat label="Selector" value={describeSelector(blueprint.selector)} />
                                <Stat label="Drift" value={blueprint.drift_mode} />
                                <Stat label="Revision" value={String(blueprint.revision)} />
                                <Stat label="Last updated" value={formatTimeAgo(blueprint.updated_at)} />
                            </div>

                            <BlueprintDeploymentTable
                                deployments={summary.deployments}
                                classification={blueprint.classification}
                                canEdit={canEdit}
                                busyNodeId={busyNodeId}
                                onWithdraw={openWithdraw}
                                onAcceptStateReview={openAcceptStateReview}
                                onRetry={handleRetryRow}
                            />

                            <details className="rounded-lg border border-card-border bg-card">
                                <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon hover:text-stat-value">
                                    Compose
                                </summary>
                                <pre className="px-3 pb-3 font-mono text-[11px] text-stat-value overflow-x-auto whitespace-pre-wrap">
                                    {blueprint.compose_content}
                                </pre>
                            </details>
                        </>
                    )}
                </div>

                {evictTarget && blueprint && (
                    <EvictionDialog
                        open={!!evictTarget}
                        onOpenChange={(o) => { if (!o) setEvictTarget(null); }}
                        blueprintName={blueprint.name}
                        nodeName={evictTarget.nodeName}
                        isStateful={blueprint.classification === 'stateful' || blueprint.classification === 'unknown'}
                        busy={busyNodeId === evictTarget.nodeId}
                        onConfirm={(mode) => performWithdraw(evictTarget.nodeId, mode)}
                    />
                )}
                {stateReviewTarget && blueprint && (
                    <StateReviewDialog
                        open={!!stateReviewTarget}
                        onOpenChange={(o) => { if (!o) setStateReviewTarget(null); }}
                        blueprintName={blueprint.name}
                        nodeName={stateReviewTarget.nodeName}
                        busy={busyNodeId === stateReviewTarget.nodeId}
                        onAccept={(mode) => performAccept(stateReviewTarget.nodeId, mode)}
                    />
                )}
                {blueprint && (
                    <Modal open={deleteOpen} onOpenChange={(o) => { if (!o) { setDeleteOpen(false); setDeleteConfirmText(''); } }} size="md">
                        <ModalDestructiveHeader
                            kicker="BLUEPRINT · DELETE · IRREVERSIBLE"
                            title={`Delete ${blueprint.name}`}
                            description="Stateless deployments will be withdrawn first. Stateful deployments must be withdrawn explicitly through the deployment table before delete; the API will refuse otherwise."
                        />
                        <ModalBody>
                            <p className="text-sm text-stat-subtitle">
                                Stateless deployments will be withdrawn first. Stateful deployments must be withdrawn explicitly through the deployment table before delete.
                            </p>
                            <div className="space-y-2">
                                <p className="text-xs text-stat-subtitle leading-relaxed">
                                    Type <span className="font-mono text-stat-value">{blueprint.name}</span> to confirm.
                                </p>
                                <Input
                                    value={deleteConfirmText}
                                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                                    placeholder={blueprint.name}
                                    className="font-mono text-xs"
                                    disabled={submitting}
                                />
                            </div>
                        </ModalBody>
                        <ModalFooter
                            secondary={
                                <Button variant="outline" size="sm" onClick={() => { setDeleteOpen(false); setDeleteConfirmText(''); }} disabled={submitting}>
                                    Cancel
                                </Button>
                            }
                            primary={
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    disabled={!deleteTypedOk || submitting}
                                    onClick={performDelete}
                                >
                                    Delete blueprint
                                </Button>
                            }
                        />
                    </Modal>
                )}
            </SheetContent>
        </Sheet>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="space-y-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">{label}</span>
            <p className="font-mono text-sm tabular-nums tracking-tight text-stat-value truncate">{value}</p>
        </div>
    );
}

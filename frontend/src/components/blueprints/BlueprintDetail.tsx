import { useEffect, useRef, useState, useCallback } from 'react';
import { Pencil, Pin, Play, Power, Trash2 } from 'lucide-react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { Modal, ModalDestructiveHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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

    // Hold the latest onOpenChange without making it a refresh dependency. Parents
    // pass a fresh closure on every render, so binding refresh to it would re-run the
    // load effect on each parent render and flicker the body through its skeleton.
    const onOpenChangeRef = useRef(onOpenChange);
    useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const result = await getBlueprint(blueprintId);
            setSummary(result);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to load blueprint');
            onOpenChangeRef.current(false);
        } finally {
            setLoading(false);
        }
    }, [blueprintId]);

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

    const meta = blueprint
        ? `${describeSelector(blueprint.selector)} · ${blueprint.drift_mode} · rev ${blueprint.revision}`
        : (loading ? 'Loading…' : '');

    const footerContext = blueprint
        ? `Updated ${formatTimeAgo(blueprint.updated_at)}${blueprint.enabled ? '' : ' · reconciler disabled'}`
        : undefined;

    const secondaryActions = blueprint && canEdit
        ? [
            ...(!editMode ? [{
                label: 'Edit',
                icon: Pencil,
                onClick: () => setEditMode(true),
                disabled: submitting,
            }] : []),
            {
                label: blueprint.enabled ? 'Disable' : 'Enable',
                icon: Power,
                onClick: handleToggleEnabled,
                disabled: submitting,
            },
        ]
        : undefined;

    return (
        <>
            <SystemSheet
                open={open}
                onOpenChange={onOpenChange}
                crumb={['Blueprints', blueprint?.name ?? '…']}
                name={blueprint?.name ?? <Skeleton className="h-7 w-40 inline-block" />}
                meta={meta}
                primaryAction={blueprint && canEdit ? {
                    label: 'Apply now',
                    icon: Play,
                    onClick: handleApply,
                    disabled: submitting || !blueprint.enabled || editMode,
                } : undefined}
                secondaryActions={secondaryActions}
                destructiveAction={blueprint && canEdit ? {
                    label: 'Delete',
                    icon: Trash2,
                    onClick: () => setDeleteOpen(true),
                    disabled: submitting || editMode,
                } : undefined}
                footerContext={footerContext}
                size="lg"
            >
                {!blueprint || !summary ? (
                    <div className="space-y-3">
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-32 w-full" />
                        <Skeleton className="h-40 w-full" />
                    </div>
                ) : editMode ? (
                    <SheetSection title="Edit blueprint" hideHeader>
                        <BlueprintEditor
                            mode="edit"
                            initial={blueprint}
                            distinctLabels={distinctLabels}
                            onCancel={() => setEditMode(false)}
                            onSubmit={handleSaveEdit}
                            submitting={submitting}
                        />
                    </SheetSection>
                ) : (
                    <>
                        {blueprint.pinned_node_id !== null && (
                            <SheetSection title="Pin" hideHeader>
                                <div className="flex items-start gap-2 rounded-md border border-card-border bg-glass-highlight px-3 py-2">
                                    <Pin className="w-3.5 h-3.5 mt-0.5 text-foreground shrink-0" />
                                    <div className="text-xs text-stat-value">
                                        <span className="font-medium">Pinned to {nodes.find(n => n.id === blueprint.pinned_node_id)?.name ?? `node ${blueprint.pinned_node_id}`}.</span>{' '}
                                        <span className="text-stat-subtitle">Selector is overridden. Manage in the Federation tab.</span>
                                    </div>
                                </div>
                            </SheetSection>
                        )}

                        {blueprint.description && (
                            <SheetSection title="Description" hideHeader>
                                <p className="text-xs text-stat-subtitle">{blueprint.description}</p>
                            </SheetSection>
                        )}

                        <SheetSection title="Deployments">
                            <BlueprintDeploymentTable
                                deployments={summary.deployments}
                                classification={blueprint.classification}
                                canEdit={canEdit}
                                busyNodeId={busyNodeId}
                                onWithdraw={openWithdraw}
                                onAcceptStateReview={openAcceptStateReview}
                                onRetry={handleRetryRow}
                                pinnedNodeId={blueprint.pinned_node_id}
                            />
                        </SheetSection>

                        <SheetSection title="Compose">
                            <details>
                                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle hover:text-stat-value">
                                    Show compose source
                                </summary>
                                <pre className="mt-2 font-mono text-[11px] text-stat-value overflow-x-auto whitespace-pre-wrap">
                                    {blueprint.compose_content}
                                </pre>
                            </details>
                        </SheetSection>
                    </>
                )}
            </SystemSheet>

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
        </>
    );
}

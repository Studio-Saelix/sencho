import { useEffect, useRef, useState, useCallback } from 'react';
import { openGitOpsWorkplace } from '@/components/gitops/portfolio/portfolioNavigation';
import { Pencil, Pin, Play, Power, Trash2, GitBranch, Unlink, CornerDownLeft } from 'lucide-react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { GitOpsStatus } from '@/components/gitops/GitOpsStatus';
import GitOpsAuthorityActions from '@/components/gitops/GitOpsAuthorityActions';
import GitOpsRolloutControls from '@/components/gitops/GitOpsRolloutControls';
import { blueprintApplicationId } from '@/lib/gitopsAuthorityApi';
import { absentFault, liveCaveats, livePlacementFacet, liveRolloutFacet } from '@/lib/gitopsState';
import { ConfirmModal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import {
    type BlueprintSummary,
    type CreateBlueprintInput,
    type UpdateBlueprintInput,
    type WithdrawConfirm,
    type AcceptMode,
    getBlueprint,
    updateBlueprint,
    deleteBlueprint,
    withdrawDeployment,
    acceptDeployment,
    pinBlueprint,
    describeSelector,
} from '@/lib/blueprintsApi';
import { BlueprintEditor, type BlueprintSubmitOptions } from './BlueprintEditor';
import { BlueprintStatus } from './BlueprintStatus';
import { BlueprintDeploymentTable } from './BlueprintDeploymentTable';
import { EvictionDialog } from './EvictionDialog';
import { StateReviewDialog } from './StateReviewDialog';
import { RolloutPreviewDialog } from './RolloutPreviewDialog';
import { ConvertBlueprintDialog } from './ConvertBlueprintDialog';
import { DetachBlueprintDialog } from './DetachBlueprintDialog';
import { RetireBlueprintDialog } from './RetireBlueprintDialog';
import { ContentOriginBadge } from './ContentOriginBadge';
import { useNodes } from '@/context/NodeContext';
import { formatTimeAgo } from '@/lib/relativeTime';
import { type NodeLabelMap, describeStagedWrite, writeStagedLabels } from '@/lib/blueprintTargets';
import type { PermissionAction } from '@/context/AuthContext';

type PermissionResolver = (action: PermissionAction, resourceType?: string, resourceId?: string, nodeId?: number | null) => boolean;

interface BlueprintDetailProps {
    blueprintId: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
    canEdit: boolean;
    can?: PermissionResolver;
    nodeLabels: NodeLabelMap;
    /** Open the rollout preview as soon as the Blueprint loads (set after Review rollout). */
    reviewOnOpen?: boolean;
}

export function BlueprintDetail({ blueprintId, open, onOpenChange, onChanged, canEdit, can, nodeLabels, reviewOnOpen = false }: BlueprintDetailProps) {
    const [summary, setSummary] = useState<BlueprintSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [busyNodeId, setBusyNodeId] = useState<number | null>(null);
    const [evictTarget, setEvictTarget] = useState<{ nodeId: number; nodeName: string } | null>(null);
    const [stateReviewTarget, setStateReviewTarget] = useState<{ nodeId: number; nodeName: string } | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const [previewOpen, setPreviewOpen] = useState(false);
    const [convertOpen, setConvertOpen] = useState(false);
    const [detachOpen, setDetachOpen] = useState(false);
    const [retireOpen, setRetireOpen] = useState(false);
    const [unpinning, setUnpinning] = useState(false);
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

    // Review rollout lands here straight from the create form: once the Blueprint
    // has loaded, show the plan without another click. Fires once per mount.
    const autoPreviewed = useRef(false);
    useEffect(() => {
        if (reviewOnOpen && summary && !autoPreviewed.current) {
            autoPreviewed.current = true;
            setPreviewOpen(true);
        }
    }, [reviewOnOpen, summary]);

    if (!open) return null;

    const blueprint = summary?.blueprint;
    // A Blueprint with no live application row is a fact nothing else in the
    // product can express. Everything else a Blueprint projection carries is
    // rollout surface, which is not this sheet's job.
    const gitopsFaults = summary ? absentFault(summary.gitopsRevision) : [];
    // Caveats qualify this Blueprint (reapproval, Git-managed rollout), not a node rollout.
    const gitopsCaveats = summary ? liveCaveats(summary.gitopsRevision) : [];
    const gitopsPlacement = livePlacementFacet(summary?.gitopsRevision ?? null);
    const gitopsRollout = liveRolloutFacet(summary?.gitopsRevision ?? null);
    const showGitops = gitopsFaults.length > 0 || gitopsCaveats.length > 0
        || gitopsPlacement !== null || gitopsRollout !== null
        || (summary != null && summary.gitopsRevision.targetMode !== 'not_applicable'
            && summary.gitopsRevision.approvals !== null);
    const gitManaged = blueprint?.content_origin === 'git';
    const hasActiveDeployments = summary?.deployments.some(
        (dep) => dep.status !== 'withdrawn',
    ) ?? false;
    const canApply = !!blueprint && !gitManaged && (can ? can('stack:create') && can('stack:deploy') : canEdit);
    const canManagePin = can ? can('node:manage') : canEdit;
    const canDeleteBlueprint = !!blueprint && !gitManaged && (can ? can('stack:delete') : canEdit);
    const canDeployOnNode = (nodeId: number) => !!blueprint
        && !gitManaged
        && (can ? can('stack:deploy', 'stack', blueprint.name, nodeId) : canEdit);
    const canWithdrawFromNode = (nodeId: number) => !!blueprint
        && (can ? can('stack:delete', 'stack', blueprint.name, nodeId) : canEdit);

    async function handleRolloutApplied() {
        await refresh();
        onChanged();
    }

    function handleBindingChanged() {
        void refresh();
        onChanged();
    }

    async function handleSaveEdit(input: CreateBlueprintInput | UpdateBlueprintInput, options: BlueprintSubmitOptions) {
        if (!blueprint) return;
        setSubmitting(true);
        try {
            await updateBlueprint(blueprint.id, input as UpdateBlueprintInput);
            toast.success('Blueprint saved');
            const notice = describeStagedWrite(await writeStagedLabels(options.staged, blueprint.id));
            if (notice) toast[notice.tone](notice.message);
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
            const status = (err as Error & { status?: number }).status;
            const message = err instanceof Error ? err.message : 'Failed to withdraw';
            if (status === 409 && /approval|removal|stale/i.test(message)) {
                toast.error('Confirm a remove rollout for this node before destructive eviction.');
            } else {
                toast.error(message);
            }
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
     * Row-level re-apply isn't a backend primitive: the reconciler operates on the whole
     * blueprint, not a single deployment. We surface the row's "Re-apply" button and
     * open the rollout preview so the operator confirms the full plan.
     * The nodeId argument satisfies BlueprintDeploymentTable.onRetry's signature.
     */
    async function handleRetryRow(nodeId: number): Promise<void> {
        void nodeId;
        setPreviewOpen(true);
    }

    // A node missing from the list (removed, or not yet loaded) still has a deployment
    // row, so the dialogs open under a generic name instead of the button doing nothing.
    const nodeLabel = (nodeId: number) => nodes.find(n => n.id === nodeId)?.name ?? `node ${nodeId}`;

    function openWithdraw(nodeId: number) {
        setEvictTarget({ nodeId, nodeName: nodeLabel(nodeId) });
    }

    function openAcceptStateReview(nodeId: number) {
        setStateReviewTarget({ nodeId, nodeName: nodeLabel(nodeId) });
    }

    async function handleUnpin() {
        if (!blueprint) return;
        setUnpinning(true);
        try {
            await pinBlueprint(blueprint.id, null);
            toast.success('Blueprint unpinned. Review the rollout to apply the selector.');
            await refresh();
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to unpin blueprint');
        } finally {
            setUnpinning(false);
        }
    }

    const meta = blueprint
        ? `${describeSelector(blueprint.selector)} · ${blueprint.drift_mode} · rev ${blueprint.revision}`
        : (loading ? 'Loading…' : '');

    // An Inline Blueprint states approval and the reconciler switch once, in the status
    // above the table; a Git-managed one has no such status, so its footer keeps them.
    const approvalLabel = summary?.effectiveApproval === 'reapproval_required'
        ? 'reapproval required'
        : summary?.effectiveApproval ?? 'pending';
    const gitFooter = blueprint && gitManaged
        ? `${blueprint.enabled ? '' : ' · reconciler disabled'} · ${approvalLabel}`
        : '';
    const footerContext = blueprint ? `Updated ${formatTimeAgo(blueprint.updated_at)}${gitFooter}` : undefined;

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
                primaryAction={canApply ? {
                    label: 'Apply now',
                    icon: Play,
                    onClick: () => setPreviewOpen(true),
                    disabled: submitting || !blueprint.enabled || editMode,
                } : undefined}
                secondaryActions={secondaryActions}
                destructiveAction={canDeleteBlueprint ? {
                    label: 'Delete',
                    icon: Trash2,
                    onClick: () => setDeleteOpen(true),
                    disabled: submitting || editMode,
                } : undefined}
                footerContext={footerContext}
                size="lg"
                constrainBodyWidth
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
                            nodeLabels={nodeLabels}
                            onCancel={() => setEditMode(false)}
                            onSubmit={handleSaveEdit}
                            submitting={submitting}
                        />
                    </SheetSection>
                ) : (
                    <>
                        {(!gitManaged || showGitops) && (
                            <SheetSection title={gitManaged ? 'GitOps' : 'Status'} hideHeader={!gitManaged}>
                                <div className="space-y-2">
                                    {gitManaged ? (
                                        <GitOpsStatus
                                            revision={summary.gitopsRevision}
                                            includeTargets={false}
                                        />
                                    ) : (
                                        <BlueprintStatus
                                            summary={summary}
                                            nodeName={nodeLabel}
                                            busy={submitting || unpinning || busyNodeId !== null}
                                            handlers={{
                                                reapply: canApply ? () => setPreviewOpen(true) : undefined,
                                                enable: canEdit ? () => void handleToggleEnabled() : undefined,
                                                reviewState: openAcceptStateReview,
                                                evict: openWithdraw,
                                                canDeployOnNode,
                                                canWithdrawFromNode,
                                            }}
                                        />
                                    )}
                                    {showGitops && (
                                        <>
                                            <GitOpsAuthorityActions
                                                applicationId={blueprintApplicationId(blueprint.id)}
                                                blueprintId={blueprint.id}
                                                blueprintName={blueprint.name}
                                                projection={summary.gitopsRevision}
                                                onChanged={handleRolloutApplied}
                                                can={can}
                                                blueprintEnabled={blueprint.enabled}
                                            />
                                            <GitOpsRolloutControls
                                                applicationId={blueprintApplicationId(blueprint.id)}
                                                projection={summary.gitopsRevision}
                                                onChanged={handleRolloutApplied}
                                                can={can}
                                                blueprintEnabled={blueprint.enabled}
                                                rollbackGenerations={summary.rollbackCandidates}
                                            />
                                            {/* This Blueprint's application in the portfolio, beside
                                                every other GitOps application and the attention queue. */}
                                            <Button
                                                variant="link"
                                                size="sm"
                                                className="h-auto p-0 text-xs"
                                                onClick={() => {
                                                    onOpenChange(false);
                                                    openGitOpsWorkplace({ blueprintId: blueprint.id });
                                                }}
                                            >
                                                Open in GitOps portfolio
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </SheetSection>
                        )}

                        <SheetSection title="Content" hideHeader>
                            <div className="flex flex-wrap items-center gap-2">
                                <ContentOriginBadge origin={blueprint.content_origin} />
                                {canEdit && (gitManaged ? (
                                    <>
                                        <Button variant="outline" size="sm" className="gap-1.5" disabled={submitting} onClick={() => setDetachOpen(true)}>
                                            <Unlink className="h-3.5 w-3.5" strokeWidth={1.5} />
                                            Detach Git
                                        </Button>
                                        {!hasActiveDeployments && (
                                            <Button variant="outline" size="sm" className="gap-1.5" disabled={submitting} onClick={() => setRetireOpen(true)}>
                                                <CornerDownLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
                                                Retire to Direct
                                            </Button>
                                        )}
                                    </>
                                ) : (
                                    <Button variant="outline" size="sm" className="gap-1.5" disabled={submitting} onClick={() => setConvertOpen(true)}>
                                        <GitBranch className="h-3.5 w-3.5" strokeWidth={1.5} />
                                        Convert to Git
                                    </Button>
                                ))}
                            </div>
                        </SheetSection>

                        {blueprint.pinned_node_id !== null && (
                            <SheetSection title="Pin" hideHeader>
                                <div className="flex items-start gap-2 rounded-md border border-card-border bg-glass-highlight px-3 py-2">
                                    <Pin className="w-3.5 h-3.5 mt-0.5 text-foreground shrink-0" />
                                    <div className="min-w-0 flex-1 text-xs text-stat-value">
                                        <span className="font-medium">Pinned to {nodes.find(n => n.id === blueprint.pinned_node_id)?.name ?? `node ${blueprint.pinned_node_id}`}.</span>{' '}
                                        <span className="text-stat-subtitle">The selector is overridden while it is pinned.</span>
                                    </div>
                                    {canManagePin && (
                                        <BusyButton variant="outline" size="sm" pending={unpinning} busyLabel="Unpinning…" onClick={() => void handleUnpin()}>
                                            Unpin
                                        </BusyButton>
                                    )}
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
                                canDeploy={canDeployOnNode}
                                canWithdraw={canWithdrawFromNode}
                                canRetry={canApply && blueprint.enabled}
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
                    <RolloutPreviewDialog
                        blueprintId={blueprint.id}
                        blueprintName={blueprint.name}
                        open={previewOpen}
                        onOpenChange={setPreviewOpen}
                        onApplied={handleRolloutApplied}
                    />
                )}
                {blueprint && (
                    <>
                        <ConvertBlueprintDialog
                            open={convertOpen}
                            onOpenChange={setConvertOpen}
                            blueprintId={blueprint.id}
                            onConverted={handleBindingChanged}
                        />
                        <DetachBlueprintDialog
                            open={detachOpen}
                            onOpenChange={setDetachOpen}
                            blueprintId={blueprint.id}
                            onDetached={handleBindingChanged}
                        />
                        <RetireBlueprintDialog
                            open={retireOpen}
                            onOpenChange={setRetireOpen}
                            blueprintId={blueprint.id}
                            onRetired={handleBindingChanged}
                        />
                    </>
                )}
                {blueprint && (
                    <ConfirmModal
                        open={deleteOpen}
                        onOpenChange={(o) => { if (!o) { setDeleteOpen(false); setDeleteConfirmText(''); } }}
                        variant="destructive"
                        size="md"
                        kicker="BLUEPRINT · DELETE · IRREVERSIBLE"
                        title={`Delete ${blueprint.name}`}
                        confirmLabel="Delete blueprint"
                        busyConfirmLabel="Deleting…"
                        confirming={submitting}
                        confirmDisabled={!deleteTypedOk}
                        onConfirm={performDelete}
                    >
                        <p className="text-sm text-stat-subtitle">
                            Stateless and not-yet-deployed deployments are withdrawn for you. A stateful deployment that is live on a node must be withdrawn from the deployment table first, so you choose whether to snapshot or destroy its data.
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
                    </ConfirmModal>
                )}
        </>
    );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, ModalHeader } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import { toast } from '@/components/ui/toast-store';
import {
    type BlueprintListItem,
    type BlueprintMutationResult,
    type CreateBlueprintInput,
    type UpdateBlueprintInput,
    listBlueprints,
    createBlueprint,
    listAllNodeLabels,
} from '@/lib/blueprintsApi';
import { type NodeLabelMap, describeStagedWrite, writeStagedLabels } from '@/lib/blueprintTargets';
import { BlueprintCatalog } from './BlueprintCatalog';
import { BlueprintEmptyState } from './BlueprintEmptyState';
import { FleetEmptyState } from '../fleet/FleetEmptyState';
import { BlueprintDetail } from './BlueprintDetail';
import { BlueprintEditor, type BlueprintSubmitOptions } from './BlueprintEditor';
import { useAuth } from '@/context/AuthContext';
import {
    BLUEPRINT_INTENT_EVENT,
    clearBlueprintIntent,
    peekBlueprintIntent,
    type BlueprintIntent,
} from '@/lib/blueprintIntent';

/** The catalog's grid and roughly its tile height (keep in step with BlueprintTile), so the page barely shifts when it resolves. */
function CatalogSkeleton() {
    return (
        <div className="space-y-5" role="status" aria-busy aria-label="Loading blueprints" data-testid="catalog-skeleton">
            <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-8 w-32" />
            </div>
            <div className="flex gap-1">
                {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-6 w-20" />)}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {[0, 1, 2].map(i => <Skeleton key={i} className="h-[106px] rounded-lg" />)}
            </div>
        </div>
    );
}

export function DeploymentsTab() {
    const { can } = useAuth();
    const canCreate = can('stack:create');
    const canEdit = can('stack:edit');
    const canReview = canCreate && can('stack:deploy');
    const [blueprints, setBlueprints] = useState<BlueprintListItem[]>([]);
    const [nodeLabels, setNodeLabels] = useState<NodeLabelMap>({});
    // The Blueprint just created through Review rollout; its sheet opens on the preview.
    const [reviewId, setReviewId] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    // Another surface (the GitOps workplace) may have asked for one Blueprint
    // or the create dialog; a tab mounting because of it starts there.
    const [initialIntent] = useState(peekBlueprintIntent);
    const [selectedId, setSelectedId] = useState<number | null>(
        initialIntent?.kind === 'open' ? initialIntent.blueprintId : null,
    );
    const [createOpen, setCreateOpen] = useState(initialIntent?.kind === 'create' && canCreate);
    const [submitting, setSubmitting] = useState(false);

    // A tab already mounted hears the intent instead.
    useEffect(() => {
        clearBlueprintIntent();
        const onIntent = (e: Event) => {
            clearBlueprintIntent();
            const intent = (e as CustomEvent<BlueprintIntent>).detail;
            if (intent.kind === 'open') setSelectedId(intent.blueprintId);
            else if (canCreate) setCreateOpen(true);
        };
        window.addEventListener(BLUEPRINT_INTENT_EVENT, onIntent);
        return () => window.removeEventListener(BLUEPRINT_INTENT_EVENT, onIntent);
    }, [canCreate]);

    // Only the first load blanks the tab; a refetch keeps what is on screen, so an
    // open sheet and the catalog never flash empty while a change is picked up.
    // Overlapping refetches are sequenced so an older answer never lands over a newer one.
    const latestRefresh = useRef(0);
    const hasCatalog = useRef(false);
    const refresh = useCallback(async (): Promise<boolean> => {
        const id = ++latestRefresh.current;
        try {
            const [list, labels] = await Promise.all([
                listBlueprints(),
                listAllNodeLabels().catch((err: unknown) => {
                    console.error('[Blueprints] node label fetch failed:', err);
                    return null;
                }),
            ]);
            if (id !== latestRefresh.current) return true;
            setBlueprints(list);
            hasCatalog.current = list.length > 0;
            if (labels) setNodeLabels(labels);
            setLoadError(null);
            return true;
        } catch (err) {
            if (id !== latestRefresh.current) return false;
            const message = err instanceof Error ? err.message : 'Failed to load blueprints';
            setLoadError(message);
            // With nothing on screen the error card says it; with a catalog on screen the toast and the notice do.
            if (hasCatalog.current) toast.error(message);
            return false;
        } finally {
            if (id === latestRefresh.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    function retry() {
        if (!hasCatalog.current) setLoading(true);
        void refresh();
    }

    // The skeleton waits out the busy delay, so a fast first load shows a blank placeholder instead of a flash.
    const { showBusy: showSkeleton } = useVisualBusy(loading);

    async function handleCreate(input: CreateBlueprintInput | UpdateBlueprintInput, options: BlueprintSubmitOptions) {
        setSubmitting(true);
        let created: BlueprintMutationResult;
        try {
            created = await createBlueprint(input as CreateBlueprintInput);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create blueprint');
            setSubmitting(false);
            return;
        }
        try {
            toast.success('Blueprint created');
            const written = await writeStagedLabels(options.staged, created.id);
            const notice = describeStagedWrite(written);
            if (notice) toast[notice.tone](notice.message);
            setCreateOpen(false);
            // Without the refreshed list there is no catalog to open the new Blueprint from;
            // the error card or notice says so, and Retry should not pop a sheet open later.
            if (!(await refresh())) return;
            // A plan built on fewer labels than the operator staged is not the plan
            // they reviewed, so a failed label write opens the sheet without it.
            setReviewId(options.intent === 'review' && written.failed.length === 0 ? created.id : null);
            setSelectedId(created.id);
        } finally {
            setSubmitting(false);
        }
    }

    if (loading) {
        return showSkeleton ? <CatalogSkeleton /> : <div className="min-h-[40vh]" role="status" aria-busy aria-label="Loading blueprints" />;
    }

    // A failed refetch with a catalog on screen only toasts; the error card is for a tab with nothing to show.
    if (loadError && blueprints.length === 0) {
        return (
            <div className="mx-auto max-w-2xl rounded-xl border border-destructive/30 bg-destructive/5 p-6 space-y-3" role="alert">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">
                    Could not load blueprints
                </div>
                <p className="text-sm text-stat-subtitle leading-relaxed">{loadError}</p>
                <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            {loadError && (
                <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                    <p className="text-xs text-stat-subtitle">Could not refresh ({loadError}). Showing the last list.</p>
                    <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
                </div>
            )}
            {blueprints.length === 0 ? (
                <FleetEmptyState>
                    <BlueprintEmptyState onCreate={() => setCreateOpen(true)} canCreate={canCreate} />
                </FleetEmptyState>
            ) : (
                <BlueprintCatalog
                    blueprints={blueprints}
                    onSelect={setSelectedId}
                    onCreate={() => setCreateOpen(true)}
                    canCreate={canCreate}
                />
            )}

            {selectedId !== null && (
                <BlueprintDetail
                    blueprintId={selectedId}
                    open={selectedId !== null}
                    onOpenChange={(o) => { if (!o) { setSelectedId(null); setReviewId(null); } }}
                    onChanged={refresh}
                    canEdit={canEdit}
                    can={can}
                    nodeLabels={nodeLabels}
                    reviewOnOpen={reviewId === selectedId}
                />
            )}

            <Modal open={createOpen} onOpenChange={setCreateOpen} className="flex max-h-[85dvh] max-w-3xl flex-col">
                <ModalHeader
                    kicker="BLUEPRINTS · NEW"
                    title="Declare a fleet-wide compose template"
                    description="Create a blueprint that can be deployed across the fleet."
                />
                <BlueprintEditor
                    mode="create"
                    nodeLabels={nodeLabels}
                    canReview={canReview}
                    onCancel={() => setCreateOpen(false)}
                    onSubmit={handleCreate}
                    submitting={submitting}
                />
            </Modal>
        </div>
    );
}

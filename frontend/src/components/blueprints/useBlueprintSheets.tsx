import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, ModalHeader } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import {
    type BlueprintMutationResult,
    type CreateBlueprintInput,
    type UpdateBlueprintInput,
    createBlueprint,
    listAllNodeLabels,
} from '@/lib/blueprintsApi';
import { type NodeLabelMap, describeStagedWrite, writeStagedLabels } from '@/lib/blueprintTargets';
import type { BlueprintIntent } from '@/lib/blueprintIntent';
import { BlueprintDetail } from './BlueprintDetail';
import { BlueprintEditor, type BlueprintSubmitOptions } from './BlueprintEditor';

interface UseBlueprintSheetsOptions {
    /**
     * Called after anything changed (a Blueprint saved, deleted, applied or created) so the
     * surface hosting the sheets can refresh what it shows. Resolves false when that failed,
     * so a freshly created Blueprint is not opened over a list that cannot show it; a host
     * with nothing to reread resolves true.
     */
    onChanged: () => Promise<boolean> | boolean;
    /** A request another surface made before this one mounted. */
    initialIntent?: BlueprintIntent | null;
    /** False where the sheets already sit over the GitOps workplace, so a link back to it would go nowhere. */
    showPortfolioLink?: boolean;
}

/**
 * The Blueprint detail sheet and the create dialog, with the one set of handlers
 * behind them. The Blueprints tab and the GitOps workplace both host them, so a
 * Blueprint opens the same way, with the same permissions and the same create
 * flow, wherever the operator already is.
 */
export function useBlueprintSheets({ onChanged, initialIntent = null, showPortfolioLink = true }: UseBlueprintSheetsOptions): {
    openBlueprint: (blueprintId: number) => void;
    openCreate: () => void;
    canCreate: boolean;
    sheets: ReactNode;
} {
    const { can } = useAuth();
    const canCreate = can('stack:create');
    const canEdit = can('stack:edit');
    const canReview = canCreate && can('stack:deploy');
    const [nodeLabels, setNodeLabels] = useState<NodeLabelMap>({});
    const [selectedId, setSelectedId] = useState<number | null>(
        initialIntent?.kind === 'open' ? initialIntent.blueprintId : null,
    );
    const [createOpen, setCreateOpen] = useState(initialIntent?.kind === 'create' && canCreate);
    // The Blueprint just created through Review rollout; its sheet opens on the preview.
    const [reviewId, setReviewId] = useState<number | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Overlapping reads (opening a sheet, then a change) are sequenced so an older map never
    // lands over a newer one.
    const latestLabels = useRef(0);
    const loadLabels = useCallback(async () => {
        const id = ++latestLabels.current;
        try {
            const labels = await listAllNodeLabels();
            if (id === latestLabels.current) setNodeLabels(labels);
        } catch (err) {
            console.error('[Blueprints] node label fetch failed:', err);
            // Without the map a label selector reads as matching nothing, so say why.
            if (id === latestLabels.current) toast.error('Could not load node labels. Label targets may show as empty.');
        }
    }, []);

    // The labels are only read by the sheets, so they load when one opens.
    const anyOpen = selectedId !== null || createOpen;
    useEffect(() => {
        if (anyOpen) void loadLabels();
    }, [anyOpen, loadLabels]);

    const openCreate = useCallback(() => {
        if (canCreate) setCreateOpen(true);
    }, [canCreate]);

    async function handleChanged(): Promise<boolean> {
        let ok = false;
        try {
            ok = await onChanged();
        } catch (err) {
            console.error('[Blueprints] refresh after a change failed:', err);
        }
        await loadLabels();
        return ok;
    }

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
            // Without the refreshed list there is nothing to open the new Blueprint from; the
            // host says so, and a later retry should not pop a sheet open.
            if (!(await handleChanged())) return;
            // A plan built on fewer labels than the operator staged is not the plan
            // they reviewed, so a failed label write opens the sheet without it.
            setReviewId(options.intent === 'review' && written.failed.length === 0 ? created.id : null);
            setSelectedId(created.id);
        } finally {
            setSubmitting(false);
        }
    }

    const sheets = (
        <>
            {selectedId !== null && (
                <BlueprintDetail
                    blueprintId={selectedId}
                    open
                    onOpenChange={(o) => { if (!o) { setSelectedId(null); setReviewId(null); } }}
                    onChanged={() => void handleChanged()}
                    canEdit={canEdit}
                    can={can}
                    nodeLabels={nodeLabels}
                    reviewOnOpen={reviewId === selectedId}
                    showPortfolioLink={showPortfolioLink}
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
        </>
    );

    return {
        openBlueprint: setSelectedId,
        openCreate,
        canCreate,
        sheets,
    };
}

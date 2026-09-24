import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Modal, ModalHeader, ModalBody } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import {
    type BlueprintListItem,
    type CreateBlueprintInput,
    type UpdateBlueprintInput,
    listBlueprints,
    createBlueprint,
    listDistinctLabels,
} from '@/lib/blueprintsApi';
import { BlueprintCatalog } from './BlueprintCatalog';
import { BlueprintEmptyState } from './BlueprintEmptyState';
import { FleetTabHeading, FleetEmptyState } from '../fleet/FleetEmptyState';
import { BlueprintDetail } from './BlueprintDetail';
import { BlueprintEditor } from './BlueprintEditor';
import { useAuth } from '@/context/AuthContext';
import {
    BLUEPRINT_INTENT_EVENT,
    clearBlueprintIntent,
    peekBlueprintIntent,
    type BlueprintIntent,
} from '@/lib/blueprintIntent';

export function DeploymentsTab() {
    const { can } = useAuth();
    const canCreate = can('stack:create');
    const canEdit = can('stack:edit');
    const [blueprints, setBlueprints] = useState<BlueprintListItem[]>([]);
    const [distinctLabels, setDistinctLabels] = useState<string[]>([]);
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

    const refresh = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const [list, labels] = await Promise.all([
                listBlueprints(),
                listDistinctLabels().catch(() => [] as string[]),
            ]);
            setBlueprints(list);
            setDistinctLabels(labels);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load blueprints';
            setLoadError(message);
            toast.error(message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    async function handleCreate(input: CreateBlueprintInput | UpdateBlueprintInput) {
        setSubmitting(true);
        try {
            const created = await createBlueprint(input as CreateBlueprintInput);
            toast.success('Blueprint created');
            setCreateOpen(false);
            await refresh();
            setSelectedId(created.id);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create blueprint');
        } finally {
            setSubmitting(false);
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20 text-xs text-stat-subtitle font-mono uppercase tracking-[0.18em]">
                Loading blueprints…
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="mx-auto max-w-2xl rounded-xl border border-destructive/30 bg-destructive/5 p-6 space-y-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">
                    Could not load blueprints
                </div>
                <p className="text-sm text-stat-subtitle leading-relaxed">{loadError}</p>
                <button
                    type="button"
                    onClick={() => void refresh()}
                    className="inline-flex items-center gap-2 rounded border border-card-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] hover:border-t-card-border-hover cursor-pointer"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            {blueprints.length === 0 ? (
                <>
                    <FleetTabHeading
                        title="Blueprints"
                        subtitle="Declare compose templates once and keep matching nodes in sync."
                        action={canCreate ? (
                            <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
                                <Plus className="w-4 h-4" strokeWidth={1.5} />
                                New Blueprint
                            </Button>
                        ) : undefined}
                    />
                    <FleetEmptyState>
                        <BlueprintEmptyState onCreate={() => setCreateOpen(true)} canCreate={canCreate} />
                    </FleetEmptyState>
                </>
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
                    onOpenChange={(o) => { if (!o) setSelectedId(null); }}
                    onChanged={refresh}
                    canEdit={canEdit}
                    can={can}
                    distinctLabels={distinctLabels}
                />
            )}

            <Modal open={createOpen} onOpenChange={setCreateOpen} className="max-w-3xl max-h-[85vh] overflow-y-auto">
                <ModalHeader
                    kicker="BLUEPRINTS · NEW"
                    title="Declare a fleet-wide compose template"
                    description="Create a blueprint that can be deployed across the fleet."
                />
                <ModalBody>
                    <BlueprintEditor
                        mode="create"
                        distinctLabels={distinctLabels}
                        onCancel={() => setCreateOpen(false)}
                        onSubmit={handleCreate}
                        submitting={submitting}
                    />
                </ModalBody>
            </Modal>
        </div>
    );
}

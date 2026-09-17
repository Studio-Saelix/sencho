import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import {
    adoptBlueprintFromStack,
    listBlueprints,
    previewAdoptBlueprint,
    type BindingPreview,
    type BlueprintListItem,
} from '@/lib/blueprintsApi';

interface AdoptBlueprintDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    stackName: string;
    onAdopted: () => void;
}

export function AdoptBlueprintDialog({
    open, onOpenChange, stackName, onAdopted,
}: AdoptBlueprintDialogProps) {
    const [blueprints, setBlueprints] = useState<BlueprintListItem[]>([]);
    const [blueprintId, setBlueprintId] = useState<number | null>(null);
    const [preview, setPreview] = useState<BindingPreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [busy, setBusy] = useState(false);
    const previewSeq = useRef(0);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setPreview(null);
        setBlueprintId(null);
        setBlueprints([]);
        setLoadError(false);
        setLoading(true);
        void listBlueprints()
            .then((rows) => {
                if (!cancelled) setBlueprints(rows.filter((row) => row.content_origin === 'inline'));
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setLoadError(true);
                toast.error(err instanceof Error ? err.message : 'Failed to load Blueprints');
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open]);

    async function loadPreview(nextId: number | null) {
        const seq = ++previewSeq.current;
        setBlueprintId(nextId);
        setPreview(null);
        if (nextId == null) return;
        try {
            const next = await previewAdoptBlueprint(stackName, nextId);
            if (previewSeq.current === seq) setPreview(next);
        } catch (err) {
            if (previewSeq.current !== seq) return;
            toast.error(err instanceof Error ? err.message : 'Failed to preview adoption');
        }
    }

    async function confirm() {
        if (blueprintId == null || !preview) return;
        setBusy(true);
        try {
            await adoptBlueprintFromStack(stackName, blueprintId);
            toast.success('Git source adopted onto the Blueprint');
            onAdopted();
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to adopt this Git source onto a Blueprint');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open={open} onOpenChange={onOpenChange} size="lg">
            <ModalHeader
                kicker="GIT · ADOPT"
                title={`Adopt ${stackName} onto a Blueprint`}
                description="Move this live Git source onto a Blueprint. Credentials stay with the source."
            />
            <ModalBody>
                {loading ? (
                    <div className="flex items-center gap-2 text-sm text-stat-subtitle">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                        Loading Blueprints…
                    </div>
                ) : loadError ? (
                    <p className="text-sm text-stat-subtitle">Could not load Blueprints.</p>
                ) : blueprints.length === 0 ? (
                    <p className="text-sm text-stat-subtitle">No Inline Blueprints are available to adopt onto.</p>
                ) : (
                    <div className="space-y-3">
                        <label className="block space-y-1.5">
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Blueprint</span>
                            <select
                                className="w-full rounded-md border border-card-border bg-card px-2 py-1.5 text-sm"
                                value={blueprintId == null ? '' : String(blueprintId)}
                                onChange={(event) => {
                                    const raw = event.target.value;
                                    void loadPreview(raw === '' ? null : Number(raw));
                                }}
                            >
                                <option value="">Select a Blueprint</option>
                                {blueprints.map((blueprint) => (
                                    <option key={blueprint.id} value={blueprint.id}>{blueprint.name}</option>
                                ))}
                            </select>
                        </label>
                        {preview && (
                            <div className="space-y-2 rounded-lg border border-card-border bg-card p-3 max-md:space-y-3">
                                {preview.rollbackLimitations.map((item) => (
                                    <p key={item} className="text-xs text-stat-subtitle leading-relaxed">{item}</p>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </ModalBody>
            <ModalFooter
                primary={
                    <Button size="sm" onClick={() => { void confirm(); }} disabled={busy || !preview}>
                        {busy ? 'Adopting…' : 'Adopt'}
                    </Button>
                }
                secondary={
                    <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                        Cancel
                    </Button>
                }
            />
        </Modal>
    );
}

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import {
    convertContentBinding,
    listDirectGitSourceOptions,
    previewConvertContentBinding,
    type BindingPreview,
    type DirectGitSourceOption,
} from '@/lib/blueprintsApi';

interface ConvertBlueprintDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    blueprintId: number;
    onConverted: () => void;
}

export function ConvertBlueprintDialog({
    open, onOpenChange, blueprintId, onConverted,
}: ConvertBlueprintDialogProps) {
    const [options, setOptions] = useState<DirectGitSourceOption[]>([]);
    const [applicationId, setApplicationId] = useState<string>('');
    const [preview, setPreview] = useState<BindingPreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [busy, setBusy] = useState(false);
    const previewSeq = useRef(0);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setPreview(null);
        setApplicationId('');
        setOptions([]);
        setLoadError(false);
        setLoading(true);
        void listDirectGitSourceOptions()
            .then((next) => {
                if (!cancelled) setOptions(next);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setLoadError(true);
                toast.error(err instanceof Error ? err.message : 'Failed to load Git sources');
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open]);

    async function loadPreview(nextId: string) {
        const seq = ++previewSeq.current;
        setApplicationId(nextId);
        setPreview(null);
        if (!nextId) return;
        try {
            const next = await previewConvertContentBinding(blueprintId, nextId);
            if (previewSeq.current === seq) setPreview(next);
        } catch (err) {
            if (previewSeq.current !== seq) return;
            toast.error(err instanceof Error ? err.message : 'Failed to preview conversion');
        }
    }

    async function confirm() {
        if (!applicationId || !preview || preview.application.id !== applicationId) return;
        setBusy(true);
        try {
            await convertContentBinding(blueprintId, applicationId);
            toast.success('Blueprint content is now Git-managed');
            onConverted();
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to convert this Blueprint to Git-managed content');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open={open} onOpenChange={onOpenChange} size="lg">
            <ModalHeader
                kicker="BLUEPRINT · CONVERT"
                title="Convert to Git-managed content"
                description="Move a live Git source onto this Blueprint. Credentials stay with that source."
            />
            <ModalBody>
                {loading ? (
                    <div className="flex items-center gap-2 text-sm text-stat-subtitle">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                        Loading Git sources…
                    </div>
                ) : loadError ? (
                    <p className="text-sm text-stat-subtitle">Could not load Git sources.</p>
                ) : options.length === 0 ? (
                    <p className="text-sm text-stat-subtitle">No live Git sources are available to convert.</p>
                ) : (
                    <div className="space-y-3">
                        <label className="block space-y-1.5">
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Live Git source</span>
                            <select
                                className="w-full rounded-md border border-card-border bg-card px-2 py-1.5 text-sm"
                                value={applicationId}
                                onChange={(event) => { void loadPreview(event.target.value); }}
                            >
                                <option value="">Select a source</option>
                                {options.map((option) => (
                                    <option key={option.applicationId} value={option.applicationId}>
                                        {option.stackName} · {option.repoUrl}@{option.ref}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {preview && (
                            <div className="space-y-2 rounded-lg border border-card-border bg-card p-3 max-md:space-y-3">
                                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Preview</p>
                                <p className="text-xs text-stat-subtitle">
                                    {preview.application.repoUrl ?? 'repository unknown'} · {preview.application.ref ?? 'ref unknown'}
                                </p>
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
                        {busy ? 'Converting…' : 'Convert'}
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

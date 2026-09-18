import { useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { detachContentBinding, previewDetachContentBinding } from '@/lib/blueprintsApi';
import { BindingPreviewDialogBody } from './BindingPreviewDialogBody';
import { useBindingPreview } from './useBindingPreview';

interface DetachBlueprintDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    blueprintId: number;
    onDetached: () => void;
}

export function DetachBlueprintDialog({
    open, onOpenChange, blueprintId, onDetached,
}: DetachBlueprintDialogProps) {
    const { preview, loading, loadError } = useBindingPreview(
        open,
        blueprintId,
        previewDetachContentBinding,
        'Failed to preview detach',
    );
    const [busy, setBusy] = useState(false);

    async function confirm() {
        if (!preview) return;
        setBusy(true);
        try {
            await detachContentBinding(blueprintId);
            toast.success('Blueprint content is Inline again');
            onDetached();
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to detach Git-managed content');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open={open} onOpenChange={onOpenChange} size="lg">
            <ModalHeader
                kicker="BLUEPRINT · DETACH"
                title="Detach Git-managed content"
                description="Restore the frozen Inline snapshot. Later Git commits are not written back."
            />
            <ModalBody>
                <BindingPreviewDialogBody
                    loading={loading}
                    loadError={loadError}
                    preview={preview}
                    loadErrorMessage="Could not load the detach preview."
                />
            </ModalBody>
            <ModalFooter
                primary={
                    <Button size="sm" onClick={() => { void confirm(); }} disabled={busy || !preview}>
                        {busy ? 'Detaching…' : 'Detach'}
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

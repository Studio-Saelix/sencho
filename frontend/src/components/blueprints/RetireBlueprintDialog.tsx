import { useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { previewRetireContentBinding, retireContentBinding } from '@/lib/blueprintsApi';
import { BindingPreviewDialogBody } from './BindingPreviewDialogBody';
import { useBindingPreview } from './useBindingPreview';

interface RetireBlueprintDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    blueprintId: number;
    onRetired: () => void;
}

export function RetireBlueprintDialog({
    open, onOpenChange, blueprintId, onRetired,
}: RetireBlueprintDialogProps) {
    const { preview, loading, loadError } = useBindingPreview(
        open,
        blueprintId,
        previewRetireContentBinding,
        'Failed to preview retire',
    );
    const [busy, setBusy] = useState(false);

    async function confirm() {
        if (!preview) return;
        setBusy(true);
        try {
            await retireContentBinding(blueprintId);
            toast.success('Git source restored to Direct targeting');
            onRetired();
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to retire Git-managed content');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open={open} onOpenChange={onOpenChange} size="lg">
            <ModalHeader
                kicker="BLUEPRINT · RETIRE"
                title="Retire to Direct GitOps"
                description="Restore Direct targeting using this Blueprint name as the stack identity."
            />
            <ModalBody>
                <BindingPreviewDialogBody
                    loading={loading}
                    loadError={loadError}
                    preview={preview}
                    loadErrorMessage="Could not load the retire preview."
                />
            </ModalBody>
            <ModalFooter
                primary={
                    <Button size="sm" onClick={() => { void confirm(); }} disabled={busy || !preview}>
                        {busy ? 'Retiring…' : 'Retire'}
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

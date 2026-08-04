import { useState } from 'react';
import { ConfirmModal } from '../ui/modal';
import { Checkbox } from '../ui/checkbox';

export interface DeleteStackDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    stackName: string | null;
    onConfirm: (pruneVolumes: boolean) => void | Promise<void>;
    /** True while the stack delete request owns the flow (from stackActionMap). */
    confirming?: boolean;
}

export function DeleteStackDialog({
    open,
    onOpenChange,
    stackName,
    onConfirm,
    confirming = false,
}: DeleteStackDialogProps) {
    const [pruneVolumes, setPruneVolumes] = useState(false);

    const handleOpenChange = (next: boolean) => {
        if (!next) setPruneVolumes(false);
        onOpenChange(next);
    };

    return (
        <ConfirmModal
            open={open}
            onOpenChange={handleOpenChange}
            variant="destructive"
            kicker="REMOVE · IRREVERSIBLE"
            title={
                stackName ? (
                    <>
                        Delete{' '}
                        <em
                            className="font-display italic text-destructive break-all"
                            title={stackName}
                        >
                            {stackName}
                        </em>
                        ?
                    </>
                ) : (
                    'Delete stack?'
                )
            }
            description={`Confirm deletion of ${stackName ?? 'stack'}.`}
            hint={pruneVolumes ? 'VOLUMES PRUNED' : 'VOLUMES KEPT'}
            confirmLabel="Delete"
            busyConfirmLabel="Deleting..."
            confirming={confirming}
            onConfirm={() => onConfirm(pruneVolumes)}
        >
            <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
            <div className="flex items-center gap-2">
                <Checkbox
                    id="prune-volumes"
                    checked={pruneVolumes}
                    disabled={confirming}
                    onCheckedChange={(v) => setPruneVolumes(v === true)}
                />
                <label htmlFor="prune-volumes" className="text-sm text-muted-foreground cursor-pointer select-none">
                    Also remove associated volumes
                </label>
            </div>
        </ConfirmModal>
    );
}

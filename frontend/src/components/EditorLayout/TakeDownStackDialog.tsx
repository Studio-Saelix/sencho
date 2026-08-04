import { useEffect, useState } from 'react';
import { ConfirmModal } from '../ui/modal';
import { Checkbox } from '../ui/checkbox';

export interface TakeDownStackDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    stackName: string | null;
    showVolumeOption: boolean;
    onConfirm: (removeVolumes: boolean) => void | Promise<void>;
    /** True while the take-down request owns the flow (from stackActionMap). */
    confirming?: boolean;
}

export function TakeDownStackDialog({
    open,
    onOpenChange,
    stackName,
    showVolumeOption,
    onConfirm,
    confirming = false,
}: TakeDownStackDialogProps) {
    const [removeVolumes, setRemoveVolumes] = useState(false);

    // Parent closes via overlay state (not always through handleOpenChange); reset so
    // a prior volume opt-in cannot leak into the next dialog session.
    useEffect(() => {
        if (!open) setRemoveVolumes(false);
    }, [open]);

    return (
        <ConfirmModal
            open={open}
            onOpenChange={onOpenChange}
            variant="destructive"
            kicker={`${(stackName ?? 'STACK').toUpperCase()} · TAKE DOWN${removeVolumes ? '' : ' · REVERSIBLE'}`}
            title={
                stackName ? (
                    <>
                        Take down <em className="font-display italic text-destructive">{stackName}</em>?
                    </>
                ) : (
                    'Take down stack?'
                )
            }
            description="This removes running containers and compose-created networks. The stack configuration stays on disk so you can deploy again later."
            hint={removeVolumes ? 'VOLUMES REMOVED' : 'VOLUMES KEPT'}
            confirmLabel="Take down"
            busyConfirmLabel="Taking down..."
            confirming={confirming}
            onConfirm={() => onConfirm(removeVolumes)}
        >
            {showVolumeOption && (
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="take-down-remove-volumes"
                        data-testid="take-down-remove-volumes"
                        checked={removeVolumes}
                        disabled={confirming}
                        onCheckedChange={(v) => setRemoveVolumes(v === true)}
                    />
                    <label
                        htmlFor="take-down-remove-volumes"
                        className="text-sm text-muted-foreground cursor-pointer select-none"
                    >
                        Also remove compose volumes (named and anonymous)
                    </label>
                </div>
            )}
        </ConfirmModal>
    );
}

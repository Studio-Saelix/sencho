import { useState } from 'react';
import { ConfirmModal } from '../ui/modal';
import { Checkbox } from '../ui/checkbox';

/**
 * Whether the active node is confirmed (via its fetched capabilities) to preserve volumes
 * on delete unless the operator opts in to removing them. 'unknown' covers both "not
 * fetched yet" and "fetch failed": a node we simply have not confirmed must not be assumed
 * incapable, so it requests preservation like a 'supported' node (a genuinely stale remote
 * rejects that request outright instead of silently destroying data). Only 'unsupported'
 * forces removal.
 */
export type VolumePreservationOnDelete = 'supported' | 'unsupported' | 'unknown';

export interface DeleteStackDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    stackName: string | null;
    volumePreservation?: VolumePreservationOnDelete;
    onConfirm: (pruneVolumes: boolean) => void | Promise<void>;
    /** True while the stack delete request owns the flow (from stackActionMap). */
    confirming?: boolean;
}

export function DeleteStackDialog({
    open,
    onOpenChange,
    stackName,
    volumePreservation = 'unknown',
    onConfirm,
    confirming = false,
}: DeleteStackDialogProps) {
    const [pruneVolumes, setPruneVolumes] = useState(false);
    const showVolumeOption = volumePreservation === 'supported';
    const confirmedUnsupported = volumePreservation === 'unsupported';
    // Single source of truth for what confirming will do: the operator's choice when the
    // node offers one, forced removal only on a node confirmed unable to preserve volumes.
    const willRemoveVolumes = showVolumeOption ? pruneVolumes : confirmedUnsupported;

    let volumeHint = 'VOLUMES KEPT';
    if (confirmedUnsupported) volumeHint = 'VOLUMES WILL BE REMOVED';
    else if (willRemoveVolumes) volumeHint = 'VOLUMES PRUNED';

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
            hint={volumeHint}
            confirmLabel="Delete"
            busyConfirmLabel="Deleting..."
            confirming={confirming}
            onConfirm={() => {
                setPruneVolumes(false);
                onConfirm(willRemoveVolumes);
            }}
        >
            <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
            {showVolumeOption && (
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
            )}
            {confirmedUnsupported && (
                <p className="text-sm text-destructive">
                    This node can&apos;t preserve volumes on delete. Any volumes associated with this stack will be removed too.
                </p>
            )}
        </ConfirmModal>
    );
}

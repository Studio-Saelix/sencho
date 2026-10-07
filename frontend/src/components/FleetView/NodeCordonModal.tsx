import { useState } from 'react';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { cordonNode, uncordonNode } from '@/lib/nodesApi';

interface NodeCordonModalProps {
    node: { id: number; name: string; cordoned: boolean };
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Runs after the node was cordoned or uncordoned, so the caller can refresh the fleet. */
    onChanged?: () => void;
}

/** The one cordon/uncordon confirmation, shared by the node card and the details sheet. */
export function NodeCordonModal({ node, open, onOpenChange, onChanged }: NodeCordonModalProps) {
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const confirm = async () => {
        setSubmitting(true);
        let changed = false;
        try {
            if (node.cordoned) {
                await uncordonNode(node.id);
                toast.success(`Uncordoned ${node.name}`);
            } else {
                await cordonNode(node.id, reason.trim() || null);
                toast.success(`Cordoned ${node.name}`);
            }
            changed = true;
        } catch (error) {
            console.error('Failed to update cordon state for node', node.id, error);
            const message = error instanceof Error ? error.message : 'Failed to update cordon state';
            toast.error(message);
        } finally {
            setSubmitting(false);
        }
        if (changed) {
            setReason('');
            onOpenChange(false);
            try {
                onChanged?.();
            } catch (error) {
                // The cordon itself succeeded; a failed refresh must not read as a failed cordon.
                console.error('Refresh after cordon change failed for node', node.id, error);
            }
        }
    };

    return (
        <ConfirmModal
            open={open}
            onOpenChange={(next) => {
                if (submitting) return;
                if (!next) setReason('');
                onOpenChange(next);
            }}
            kicker="Federation"
            title={node.cordoned ? `Uncordon ${node.name}` : `Cordon ${node.name}`}
            description={node.cordoned
                ? 'Re-enable this node for new blueprint placements. Existing deployments are unchanged.'
                : 'Mark this node as unschedulable. New blueprint deployments will skip it. Existing deployments remain in place.'}
            confirmLabel={node.cordoned ? 'Uncordon node' : 'Cordon node'}
            confirming={submitting}
            onConfirm={confirm}
        >
            {!node.cordoned && (
                <div className="space-y-1.5">
                    <label htmlFor={`cordon-reason-${node.id}`} className="text-xs font-medium text-muted-foreground">
                        Reason (optional)
                    </label>
                    <input
                        id={`cordon-reason-${node.id}`}
                        type="text"
                        maxLength={256}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. draining for maintenance"
                        className="w-full h-8 px-2 text-sm rounded-md border border-input bg-background"
                        disabled={submitting}
                    />
                </div>
            )}
        </ConfirmModal>
    );
}

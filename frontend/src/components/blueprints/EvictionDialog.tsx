import { useState } from 'react';
import { AlertTriangle, Camera } from 'lucide-react';
import { Modal, ModalDestructiveHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface EvictionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    blueprintName: string;
    nodeName: string;
    isStateful: boolean;
    busy: boolean;
    onConfirm: (mode: 'standard' | 'snapshot_then_evict' | 'evict_and_destroy') => void;
}

export function EvictionDialog({
    open, onOpenChange, blueprintName, nodeName, isStateful, busy, onConfirm,
}: EvictionDialogProps) {
    const [confirmText, setConfirmText] = useState('');
    const destructiveDisabled = isStateful && confirmText.trim() !== blueprintName;

    function reset() {
        setConfirmText('');
    }

    return (
        <Modal
            open={open}
            onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}
            size="lg"
        >
            <ModalDestructiveHeader
                kicker={`${blueprintName.toUpperCase()} · EVICT`}
                title={`Stop ${blueprintName} on ${nodeName}`}
                description={
                    isStateful
                        ? 'This blueprint is stateful. Choose how to handle its data on this node.'
                        : 'Sencho will run docker compose down and remove the blueprint directory on this node.'
                }
            />
            <ModalBody>
                <p className="text-sm text-muted-foreground">
                    {isStateful
                        ? 'This blueprint is stateful. Choose how to handle its data on this node.'
                        : 'Sencho will run docker compose down and remove the blueprint directory on this node.'}
                </p>
                {isStateful && (
                    <div className="space-y-3">
                        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 flex gap-2">
                            <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" strokeWidth={1.5} />
                            <p className="text-xs text-stat-subtitle leading-relaxed">
                                Named volumes or bind mounts were detected. Evicting destroys the named volumes managed by this stack on{' '}
                                <span className="font-mono">{nodeName}</span>. Bind mounts on the host filesystem are left in place.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => onConfirm('snapshot_then_evict')}
                            disabled={busy}
                            className="w-full text-left rounded-lg border border-card-border border-t-card-border-top bg-card hover:border-t-card-border-hover transition-colors p-3 cursor-pointer"
                        >
                            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-brand">
                                <Camera className="w-3 h-3" strokeWidth={1.5} />
                                Snapshot, then evict (recommended)
                            </div>
                            <p className="text-xs text-stat-subtitle mt-1.5 leading-relaxed">
                                Captures this stack's compose definition to Fleet → Snapshots, then runs the eviction. Volume bytes stay on this node and are removed by docker compose down. Relocate them by hand if you need them on another node.
                            </p>
                        </button>
                        <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">
                                Evict and destroy data
                            </div>
                            <p className="text-xs text-stat-subtitle leading-relaxed">
                                Type <span className="font-mono text-stat-value">{blueprintName}</span> to confirm.
                            </p>
                            <Input
                                value={confirmText}
                                onChange={(e) => setConfirmText(e.target.value)}
                                placeholder={blueprintName}
                                className="font-mono text-xs"
                                disabled={busy}
                            />
                        </div>
                    </div>
                )}
            </ModalBody>
            <ModalFooter
                secondary={
                    <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                        Cancel
                    </Button>
                }
                primary={
                    isStateful ? (
                        <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive border-destructive/40 hover:bg-destructive/10"
                            disabled={destructiveDisabled || busy}
                            onClick={() => onConfirm('evict_and_destroy')}
                        >
                            Evict and destroy data
                        </Button>
                    ) : (
                        <Button
                            size="sm"
                            onClick={() => onConfirm('standard')}
                            disabled={busy}
                        >
                            Withdraw deployment
                        </Button>
                    )
                }
            />
        </Modal>
    );
}

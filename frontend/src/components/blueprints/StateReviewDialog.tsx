import { Database, Loader2, Play } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

interface StateReviewDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    blueprintName: string;
    nodeName: string;
    busy: boolean;
    onAccept: (mode: 'fresh' | 'restore_from_snapshot') => void;
}

export function StateReviewDialog({
    open, onOpenChange, blueprintName, nodeName, busy, onAccept,
}: StateReviewDialogProps) {
    return (
        <Modal open={open} onOpenChange={onOpenChange} size="lg">
            <ModalHeader
                kicker={`${blueprintName.toUpperCase()} · DEPLOY`}
                title={`Deploy ${blueprintName} to ${nodeName}?`}
                description="This blueprint is stateful and has never run on this node. Sencho will create empty volumes unless you choose to restore from a prior snapshot."
            />
            <ModalBody>
                <p className="text-sm text-muted-foreground">
                    This blueprint is stateful and has never run on this node. Sencho will create
                    empty volumes unless you choose to restore from a prior snapshot.
                </p>
                <div className="space-y-2">
                    <button
                        type="button"
                        onClick={() => onAccept('fresh')}
                        disabled={busy}
                        className="w-full text-left rounded-lg border border-card-border border-t-card-border-top bg-card hover:border-t-card-border-hover transition-colors p-3 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-brand">
                            {busy ? (
                                <>
                                    <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
                                    Deploying…
                                </>
                            ) : (
                                <>
                                    <Play className="w-3 h-3" strokeWidth={1.5} />
                                    Deploy fresh
                                </>
                            )}
                        </div>
                        <p className="text-xs text-stat-subtitle mt-1.5 leading-relaxed">
                            Create empty named volumes on this node. The container starts with whatever default state its image carries.
                        </p>
                    </button>
                    <button
                        type="button"
                        disabled
                        className="w-full text-left rounded-lg border border-card-border bg-card/40 p-3 opacity-60 cursor-not-allowed"
                    >
                        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-stat-icon">
                            <Database className="w-3 h-3" strokeWidth={1.5} />
                            Restore from snapshot
                        </div>
                        <p className="text-xs text-stat-subtitle mt-1.5 leading-relaxed">
                            Coming with the future Volume Migration feature. App-aware backup tooling (postgres → pg_basebackup, mysql → xtrabackup) will populate volumes from a prior deployment.
                        </p>
                    </button>
                </div>
            </ModalBody>
            <ModalFooter
                primary={
                    <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                        Cancel
                    </Button>
                }
            />
        </Modal>
    );
}

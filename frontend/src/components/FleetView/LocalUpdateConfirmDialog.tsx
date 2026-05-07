import { Download } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';

interface LocalUpdateConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
}

export function LocalUpdateConfirmDialog({ open, onOpenChange, onConfirm }: LocalUpdateConfirmDialogProps) {
    return (
        <ConfirmModal
            open={open}
            onOpenChange={onOpenChange}
            kicker="LOCAL · UPDATE"
            title="Update local node"
            confirmLabel={
                <>
                    <Download className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                    Update &amp; restart
                </>
            }
            onConfirm={onConfirm}
        >
            <p className="text-sm text-stat-subtitle">
                Pulls the latest Sencho image and restarts the server. The dashboard briefly disconnects and reconnects automatically when the update completes.
            </p>
        </ConfirmModal>
    );
}

import { Download } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';
import { formatVersion } from '@/lib/version';
import type { ImagePinKind } from './types';

interface LocalUpdateConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    imagePinKind?: ImagePinKind | null;
    composeImageRef?: string | null;
    targetImageRef?: string | null;
    targetVersion?: string | null;
}

export function LocalUpdateConfirmDialog({
    open, onOpenChange, onConfirm, imagePinKind, composeImageRef, targetImageRef, targetVersion,
}: LocalUpdateConfirmDialogProps) {
    const versionLabel = formatVersion(targetVersion) ?? 'the latest release';
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
            {imagePinKind === 'semver' && composeImageRef && targetImageRef ? (
                <p className="text-sm text-stat-subtitle">
                    This install pins <code className="text-stat-value">{composeImageRef}</code>. Updating rewrites it to{' '}
                    <code className="text-stat-value">{targetImageRef}</code> and restarts the server. The dashboard briefly disconnects and reconnects automatically when the update completes.
                </p>
            ) : (
                <p className="text-sm text-stat-subtitle">
                    Pulls Sencho {versionLabel} and restarts the server. The dashboard briefly disconnects and reconnects automatically when the update completes.
                </p>
            )}
        </ConfirmModal>
    );
}

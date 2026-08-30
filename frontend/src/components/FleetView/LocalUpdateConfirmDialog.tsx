import { Download, FlaskConical, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConfirmModal } from '@/components/ui/modal';
import { formatVersion } from '@/lib/version';
import type { ImagePinKind } from './types';

interface LocalUpdateConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    mode?: 'update' | 'reapply';
    /** Distinguishes local vs remote reapply copy. Ignored for update mode. */
    nodeType?: 'local' | 'remote';
    imagePinKind?: ImagePinKind | null;
    composeImageRef?: string | null;
    targetImageRef?: string | null;
    targetVersion?: string | null;
    /** True when the node's compose image is any sencho-dev reference. Only
     *  meaningful in update mode; ignored for reapply. */
    isDevImage?: boolean;
}

export function LocalUpdateConfirmDialog({
    open, onOpenChange, onConfirm, mode = 'update', nodeType = 'local',
    imagePinKind, composeImageRef, targetImageRef, targetVersion, isDevImage,
}: LocalUpdateConfirmDialogProps) {
    const isReapply = mode === 'reapply';
    const isRemoteReapply = isReapply && nodeType === 'remote';
    const isDevUpdate = !isReapply && isDevImage;
    const versionLabel = formatVersion(targetVersion) ?? 'the latest release';

    let kicker = 'LOCAL · UPDATE';
    if (isRemoteReapply) kicker = 'REMOTE · REAPPLY';
    else if (isReapply) kicker = 'LOCAL · REAPPLY';
    else if (isDevUpdate) kicker = 'LOCAL · DEV UPDATE';

    let body: ReactNode;
    if (isRemoteReapply) {
        body = (
            <p className="text-sm text-stat-subtitle">
                Recreates this remote Sencho service from its current Compose configuration.
                No newer Sencho version is selected, and Sencho will not rewrite the
                configured image reference. The node will restart; Fleet tracks reconnection.
            </p>
        );
    } else if (isReapply) {
        body = (
            <p className="text-sm text-stat-subtitle">
                Recreates this Sencho service from its current Compose configuration.
                No newer Sencho version is selected, and Sencho will not rewrite the
                configured image reference. The dashboard may briefly disconnect and
                reconnects automatically when the restart completes.
            </p>
        );
    } else if (isDevUpdate) {
        body = (
            <p className="text-sm text-stat-subtitle">
                Pulls <code className="text-stat-value">ghcr.io/studio-saelix/sencho-dev:dev</code> and
                restarts the server. The image reference is not rewritten. Integration
                images are unsigned and carry no release attestations. The dashboard
                briefly disconnects and reconnects automatically when the update completes.
            </p>
        );
    } else if (imagePinKind === 'semver' && composeImageRef && targetImageRef) {
        body = (
            <p className="text-sm text-stat-subtitle">
                This install pins <code className="text-stat-value">{composeImageRef}</code>. Updating rewrites it to{' '}
                <code className="text-stat-value">{targetImageRef}</code> and restarts the server. The dashboard briefly disconnects and reconnects automatically when the update completes.
            </p>
        );
    } else {
        body = (
            <p className="text-sm text-stat-subtitle">
                Pulls Sencho {versionLabel} and restarts the server. The dashboard briefly disconnects and reconnects automatically when the update completes.
            </p>
        );
    }

    return (
        <ConfirmModal
            open={open}
            onOpenChange={onOpenChange}
            kicker={kicker}
            title={isReapply ? 'Reapply configuration' : 'Update local node'}
            confirmLabel={
                isReapply ? (
                    <>
                        <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                        Reapply &amp; restart
                    </>
                ) : isDevUpdate ? (
                    <>
                        <FlaskConical className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                        Update &amp; restart
                    </>
                ) : (
                    <>
                        <Download className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                        Update &amp; restart
                    </>
                )
            }
            onConfirm={onConfirm}
        >
            {body}
        </ConfirmModal>
    );
}

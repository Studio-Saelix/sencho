import { Download, FlaskConical, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ConfirmModal } from '@/components/ui/modal';
import { formatVersion } from '@/lib/version';
import { useEndpointProviderOption, type EndpointProviderOption } from './hooks/useEndpointProviderOption';
import type { ImagePinKind } from './types';

/** What the operator chose in the dialog, passed to the confirm handler. */
export interface UpdateConfirmChoice {
    /** Also recreate the container carrying the node's Docker API. */
    replaceEndpointProvider: boolean;
}

interface LocalUpdateConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (choice: UpdateConfirmChoice) => void | Promise<void>;
    mode?: 'update' | 'reapply';
    /** Distinguishes local vs remote copy. */
    nodeType?: 'local' | 'remote';
    /** The node being updated; when set, the dialog offers to recreate its Docker endpoint. */
    nodeId?: number | null;
    imagePinKind?: ImagePinKind | null;
    composeImageRef?: string | null;
    targetImageRef?: string | null;
    targetVersion?: string | null;
    /** True when the node's compose image is any sencho-dev reference. Only
     *  meaningful in update mode; ignored for reapply. */
    isDevImage?: boolean;
}

export function LocalUpdateConfirmDialog({
    open, onOpenChange, onConfirm, mode = 'update', nodeType = 'local', nodeId,
    imagePinKind, composeImageRef, targetImageRef, targetVersion, isDevImage,
}: LocalUpdateConfirmDialogProps) {
    const isReapply = mode === 'reapply';
    const isRemoteReapply = isReapply && nodeType === 'remote';
    const isRemoteUpdate = !isReapply && nodeType === 'remote';
    const isDevUpdate = !isReapply && isDevImage;
    const versionLabel = formatVersion(targetVersion) ?? 'the latest release';
    const endpointOption = useEndpointProviderOption(nodeId, open);
    const [replaceEndpointProvider, setReplaceEndpointProvider] = useState(false);

    let kicker = 'LOCAL · UPDATE';
    if (isRemoteReapply) kicker = 'REMOTE · REAPPLY';
    else if (isReapply) kicker = 'LOCAL · REAPPLY';
    else if (isRemoteUpdate) kicker = 'REMOTE · UPDATE';
    else if (isDevUpdate) kicker = 'LOCAL · DEV UPDATE';

    let body: ReactNode;
    if (isRemoteUpdate) {
        body = (
            <p className="text-sm text-stat-subtitle">
                Pulls Sencho {versionLabel} on this node and restarts it. Fleet tracks reconnection.
            </p>
        );
    } else if (isRemoteReapply) {
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
            onOpenChange={(next) => {
                // A fresh dialog never carries the previous choice.
                if (!next) setReplaceEndpointProvider(false);
                onOpenChange(next);
            }}
            kicker={kicker}
            title={isReapply ? 'Reapply configuration' : isRemoteUpdate ? 'Update node' : 'Update local node'}
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
            onConfirm={() => {
                const choice = { replaceEndpointProvider: endpointOption?.state === 'available' && replaceEndpointProvider };
                setReplaceEndpointProvider(false);
                // Returned so an async confirm keeps the dialog open, as before.
                return onConfirm(choice);
            }}
        >
            {body}
            <EndpointProviderChoice
                option={endpointOption}
                checked={replaceEndpointProvider}
                onCheckedChange={setReplaceEndpointProvider}
            />
        </ConfirmModal>
    );
}

/**
 * The opt-in to recreate the node's Docker endpoint with Sencho, shown only
 * when the node reports one. A provider that cannot be replaced from here is
 * named with the reason instead, so the operator knows it is left alone.
 */
function EndpointProviderChoice({ option, checked, onCheckedChange }: {
    option: EndpointProviderOption | null;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
}) {
    if (option?.state === 'available') {
        return (
            <div className="space-y-1 pt-2">
                <div className="flex items-center space-x-2">
                    <Checkbox
                        id="replace-endpoint-provider"
                        checked={checked}
                        onCheckedChange={(value) => onCheckedChange(value === true)}
                    />
                    <Label htmlFor="replace-endpoint-provider" className="text-sm cursor-pointer">
                        Also recreate the Docker endpoint <code className="text-stat-value">{option.service}</code>
                    </Label>
                </div>
                <p className="text-xs text-stat-subtitle pl-6">
                    Sencho reaches Docker through this container. It is recreated from its current
                    Compose configuration and image before Sencho restarts. If the new container
                    does not give Sencho working Docker access, the previous one is restored.
                </p>
            </div>
        );
    }
    if (option?.state === 'unavailable') {
        return (
            <p className="text-xs text-stat-subtitle pt-2">
                The Docker endpoint{option.service ? <> <code className="text-stat-value">{option.service}</code></> : null} is
                left running: {option.reason}
            </p>
        );
    }
    return null;
}

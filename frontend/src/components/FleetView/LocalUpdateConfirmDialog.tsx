import { Download, FlaskConical, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ConfirmModal } from '@/components/ui/modal';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { formatVersion } from '@/lib/version';
import { useEndpointProviderOption, type EndpointProviderOption } from './hooks/useEndpointProviderOption';
import type { ImagePinKind } from './types';

/** Which services an Update or Reapply recreates. */
export type EndpointProviderScope = 'none' | 'with-sencho' | 'only';

/** What the operator chose in the dialog, passed to the confirm handler. */
export interface UpdateConfirmChoice {
    /** Also recreate the container carrying the node's Docker API. */
    replaceEndpointProvider: boolean;
    /** Recreate only that container and leave Sencho running. */
    endpointProviderOnly: boolean;
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
    /** The node's name, shown when the preview names where the work happens. */
    nodeName?: string | null;
    imagePinKind?: ImagePinKind | null;
    composeImageRef?: string | null;
    targetImageRef?: string | null;
    targetVersion?: string | null;
    /** True when the node's compose image is any sencho-dev reference. Only
     *  meaningful in update mode; ignored for reapply. */
    isDevImage?: boolean;
    /** Offer "endpoint only" (Reapply only): replaces the provider without recreating Sencho. */
    allowEndpointProviderOnly?: boolean;
    /** Preselected scope when the caller already knows what the operator asked for. */
    initialScope?: EndpointProviderScope;
}

export function LocalUpdateConfirmDialog({
    open, onOpenChange, onConfirm, mode = 'update', nodeType = 'local', nodeId,
    nodeName, imagePinKind, composeImageRef, targetImageRef, targetVersion, isDevImage,
    allowEndpointProviderOnly = false, initialScope = 'none',
}: LocalUpdateConfirmDialogProps) {
    const isReapply = mode === 'reapply';
    const isRemoteReapply = isReapply && nodeType === 'remote';
    const isRemoteUpdate = !isReapply && nodeType === 'remote';
    const isDevUpdate = !isReapply && isDevImage;
    const versionLabel = formatVersion(targetVersion) ?? 'the latest release';
    const endpointOption = useEndpointProviderOption(nodeId, open);
    const [replaceEndpointProvider, setReplaceEndpointProvider] = useState(false);
    /**
     * Null until the operator picks a scope: the caller's preselection (a handoff
     * from a refused operation) is the default, and closing the dialog drops the
     * pick so a fresh one never carries the previous choice.
     */
    const [scopeChoice, setScopeChoice] = useState<EndpointProviderScope | null>(null);
    const endpointAvailable = endpointOption?.state === 'available';
    const providerOnlyOffered = isReapply && allowEndpointProviderOnly
      && endpointAvailable && endpointOption.providerOnly === true;
    const scope = scopeChoice ?? initialScope;
    const effectiveScope: EndpointProviderScope = endpointAvailable
      ? (scope === 'only' && !providerOnlyOffered ? 'with-sencho' : scope)
      : 'none';

    let kicker = 'LOCAL · UPDATE';
    if (isRemoteReapply) kicker = 'REMOTE · REAPPLY';
    else if (isReapply) kicker = 'LOCAL · REAPPLY';
    else if (isRemoteUpdate) kicker = 'REMOTE · UPDATE';
    else if (isDevUpdate) kicker = 'LOCAL · DEV UPDATE';

    const nodeLabel = nodeName?.trim() || (nodeType === 'local' ? 'this node' : 'the node');
    const providerService = endpointOption?.state === 'available' ? endpointOption.service : null;
    const providerProject = endpointOption?.state === 'available' ? endpointOption.project : null;

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
        body = effectiveScope === 'only' && providerService ? (
            <p className="text-sm text-stat-subtitle">
                Recreates only <code className="text-stat-value">{providerService}</code> in
                Compose project {providerProject ? <code className="text-stat-value">{providerProject}</code> : 'the authored project'} on <span className="text-stat-value">{nodeLabel}</span>.
                Sencho keeps running and reconnects through the new container. Other services are
                not recreated, and no newer Sencho version is selected. If the new container does
                not give Sencho working Docker access, the previous one is restored.
            </p>
        ) : effectiveScope === 'with-sencho' && providerService ? (
            <p className="text-sm text-stat-subtitle">
                Recreates <code className="text-stat-value">{providerService}</code> from its current
                Compose configuration and image, then recreates Sencho. Other services are left
                alone. If the new container does not give Sencho working Docker access, the previous
                one is restored. The dashboard briefly disconnects and reconnects automatically.
            </p>
        ) : (
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

    const confirmLabel = isReapply
        ? effectiveScope === 'only' ? (
            <>
                <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                Recreate endpoint
            </>
        ) : (
            <>
                <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                Reapply &amp; restart
            </>
        )
        : isDevUpdate ? (
            <>
                <FlaskConical className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                Update &amp; restart
            </>
        ) : (
            <>
                <Download className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                Update &amp; restart
            </>
        );

    return (
        <ConfirmModal
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    setReplaceEndpointProvider(false);
                    setScopeChoice(null);
                }
                onOpenChange(next);
            }}
            kicker={kicker}
            title={
                isReapply
                    ? effectiveScope === 'only' ? 'Recreate the Docker endpoint' : 'Reapply configuration'
                    : isRemoteUpdate ? 'Update node' : 'Update local node'
            }
            confirmLabel={confirmLabel}
            hint={isReapply && effectiveScope === 'only' ? 'KEEPS Sencho running' : undefined}
            confirmDisabled={isReapply && initialScope === 'only' && !endpointAvailable}
            onConfirm={() => {
                const choice: UpdateConfirmChoice = {
                    replaceEndpointProvider: effectiveScope !== 'none',
                    endpointProviderOnly: effectiveScope === 'only',
                };
                setReplaceEndpointProvider(false);
                setScopeChoice(null);
                // Returned so an async confirm keeps the dialog open, as before.
                return onConfirm(choice);
            }}
        >
            {body}
            {isReapply && endpointAvailable ? (
                <div className="space-y-2 pt-3">
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
                        Recreates
                    </span>
                    <SegmentedControl<EndpointProviderScope>
                        value={effectiveScope}
                        onChange={(next) => setScopeChoice(next)}
                        ariaLabel="What to recreate"
                        options={[
                            { value: 'none', label: 'Sencho' },
                            { value: 'with-sencho', label: 'Sencho + endpoint' },
                            ...(providerOnlyOffered ? [{ value: 'only' as const, label: 'Endpoint only' }] : []),
                        ]}
                    />
                    <p className="text-xs text-stat-subtitle">
                        <code className="text-stat-value">{endpointOption.service}</code> is the container
                        carrying Docker access for {nodeLabel}. Recreating replaces it even when its
                        configuration did not change.
                    </p>
                </div>
            ) : null}
            {!isReapply ? (
                <EndpointProviderChoice
                    option={endpointOption}
                    checked={replaceEndpointProvider}
                    onCheckedChange={setReplaceEndpointProvider}
                />
            ) : null}
            {isReapply && !endpointAvailable ? (
                <EndpointProviderUnavailable
                    option={endpointOption}
                    providerOnlyOffered={providerOnlyOffered || initialScope === 'only'}
                />
            ) : null}
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
    return <EndpointProviderUnavailable option={option} providerOnlyOffered={false} />;
}

/** Why the endpoint cannot be recreated here, or nothing when the node has none. */
function EndpointProviderUnavailable({ option, providerOnlyOffered }: {
    option: EndpointProviderOption | null;
    providerOnlyOffered: boolean;
}) {
    if (option?.state === 'unavailable') {
        return (
            <p className="text-xs text-stat-subtitle pt-2">
                The Docker endpoint{option.service ? <> <code className="text-stat-value">{option.service}</code></> : null} is
                left running: {option.reason}
            </p>
        );
    }
    if (option?.state === 'unsupported' && providerOnlyOffered) {
        return (
            <p className="text-xs text-stat-subtitle pt-2">
                This node runs a Sencho version that cannot recreate its Docker endpoint. Only Sencho can be reapplied.
            </p>
        );
    }
    if (option?.state === 'none' && providerOnlyOffered) {
        return (
            <p className="text-xs text-stat-subtitle pt-2">
                This node reaches Docker without a container, so there is no Docker endpoint to recreate.
            </p>
        );
    }
    return null;
}

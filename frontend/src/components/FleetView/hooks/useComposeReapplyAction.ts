import { useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { NodeUpdateStatus } from '../types';
import type { EndpointProviderScope, UpdateConfirmChoice } from '../LocalUpdateConfirmDialog';

export type ComposeReapplyTarget = {
    nodeId: number;
    type: 'local' | 'remote';
    name: string;
    /** Preselected scope when the caller already knows what was asked for. */
    initialScope?: EndpointProviderScope;
};

function parseReapplyError(err: Record<string, unknown>, fallback: string): string {
    const nested = err?.data as Record<string, unknown> | undefined;
    const message = err?.message ?? err?.error ?? nested?.error;
    return typeof message === 'string' && message ? message : fallback;
}

function reapplyRequest(choice?: UpdateConfirmChoice) {
    if (!choice?.replaceEndpointProvider) return { method: 'POST', localOnly: true } as const;
    return {
        method: 'POST',
        localOnly: true,
        body: JSON.stringify({
            replaceEndpointProvider: true,
            ...(choice.endpointProviderOnly ? { endpointProviderOnly: true } : {}),
        }),
    } as const;
}

/**
 * A provider-only reapply never restarts Sencho, so there is no reconnection to
 * watch. The node reports progress and the verdict on its Fleet tracker; poll it
 * until the row settles and say how it ended.
 */
async function watchEndpointOnlyReapply(nodeName: string, onSettled: () => void): Promise<void> {
    // The node's own bound (watcher plus verdict) can run past ten minutes.
    const deadline = Date.now() + 12 * 60_000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 3_000));
        try {
            const res = await apiFetch('/fleet/update-status', { localOnly: true });
            if (!res.ok) continue;
            const data = await res.json();
            const local = (data.nodes ?? []).find((node: NodeUpdateStatus) => node.type === 'local');
            if (!local) continue;
            if (local.updateStatus === 'completed') {
                toast.success(`Docker endpoint recreated on ${nodeName}. Sencho reconnected to it.`);
                onSettled();
                return;
            }
            if (local.updateStatus === 'failed' || local.updateStatus === 'timeout') {
                toast.error(local.error || 'Recreating the Docker endpoint failed.');
                onSettled();
                return;
            }
        } catch (error) {
            console.warn('[ComposeReapply] Docker endpoint status poll failed:', error);
        }
    }
    toast.error('Recreating the Docker endpoint did not finish in time. Check Docker logs on the host.');
    onSettled();
}

async function readBootStartedAt(): Promise<number | null> {
    try {
        const healthRes = await fetch('/api/health');
        if (!healthRes.ok) return null;
        const data = await healthRes.json();
        return typeof data?.startedAt === 'number' ? data.startedAt : null;
    } catch {
        return null;
    }
}

export type UseComposeReapplyActionOptions = {
    /** Refresh fleet statuses after a successful remote dispatch. */
    onRemoteSuccess?: () => void;
};

/**
 * Shared confirm → dispatch → reconnect workflow for compose reapply.
 * Used by Fleet Node Updates and the Compose editor Save & Reapply path.
 */
export function useComposeReapplyAction(options: UseComposeReapplyActionOptions = {}) {
    const { onRemoteSuccess } = options;
    const onRemoteSuccessRef = useRef(onRemoteSuccess);
    onRemoteSuccessRef.current = onRemoteSuccess;

    const [confirmTarget, setConfirmTarget] = useState<ComposeReapplyTarget | null>(null);
    const [busyNodeId, setBusyNodeId] = useState<number | null>(null);
    const [reconnecting, setReconnecting] = useState(false);
    const [preUpdateStartedAt, setPreUpdateStartedAt] = useState<number | null>(null);
    const dispatchingRef = useRef(false);

    const openConfirm = useCallback((target: ComposeReapplyTarget) => {
        setConfirmTarget(target);
    }, []);

    const cancelConfirm = useCallback(() => {
        setConfirmTarget(null);
    }, []);

    const runReapply = useCallback(async (target: ComposeReapplyTarget, choice?: UpdateConfirmChoice) => {
        if (dispatchingRef.current) return;

        dispatchingRef.current = true;
        setBusyNodeId(target.nodeId);
        const path = `/fleet/nodes/${target.nodeId}/reapply-compose`;
        const init = reapplyRequest(choice);

        try {
            if (target.type === 'local') {
                const bootBefore = choice?.endpointProviderOnly ? null : await readBootStartedAt();
                const res = await apiFetch(path, init);
                if (res.ok) {
                    if (choice?.endpointProviderOnly) {
                        // Sencho stays up: report the node's own verdict instead of
                        // showing a reconnect overlay that would never resolve.
                        const loadingId = toast.loading('Recreating the Docker endpoint...');
                        void watchEndpointOnlyReapply(target.name, () => {
                            toast.dismiss(loadingId);
                            onRemoteSuccessRef.current?.();
                        });
                    } else {
                        setPreUpdateStartedAt(bootBefore);
                        setReconnecting(true);
                    }
                } else {
                    const err = await res.json().catch(() => ({}));
                    toast.error(parseReapplyError(err, 'Failed to trigger local compose reapply.'));
                }
                return;
            }

            const res = await apiFetch(path, init);
            if (res.ok) {
                toast.success(choice?.endpointProviderOnly
                    ? `Recreating the Docker endpoint on ${target.name}. Sencho keeps running.`
                    : `Compose reapply initiated on ${target.name}.`);
                onRemoteSuccessRef.current?.();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(parseReapplyError(err, 'Failed to trigger compose reapply.'));
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            dispatchingRef.current = false;
            setBusyNodeId(null);
        }
    }, []);

    const confirmReapply = useCallback(async (choice?: UpdateConfirmChoice) => {
        const target = confirmTarget;
        setConfirmTarget(null);
        if (!target) return;
        await runReapply(target, choice);
    }, [confirmTarget, runReapply]);

    // While reconnecting, poll fleet update-status so a validation/helper failure
    // before restart dismisses the overlay instead of waiting for the timeout.
    useEffect(() => {
        if (!reconnecting) return;
        const poll = setInterval(async () => {
            try {
                const res = await apiFetch('/fleet/update-status', { localOnly: true });
                if (!res.ok) return;
                const data = await res.json();
                const nodes: NodeUpdateStatus[] = data.nodes ?? [];
                const local = nodes.find(s => s.type === 'local');
                if (local && (local.updateStatus === 'failed' || local.updateStatus === 'timeout')) {
                    setReconnecting(false);
                    setPreUpdateStartedAt(null);
                    toast.error(local.error || 'Local compose reapply failed. The server did not restart.');
                    onRemoteSuccessRef.current?.();
                }
            } catch (error) {
                console.warn('[ComposeReapply] Reconnect status poll failed:', error);
            }
        }, 3000);
        return () => clearInterval(poll);
    }, [reconnecting]);

    return {
        confirmTarget,
        openConfirm,
        cancelConfirm,
        confirmReapply,
        runReapply,
        busyNodeId,
        dispatching: busyNodeId !== null,
        reconnecting,
        preUpdateStartedAt,
        reconnectMode: 'reapply' as const,
        setReconnecting,
        setPreUpdateStartedAt,
    };
}

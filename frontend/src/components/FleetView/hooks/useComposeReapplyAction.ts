import { useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { NodeUpdateStatus } from '../types';

export type ComposeReapplyTarget = {
    nodeId: number;
    type: 'local' | 'remote';
    name: string;
};

function parseReapplyError(err: Record<string, unknown>, fallback: string): string {
    const nested = err?.data as Record<string, unknown> | undefined;
    const message = err?.message ?? err?.error ?? nested?.error;
    return typeof message === 'string' && message ? message : fallback;
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

    const runReapply = useCallback(async (target: ComposeReapplyTarget) => {
        if (dispatchingRef.current) return;

        dispatchingRef.current = true;
        setBusyNodeId(target.nodeId);
        const path = `/fleet/nodes/${target.nodeId}/reapply-compose`;
        const init = { method: 'POST', localOnly: true } as const;

        try {
            if (target.type === 'local') {
                const bootBefore = await readBootStartedAt();
                const res = await apiFetch(path, init);
                if (res.ok) {
                    setPreUpdateStartedAt(bootBefore);
                    setReconnecting(true);
                } else {
                    const err = await res.json().catch(() => ({}));
                    toast.error(parseReapplyError(err, 'Failed to trigger local compose reapply.'));
                }
                return;
            }

            const res = await apiFetch(path, init);
            if (res.ok) {
                toast.success(`Compose reapply initiated on ${target.name}.`);
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

    const confirmReapply = useCallback(async () => {
        const target = confirmTarget;
        setConfirmTarget(null);
        if (!target) return;
        await runReapply(target);
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

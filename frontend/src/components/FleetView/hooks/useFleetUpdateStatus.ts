import { useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { isValidVersion } from '@/lib/version';
import { PINNED_UPDATE_BLOCKED_FALLBACK, type NodeUpdateStatus } from '../types';
import { useComposeReapplyAction } from './useComposeReapplyAction';

/** POST body for an update trigger: forward the target release when it is a
 *  valid version so the receiving node can repin a semver pin to it; omit
 *  otherwise so the backend falls back to its compare target.
 *
 *  A dev image never gets a targetVersion, even when latestVersion is a
 *  valid stable release: latestVersion there is the latest STABLE release,
 *  unrelated to what a dev-channel update actually installs. The backend
 *  already ignores targetVersion safely for a floating pin (it only repins
 *  a semver-classified pin), so this is a copy-accuracy fix, not a safety
 *  fix: without it, the button label and confirm-dialog would claim a
 *  stable version number the update isn't installing. */
function updateRequestInit(status: NodeUpdateStatus | undefined): RequestInit & { localOnly: true } {
    const base = { method: 'POST', localOnly: true } as const;
    return !status?.isDevImage && isValidVersion(status?.latestVersion)
        ? { ...base, body: JSON.stringify({ targetVersion: status!.latestVersion }) }
        : base;
}

function parseUpdateError(err: Record<string, unknown>, fallback: string): string {
    const nested = err?.data as Record<string, unknown> | undefined;
    const message = err?.message ?? err?.error ?? nested?.error;
    return typeof message === 'string' && message ? message : fallback;
}

function toastIfUpdateBlocked(status: NodeUpdateStatus | undefined): boolean {
    // Hardened digests report updateBlocked but still accept a POST so the typed
    // HARDENED_REMOTE_UPDATE_UNSUPPORTED path can surface.
    if (!status?.updateBlocked || status.imageChannel === 'hardened') return false;
    toast.error(status.updateBlockedReason ?? PINNED_UPDATE_BLOCKED_FALLBACK);
    return true;
}

async function readBootStartedAt(): Promise<number | null> {
    try {
        const healthRes = await fetch('/api/health');
        if (!healthRes.ok) return null;
        const data = await healthRes.json();
        return typeof data?.startedAt === 'number' ? data.startedAt : null;
    } catch {
        // Fall back to offline-then-online detection in the reconnect overlay.
        return null;
    }
}

export function useFleetUpdateStatus() {
    const [updateStatuses, setUpdateStatuses] = useState<NodeUpdateStatus[]>([]);
    const [updatingNodeId, setUpdatingNodeId] = useState<number | null>(null);
    const [reconnecting, setReconnecting] = useState(false);
    const [preUpdateStartedAt, setPreUpdateStartedAt] = useState<number | null>(null);
    const [localUpdateConfirm, setLocalUpdateConfirm] = useState<number | null>(null);
    const [reconnectMode, setReconnectMode] = useState<'update' | 'reapply'>('update');
    const [showUpdateModal, setShowUpdateModal] = useState(false);
    const [checkingUpdates, setCheckingUpdates] = useState(false);

    // Held synchronously so non-memoised callers (triggerNodeUpdate) read the
    // latest snapshot without taking updateStatuses as a dependency.
    const updateStatusesRef = useRef(updateStatuses);
    updateStatusesRef.current = updateStatuses;

    const fetchUpdateStatus = useCallback(async () => {
        try {
            const res = await apiFetch('/fleet/update-status', { localOnly: true });
            if (res.ok) {
                const data = await res.json();
                const next: NodeUpdateStatus[] = data.nodes ?? [];
                setUpdateStatuses(prev =>
                    JSON.stringify(prev) === JSON.stringify(next) ? prev : next
                );
            } else {
                // apiFetch only throws on 401/network, so an HTTP error (500/403/
                // 502) lands here, not in the catch. Log it so the breadcrumb
                // covers backend failures too; keep last-known statuses.
                console.warn('[Fleet] update-status returned HTTP', res.status);
            }
        } catch (error) {
            // Polled call (every 5s while updating, 2m otherwise): log for
            // diagnosis but stay silent in the UI so a transient failure does
            // not toast on every tick. The view keeps its last-known statuses.
            console.warn('[Fleet] Failed to fetch update status:', error);
        }
    }, []);

    const reapplyAction = useComposeReapplyAction({ onRemoteSuccess: fetchUpdateStatus });
    const {
        openConfirm: openReapplyConfirm,
        cancelConfirm: cancelReapplyConfirm,
        confirmReapply,
        confirmTarget: reapplyConfirmTarget,
        busyNodeId: reapplyBusyNodeId,
        reconnecting: reapplyReconnecting,
        preUpdateStartedAt: reapplyPreStartedAt,
    } = reapplyAction;

    const postRemoteAction = useCallback(async (
        nodeId: number,
        path: string,
        init: RequestInit & { localOnly: true },
        successMsg: string,
        failFallback: string,
    ) => {
        setUpdatingNodeId(nodeId);
        try {
            const res = await apiFetch(path, init);
            if (res.ok) {
                toast.success(successMsg);
                fetchUpdateStatus();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(parseUpdateError(err, failFallback));
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setUpdatingNodeId(null);
        }
    }, [fetchUpdateStatus]);

    const startLocalRestart = useCallback(async (
        nodeId: number,
        path: string,
        init: RequestInit & { localOnly: true },
        mode: 'update' | 'reapply',
        failFallback: string,
    ) => {
        setUpdatingNodeId(nodeId);
        try {
            // Capture pre-restart boot timestamp so the overlay can detect a real
            // restart vs a false "online" response from the still-running process.
            const bootBefore = await readBootStartedAt();
            const res = await apiFetch(path, init);
            if (res.ok) {
                setReconnectMode(mode);
                setPreUpdateStartedAt(bootBefore);
                setReconnecting(true);
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(parseUpdateError(err, failFallback));
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setUpdatingNodeId(null);
        }
    }, []);

    const triggerNodeUpdate = useCallback(async (nodeId: number) => {
        const status = updateStatusesRef.current.find(s => s.nodeId === nodeId);
        // A pin we cannot repin (digest/unknown) has no update action; the button
        // is disabled upstream, but guard here so a stale click cannot POST.
        if (toastIfUpdateBlocked(status)) return;
        if (status?.type === 'local') {
            setLocalUpdateConfirm(nodeId);
            return;
        }

        await postRemoteAction(
            nodeId,
            `/fleet/nodes/${nodeId}/update`,
            updateRequestInit(status),
            `Update initiated on ${status?.name ?? 'node'}.`,
            'Failed to trigger update.',
        );
    }, [postRemoteAction]);

    const confirmLocalUpdate = useCallback(async () => {
        const nodeId = localUpdateConfirm;
        setLocalUpdateConfirm(null);
        if (!nodeId) return;
        const status = updateStatusesRef.current.find(s => s.nodeId === nodeId);
        if (toastIfUpdateBlocked(status)) return;

        await startLocalRestart(
            nodeId,
            `/fleet/nodes/${nodeId}/update`,
            updateRequestInit(status),
            'update',
            'Failed to trigger local update.',
        );
    }, [localUpdateConfirm, startLocalRestart]);

    const triggerNodeReapply = useCallback((nodeId: number) => {
        const status = updateStatusesRef.current.find(s => s.nodeId === nodeId);
        if (!status) {
            toast.error('Node status is unavailable. Recheck updates and try again.');
            return;
        }
        openReapplyConfirm({
            nodeId,
            type: status.type === 'local' ? 'local' : 'remote',
            name: status.name,
        });
    }, [openReapplyConfirm]);

    const triggerUpdateAll = useCallback(async () => {
        try {
            const res = await apiFetch('/fleet/update-all', { method: 'POST', localOnly: true });
            if (res.ok) {
                const data = await res.json() as {
                    updating?: string[];
                    failed?: Array<{ name: string; error: string }>;
                };
                const updating = data.updating ?? [];
                if (updating.length > 0) {
                    toast.success(`Update initiated on ${updating.length} node${updating.length > 1 ? 's' : ''}.`);
                } else {
                    toast.success('All nodes are up to date.');
                }
                if (data.failed?.length) {
                    toast.error(`Update could not start on ${data.failed.map(node => node.name).join(', ')}: ${data.failed[0].error}`);
                }
                fetchUpdateStatus();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(parseUpdateError(err, 'Failed to trigger fleet update.'));
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        }
    }, [fetchUpdateStatus]);

    const dismissNodeUpdate = useCallback(async (nodeId: number) => {
        try {
            await apiFetch(`/fleet/nodes/${nodeId}/update-status`, { method: 'DELETE', localOnly: true });
            fetchUpdateStatus();
        } catch (error) {
            console.error('[Fleet] Failed to dismiss update status:', error);
        }
    }, [fetchUpdateStatus]);

    const retryNodeUpdate = useCallback(async (nodeId: number) => {
        triggerNodeUpdate(nodeId);
    }, [triggerNodeUpdate]);

    const checkUpdates = useCallback(async () => {
        setShowUpdateModal(true);
        setCheckingUpdates(true);
        await fetchUpdateStatus();
        setCheckingUpdates(false);
    }, [fetchUpdateStatus]);

    // Version-update reconnect failure poll (reapply uses useComposeReapplyAction).
    useEffect(() => {
        if (!reconnecting) return;
        const poll = setInterval(async () => {
            try {
                const res = await apiFetch('/fleet/update-status', { localOnly: true });
                if (!res.ok) return;
                const data = await res.json();
                const nodes: NodeUpdateStatus[] = data.nodes ?? [];
                setUpdateStatuses(prev => JSON.stringify(prev) === JSON.stringify(nodes) ? prev : nodes);
                const local = nodes.find(s => s.type === 'local');
                if (local && (local.updateStatus === 'failed' || local.updateStatus === 'timeout')) {
                    setReconnecting(false);
                    setPreUpdateStartedAt(null);
                    toast.error(local.error || 'Local update failed. The server did not restart.');
                }
            } catch (error) {
                console.warn('[Fleet] Reconnect status poll failed:', error);
            }
        }, 3000);
        return () => clearInterval(poll);
    }, [reconnecting]);

    const reapplyConfirm = reapplyConfirmTarget?.nodeId ?? null;
    const setReapplyConfirm = useCallback((nodeId: number | null) => {
        if (nodeId === null) cancelReapplyConfirm();
    }, [cancelReapplyConfirm]);

    return {
        updateStatuses,
        updatingNodeId: updatingNodeId ?? reapplyBusyNodeId,
        // Prefer reapply reconnect when active so overlay mode stays correct.
        reconnecting: reconnecting || reapplyReconnecting,
        preUpdateStartedAt: reapplyReconnecting ? reapplyPreStartedAt : preUpdateStartedAt,
        reconnectMode: reapplyReconnecting ? 'reapply' as const : reconnectMode,
        localUpdateConfirm,
        reapplyConfirm,
        reapplyConfirmTarget,
        showUpdateModal,
        checkingUpdates,
        setShowUpdateModal,
        setLocalUpdateConfirm,
        setReapplyConfirm,
        fetchUpdateStatus,
        triggerNodeUpdate,
        confirmLocalUpdate,
        triggerNodeReapply,
        confirmReapply,
        triggerUpdateAll,
        dismissNodeUpdate,
        retryNodeUpdate,
        checkUpdates,
    };
}

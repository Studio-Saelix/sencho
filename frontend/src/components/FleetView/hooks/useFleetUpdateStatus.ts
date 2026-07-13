import { useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { isValidVersion } from '@/lib/version';
import { PINNED_UPDATE_BLOCKED_FALLBACK, type NodeUpdateStatus } from '../types';

/** POST body for an update trigger: forward the target release when it is a
 *  valid version so the receiving node can repin a semver pin to it; omit
 *  otherwise so the backend falls back to its compare target. */
function updateRequestInit(status: NodeUpdateStatus | undefined): RequestInit & { localOnly: true } {
    const base = { method: 'POST', localOnly: true } as const;
    return isValidVersion(status?.latestVersion)
        ? { ...base, body: JSON.stringify({ targetVersion: status!.latestVersion }) }
        : base;
}

function parseUpdateError(err: Record<string, unknown>, fallback: string): string {
    const nested = err?.data as Record<string, unknown> | undefined;
    const message = err?.message ?? err?.error ?? nested?.error;
    return typeof message === 'string' && message ? message : fallback;
}

function toastIfUpdateBlocked(status: NodeUpdateStatus | undefined): boolean {
    if (!status?.updateBlocked) return false;
    toast.error(status.updateBlockedReason ?? PINNED_UPDATE_BLOCKED_FALLBACK);
    return true;
}

export function useFleetUpdateStatus() {
    const [updateStatuses, setUpdateStatuses] = useState<NodeUpdateStatus[]>([]);
    const [updatingNodeId, setUpdatingNodeId] = useState<number | null>(null);
    const [reconnecting, setReconnecting] = useState(false);
    const [preUpdateStartedAt, setPreUpdateStartedAt] = useState<number | null>(null);
    const [localUpdateConfirm, setLocalUpdateConfirm] = useState<number | null>(null);
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

    const triggerNodeUpdate = useCallback(async (nodeId: number) => {
        const status = updateStatusesRef.current.find(s => s.nodeId === nodeId);
        // A pin we cannot repin (digest/unknown) has no update action; the button
        // is disabled upstream, but guard here so a stale click cannot POST.
        if (toastIfUpdateBlocked(status)) return;
        if (status?.type === 'local') {
            setLocalUpdateConfirm(nodeId);
            return;
        }

        setUpdatingNodeId(nodeId);
        try {
            const res = await apiFetch(`/fleet/nodes/${nodeId}/update`, updateRequestInit(status));
            if (res.ok) {
                toast.success(`Update initiated on ${status?.name ?? 'node'}.`);
                fetchUpdateStatus();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(parseUpdateError(err, 'Failed to trigger update.'));
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setUpdatingNodeId(null);
        }
    }, [fetchUpdateStatus]);

    const confirmLocalUpdate = useCallback(async () => {
        const nodeId = localUpdateConfirm;
        setLocalUpdateConfirm(null);
        if (!nodeId) return;
        const status = updateStatusesRef.current.find(s => s.nodeId === nodeId);
        if (toastIfUpdateBlocked(status)) return;

        setUpdatingNodeId(nodeId);
        try {
            // Capture pre-update boot timestamp so the overlay can detect a real restart
            // vs a false "online" response from the still-running old process mid-pull.
            let bootBefore: number | null = null;
            try {
                const healthRes = await fetch('/api/health');
                if (healthRes.ok) {
                    const data = await healthRes.json();
                    if (typeof data?.startedAt === 'number') bootBefore = data.startedAt;
                }
            } catch { /* fall back to offline-then-online detection */ }

            const res = await apiFetch(`/fleet/nodes/${nodeId}/update`, updateRequestInit(status));
            if (res.ok) {
                setPreUpdateStartedAt(bootBefore);
                setReconnecting(true);
            } else {
                // A blocked pin returns 409 fast (before any 202), so the overlay
                // never starts here; surface the reason through the toast path.
                const err = await res.json().catch(() => ({}));
                toast.error(parseUpdateError(err, 'Failed to trigger local update.'));
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setUpdatingNodeId(null);
        }
    }, [localUpdateConfirm]);

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

    // While the reconnect overlay is up, poll the local node's update status.
    // A pull/patch failure leaves the old gateway alive (no restart), so the
    // overlay's health poll would sit for the full 5-minute timeout. Detecting
    // the resolved `failed` status here dismisses the overlay fast and surfaces
    // the error, instead of leaving the operator on the spinner. A genuine
    // restart makes this endpoint unreachable (caught, keeps polling) and the
    // overlay's own health poll reloads the page on success.
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
                // Expected while the process restarts; the overlay's health poll
                // drives the reload on success.
                console.warn('[Fleet] Reconnect status poll failed:', error);
            }
        }, 3000);
        return () => clearInterval(poll);
    }, [reconnecting]);

    return {
        updateStatuses,
        updatingNodeId,
        reconnecting,
        preUpdateStartedAt,
        localUpdateConfirm,
        showUpdateModal,
        checkingUpdates,
        setShowUpdateModal,
        setLocalUpdateConfirm,
        fetchUpdateStatus,
        triggerNodeUpdate,
        confirmLocalUpdate,
        triggerUpdateAll,
        dismissNodeUpdate,
        retryNodeUpdate,
        checkUpdates,
    };
}

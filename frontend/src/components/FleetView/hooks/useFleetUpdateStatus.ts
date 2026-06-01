import { useState, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { NodeUpdateStatus } from '../types';

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
        if (status?.type === 'local') {
            setLocalUpdateConfirm(nodeId);
            return;
        }

        setUpdatingNodeId(nodeId);
        try {
            const res = await apiFetch(`/fleet/nodes/${nodeId}/update`, { method: 'POST', localOnly: true });
            if (res.ok) {
                toast.success(`Update initiated on ${status?.name ?? 'node'}.`);
                fetchUpdateStatus();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to trigger update.');
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

            const res = await apiFetch(`/fleet/nodes/${nodeId}/update`, { method: 'POST', localOnly: true });
            if (res.ok) {
                setPreUpdateStartedAt(bootBefore);
                setReconnecting(true);
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to trigger local update.');
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
                const data = await res.json();
                if (data.updating?.length > 0) {
                    toast.success(`Update initiated on ${data.updating.length} node${data.updating.length > 1 ? 's' : ''}.`);
                } else {
                    toast.success('All nodes are up to date.');
                }
                fetchUpdateStatus();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.message || err?.error || err?.data?.error || 'Failed to trigger fleet update.');
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

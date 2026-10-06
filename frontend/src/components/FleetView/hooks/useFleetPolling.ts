import { useEffect, useRef } from 'react';
import type { NodeUpdateStatus } from '../types';

interface UseFleetPollingOptions {
    fetchOverview: () => Promise<void> | void;
    fetchUpdateStatus: () => Promise<void> | void;
    updateStatuses: NodeUpdateStatus[];
}

const OVERVIEW_POLL_MS = 30_000;
const UPDATE_POLL_MS = 120_000;
// Interval timers drift a little; a tick this close to its period still counts as due.
const POLL_JITTER_MS = 1_000;

export function useFleetPolling({
    fetchOverview,
    fetchUpdateStatus,
    updateStatuses,
}: UseFleetPollingOptions): void {
    // Timestamps of the last fetch, so a tab coming back to the foreground
    // refreshes only what went stale while it was hidden.
    const lastOverviewAt = useRef(0);
    const lastUpdateAt = useRef(0);

    useEffect(() => {
        lastOverviewAt.current = Date.now();
        lastUpdateAt.current = Date.now();
        fetchOverview();
        fetchUpdateStatus();
    }, [fetchOverview, fetchUpdateStatus]);

    // Auto-refresh every 30s for overview, every 2 min for update status.
    // Ticks are skipped while the tab is hidden; it catches up on return.
    useEffect(() => {
        // A tick is skipped when something fetched moments ago (a catch-up on
        // return, the fast poll), so the two never double up.
        const due = (last: number, every: number) => Date.now() - last >= every - POLL_JITTER_MS;
        const overviewInterval = setInterval(() => {
            if (document.hidden || !due(lastOverviewAt.current, OVERVIEW_POLL_MS)) return;
            lastOverviewAt.current = Date.now();
            fetchOverview();
        }, OVERVIEW_POLL_MS);
        const updateInterval = setInterval(() => {
            if (document.hidden || !due(lastUpdateAt.current, UPDATE_POLL_MS)) return;
            lastUpdateAt.current = Date.now();
            fetchUpdateStatus();
        }, UPDATE_POLL_MS);
        const onVisible = () => {
            if (document.hidden) return;
            const now = Date.now();
            if (now - lastOverviewAt.current >= OVERVIEW_POLL_MS) {
                lastOverviewAt.current = now;
                fetchOverview();
            }
            if (now - lastUpdateAt.current >= UPDATE_POLL_MS) {
                lastUpdateAt.current = now;
                fetchUpdateStatus();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(overviewInterval);
            clearInterval(updateInterval);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [fetchOverview, fetchUpdateStatus]);

    // Fast poll (5s) when any node is actively updating. Uses ref to avoid interval thrashing.
    const hasUpdatingRef = useRef(false);
    useEffect(() => {
        hasUpdatingRef.current = updateStatuses.some(s => s.updateStatus === 'updating');
    }, [updateStatuses]);

    useEffect(() => {
        const id = setInterval(() => {
            if (hasUpdatingRef.current && !document.hidden) {
                lastOverviewAt.current = Date.now();
                lastUpdateAt.current = Date.now();
                fetchUpdateStatus();
                fetchOverview();
            }
        }, 5000);
        return () => clearInterval(id);
    }, [fetchUpdateStatus, fetchOverview]);
}

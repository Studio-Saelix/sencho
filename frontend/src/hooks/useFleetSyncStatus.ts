import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { visibilityInterval } from '@/lib/utils';
import { fetchFleetSyncStatuses, type FleetSyncStatus } from '@/lib/fleetSyncApi';

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Polls `/api/fleet/sync-status` and exposes the rows plus a manual
 * `refresh()`. Admin-only, matching the route's requireAdmin guard: non-admins
 * get an empty array instead of polling an endpoint that always 403s.
 */
export function useFleetSyncStatus(): {
  statuses: FleetSyncStatus[];
  loading: boolean;
  refresh: () => void;
} {
  const { isAdmin } = useAuth();
  // Latest eligibility for in-flight fetches: a request started while admin
  // must not publish rows after a mid-flight demotion already cleared state.
  const isAdminRef = useRef(isAdmin);
  isAdminRef.current = isAdmin;
  const [statuses, setStatuses] = useState<FleetSyncStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!isAdmin) {
      setStatuses([]);
      setLoading(false);
      return;
    }
    fetchFleetSyncStatuses()
      .then((rows) => { if (isAdminRef.current) setStatuses(rows); })
      .catch((err) => {
        // Stale data stays visible to avoid flicker; log so the failure isn't completely silent.
        console.warn('[FleetSync] sync-status fetch failed:', err);
      })
      .finally(() => { if (isAdminRef.current) setLoading(false); });
  }, [isAdmin]);

  useEffect(() => {
    refresh();
    if (!isAdmin) return undefined;
    return visibilityInterval(refresh, REFRESH_INTERVAL_MS);
  }, [isAdmin, refresh]);

  return { statuses, loading, refresh };
}

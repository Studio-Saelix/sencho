import { useCallback, useEffect, useRef, useState } from 'react';
import { useLicense } from '@/context/LicenseContext';
import { useAuth } from '@/context/AuthContext';
import { visibilityInterval } from '@/lib/utils';
import { fetchFleetSyncStatuses, type FleetSyncStatus } from '@/lib/fleetSyncApi';

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Polls `/api/fleet/sync-status` and exposes the rows plus a manual
 * `refresh()`. The endpoint requires a paid admin, so the hook only fetches
 * for paid admins and returns an empty array otherwise. This mirrors the
 * route guard exactly: gating on tier alone would leave a paid non-admin
 * polling an endpoint that always 403s.
 */
export function useFleetSyncStatus(): {
  statuses: FleetSyncStatus[];
  loading: boolean;
  refresh: () => void;
} {
  const { isPaid } = useLicense();
  const { isAdmin } = useAuth();
  const canQuery = isPaid && isAdmin;
  // Reflects the latest gate state so a fetch begun while eligible cannot
  // publish its rows after the user loses eligibility mid-flight (role or
  // tier change). Without this, a late resolve would re-populate statuses
  // that the gate-false path already cleared.
  const canQueryRef = useRef(canQuery);
  canQueryRef.current = canQuery;
  const [statuses, setStatuses] = useState<FleetSyncStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!canQuery) {
      setStatuses([]);
      setLoading(false);
      return;
    }
    fetchFleetSyncStatuses()
      .then((rows) => { if (canQueryRef.current) setStatuses(rows); })
      .catch((err) => {
        // Stale data stays visible to avoid flicker; log so the failure isn't completely silent.
        console.warn('[FleetSync] sync-status fetch failed:', err);
      })
      .finally(() => { if (canQueryRef.current) setLoading(false); });
  }, [canQuery]);

  useEffect(() => {
    refresh();
    if (!canQuery) return undefined;
    return visibilityInterval(refresh, REFRESH_INTERVAL_MS);
  }, [canQuery, refresh]);

  return { statuses, loading, refresh };
}

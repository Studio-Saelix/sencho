import { useCallback, useEffect, useState } from 'react';
import { useLicense } from '@/context/LicenseContext';
import { visibilityInterval } from '@/lib/utils';
import { fetchFleetSyncStatuses, type FleetSyncStatus } from '@/lib/fleetSyncApi';

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Polls `/api/fleet/sync-status` and exposes the rows plus a manual
 * `refresh()`. Skips fetching for community-tier users since the endpoint is
 * paid-tier-gated; the hook returns an empty array in that case so consumers
 * can render the `!isPaid` branch without conditionals.
 */
export function useFleetSyncStatus(): {
  statuses: FleetSyncStatus[];
  loading: boolean;
  refresh: () => void;
} {
  const { isPaid } = useLicense();
  const [statuses, setStatuses] = useState<FleetSyncStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!isPaid) {
      setStatuses([]);
      setLoading(false);
      return;
    }
    fetchFleetSyncStatuses()
      .then((rows) => setStatuses(rows))
      .catch((err) => {
        // Stale data stays visible to avoid flicker; log so the failure isn't completely silent.
        console.warn('[FleetSync] sync-status fetch failed:', err);
      })
      .finally(() => setLoading(false));
  }, [isPaid]);

  useEffect(() => {
    refresh();
    if (!isPaid) return undefined;
    return visibilityInterval(refresh, REFRESH_INTERVAL_MS);
  }, [isPaid, refresh]);

  return { statuses, loading, refresh };
}

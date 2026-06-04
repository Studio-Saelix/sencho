import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { useLicense } from '@/context/LicenseContext';
import { visibilityInterval } from '@/lib/utils';
import type { MeshDataPlaneStatus } from '@/types/mesh';

export interface MeshDataPlaneResult {
    status: MeshDataPlaneStatus | null;
    loading: boolean;
}

/**
 * Poll `/mesh/status` for the local data-plane health so dashboard surfaces
 * can flag a down mesh without opening the Routing tab. The endpoint is
 * paid-gated, so the hook short-circuits on the free tier (no request
 * fired, no banner rendered). On the rare 403 from a paid tier (token
 * race during downgrade) we leave `status` at null. 30 s cadence matches
 * `useFleetHeartbeat` so the dashboard refresh feel is consistent.
 */
export function useMeshDataPlane(): MeshDataPlaneResult {
    const { isPaid } = useLicense();
    const [status, setStatus] = useState<MeshDataPlaneStatus | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchStatus = useCallback(async () => {
        try {
            const res = await apiFetch('/mesh/status', { localOnly: true });
            if (res.status === 403) {
                setStatus(null);
                return;
            }
            if (!res.ok) return;
            const body = await res.json() as { localDataPlane?: MeshDataPlaneStatus };
            if (body.localDataPlane) setStatus(body.localDataPlane);
        } catch {
            // Background poll; transient network errors stay silent so the
            // card does not flicker on every refresh failure.
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!isPaid) {
            setStatus(null);
            setLoading(false);
            return;
        }
        void fetchStatus();
        return visibilityInterval(() => { void fetchStatus(); }, 30_000);
    }, [isPaid, fetchStatus]);

    return { status, loading };
}

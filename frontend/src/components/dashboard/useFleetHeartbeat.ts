import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { visibilityInterval } from '@/lib/utils';

export interface FleetNodeOverview {
  id: number;
  name: string;
  type: 'local' | 'remote';
  mode?: string;
  status: 'online' | 'offline' | 'unknown';
  stats: {
    active: number;
    managed: number;
    unmanaged: number;
    exited: number;
    total: number;
  } | null;
  latency_ms?: number;
  last_successful_contact?: number | null;
  pilot_last_seen?: number | null;
}

export interface FleetHeartbeatResult {
  nodes: FleetNodeOverview[];
  loading: boolean;
  error: string | null;
}

export function useFleetHeartbeat(): FleetHeartbeatResult {
  const [nodes, setNodes] = useState<FleetNodeOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await apiFetch('/fleet/overview', { localOnly: true });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to load fleet overview');
        return;
      }
      const data = await res.json() as FleetNodeOverview[];
      setNodes(data);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load fleet overview');
    } finally {
      setLoading(false);
    }
  }, []);

  // /fleet/overview is fleet-wide: the response is the same regardless of
  // which local node is active. Re-keying on activeNode would clear the
  // card to its skeleton state on every node switch and issue an extra
  // unnecessary fetch.
  useEffect(() => {
    void fetchOverview();
    return visibilityInterval(() => { void fetchOverview(); }, 30_000);
  }, [fetchOverview]);

  return { nodes, loading, error };
}

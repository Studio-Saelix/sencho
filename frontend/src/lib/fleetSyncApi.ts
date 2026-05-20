import { apiFetch } from '@/lib/api';

/** Wire shape of `GET /api/fleet/sync-status`. Mirrors backend `FleetSyncStatus`. */
export interface FleetSyncStatus {
  node_id: number;
  resource: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
  /** Non-null when retries are paused (today: 'CONTROL_IDENTITY_MISMATCH'). */
  sticky_error_code: string | null;
  /** Fingerprint the peer is anchored to (from 409 body); null when not applicable. */
  sticky_error_expected: string | null;
  /** Fingerprint this central pushed (from 409 body); null when not applicable. */
  sticky_error_got: string | null;
}

export const STICKY_CONTROL_IDENTITY_MISMATCH = 'CONTROL_IDENTITY_MISMATCH';

export async function fetchFleetSyncStatuses(): Promise<FleetSyncStatus[]> {
  const res = await apiFetch('/fleet/sync-status', { localOnly: true });
  if (!res.ok) {
    throw new Error(`Failed to fetch fleet sync status (HTTP ${res.status})`);
  }
  return (await res.json()) as FleetSyncStatus[];
}

/**
 * Proxy the peer's reanchor endpoint so the peer drops its cached control
 * fingerprint. Central clears every sticky-error row for the node on a 200,
 * so the next push (event-driven or via the 5-minute retry tick) re-tries
 * cleanly.
 */
export async function resetFleetSyncAnchor(nodeId: number): Promise<void> {
  const res = await apiFetch(`/nodes/${nodeId}/fleet-sync/reset-anchor`, {
    method: 'POST',
    localOnly: true,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Reset anchor failed (HTTP ${res.status})`);
  }
}

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { FleetReadinessResponse } from '@/types/readiness';

/** The server's own `{ error }` sentence when it sent one, else the fallback. */
async function serverErrorMessage(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return fallback;
}

export interface FleetReadinessState {
  data: FleetReadinessResponse | null;
  /** The last request's failure; shown beside the previous result when there is one. */
  error: string | null;
  /** True while a request is in flight, including a refresh over existing data. */
  checking: boolean;
  retry: () => void;
}

/**
 * Loads the hub's readiness aggregate.
 *
 * `refreshKey` lets the Fleet toolbar request a new check. Each request aborts
 * the one before it, so a slow earlier answer can never overwrite a newer one,
 * and a refresh keeps the previous result on screen until the new one lands.
 */
export function useFleetReadiness(refreshKey: number): FleetReadinessState {
  const [data, setData] = useState<FleetReadinessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${refreshKey}:${attempt}`;
  const [settledKey, setSettledKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        // Hub-owned aggregate: it answers for the whole fleet, so it is never
        // addressed to one node.
        const res = await apiFetch('/fleet/readiness', { localOnly: true, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          console.error('[FleetReadiness] request failed:', res.status);
          const message = await serverErrorMessage(res, 'The readiness check could not be completed.');
          if (controller.signal.aborted) return;
          setError(message);
        } else {
          setData(await res.json() as FleetReadinessResponse);
          setError(null);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        console.error('[FleetReadiness] request failed:', e);
        setError('The readiness check could not be reached.');
      }
      if (!controller.signal.aborted) setSettledKey(requestKey);
    };
    void load();
    return () => controller.abort();
  }, [requestKey]);

  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { data, error, checking: settledKey !== requestKey, retry };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { FleetDependencyMap } from '@/lib/dependency-map-layout';

/** A map older than this is re-fetched when the Map tab is reopened. */
export const MAP_STALE_MS = 60_000;

export interface FleetMapState {
  data: FleetDependencyMap | null;
  /** True while a request is in flight, including a background revalidation. */
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The fleet dependency map, owned by the Fleet shell so a return to the Map tab
 * shows the last result immediately and revalidates it in the background
 * instead of blanking behind a fresh load. Fetches the first time the tab is
 * opened, and again on reopening once the result is older than `MAP_STALE_MS`
 * or the last attempt failed.
 */
export function useFleetMap(active: boolean): FleetMapState {
  const [data, setData] = useState<FleetDependencyMap | null>(null);
  // Starts true when the tab opens onto an empty map, so the first commit is
  // already a loading state rather than a blank frame.
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadedAtRef = useRef<number | null>(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/fleet/dependency-map', { localOnly: true, signal: controller.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      setData(await res.json() as FleetDependencyMap);
      loadedAtRef.current = Date.now();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : 'Failed to load dependency map';
      setError(message);
      toast.error(`Failed to load dependency map: ${message}`);
    } finally {
      // A replaced call leaves the flag to the newer one.
      if (abortRef.current === controller) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  // Only a change of `active` may start a load; the live state is read through
  // refs so it never has to sit in the dependency array.
  const errorRef = useRef<string | null>(null);
  useEffect(() => { errorRef.current = error; });
  useEffect(() => {
    if (!active) return;
    // A request that was aborted (unmount, StrictMode replay) is not in flight.
    if (loadingRef.current && abortRef.current?.signal.aborted === false) return;
    const stale = loadedAtRef.current === null || Date.now() - loadedAtRef.current > MAP_STALE_MS;
    if (stale || errorRef.current !== null) void load();
  }, [active, load]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const refresh = useCallback(() => { void load(); }, [load]);

  return { data, loading, error, refresh };
}

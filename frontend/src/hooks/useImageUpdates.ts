import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import type { ImageUpdateStatus, StackUpdateInfo } from '@/types/imageUpdates';

const IMAGE_UPDATE_POLL_MS = 5 * 60 * 1000;

/**
 * Owns the stack-image-update state and its 5-minute background poll.
 * Re-fetches whenever `activeNodeId` changes; consumers can also call
 * `refresh()` to force a refetch (e.g. after a deploy or a manual
 * registry-check trigger).
 *
 * Also owns the sidebar-indicator toggle preference, fetched from
 * /api/image-updates/status on the same cadence. All requests are
 * pinned to the captured node so a mid-flight node switch never
 * writes stale data.
 */
export function useImageUpdates(activeNodeId: number | undefined) {
  const [stackUpdates, setStackUpdates] = useState<Record<string, StackUpdateInfo>>({});
  const [sidebarIndicators, setSidebarIndicators] = useState(false);

  // Generation counter: every activeNodeId change increments it, and every
  // await is gated against it so a slow response from a previous node is
  // discarded.
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    const targetNodeId = activeNodeId ?? null;

    // Self-contained status helper: owns fetch, parse, and state write.
    // A failure here never blocks the detail path below.
    const fetchStatus = async (): Promise<void> => {
      try {
        const res = await apiFetch('/image-updates/status', { nodeId: targetNodeId });
        if (genRef.current !== gen) return;
        if (res.ok) {
          const data = await res.json() as ImageUpdateStatus;
          if (genRef.current !== gen) return;
          setSidebarIndicators(data.sidebarIndicators ?? false);
        } else {
          console.error('[ImageUpdates] status fetch returned', res.status);
        }
      } catch (e) {
        console.error('[ImageUpdates] status fetch failed:', e);
      }
    };

    // Self-contained detail helper: owns fetch, parse, 404 fallback, and
    // state write. A failure here never blocks the status path above.
    const fetchDetail = async (): Promise<void> => {
      try {
        const res = await apiFetch('/image-updates/detail', { nodeId: targetNodeId });
        if (genRef.current !== gen) return;
        if (res.ok) {
          const data = await res.json() as Record<string, StackUpdateInfo>;
          if (genRef.current !== gen) return;
          setStackUpdates(data);
          return;
        }
        // A remote node on an older Sencho lacks /detail; fall back to the boolean
        // map so update badges keep working until that node is upgraded.
        if (res.status === 404) {
          const boolRes = await apiFetch('/image-updates', { nodeId: targetNodeId });
          if (genRef.current !== gen) return;
          if (boolRes.ok) {
            const bool = await boolRes.json() as Record<string, boolean>;
            if (genRef.current !== gen) return;
            const synthesized: Record<string, StackUpdateInfo> = {};
            for (const [stack, hasUpdate] of Object.entries(bool)) {
              synthesized[stack] = { hasUpdate, checkStatus: 'ok', lastError: null, checkedAt: 0 };
            }
            setStackUpdates(synthesized);
          } else {
            console.error('[ImageUpdates] /detail 404 fallback to /image-updates failed:', boolRes.status);
          }
          return;
        }
        // Any other non-ok (500, or a proxy 5xx from an unreachable remote): keep
        // the last-known state on screen, but do not let the failure go silent.
        console.error('[ImageUpdates] /image-updates/detail returned', res.status);
      } catch (e: unknown) {
        console.error('[ImageUpdates] fetch failed:', e);
      }
    };

    await Promise.allSettled([fetchStatus(), fetchDetail()]);
  }, [activeNodeId]);

  // Pin the interval to the latest closure without retriggering it on
  // every render the way putting `refresh` into the deps array would.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Poll on mount and on node change. Reset state BEFORE fetching so the
  // old node's data is cleared before the new node's first response arrives.
  useEffect(() => {
    genRef.current += 1;
    setStackUpdates({});          // eslint-disable-line react-hooks/set-state-in-effect
    setSidebarIndicators(false);  // eslint-disable-line react-hooks/set-state-in-effect
    void refreshRef.current();
    const id = setInterval(() => { void refreshRef.current(); }, IMAGE_UPDATE_POLL_MS);
    return () => clearInterval(id);
  }, [activeNodeId]);

  // React to settings changes so toggling the sidebar-indicator preference
  // propagates immediately without waiting for the 5-minute poll.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ changedKeys?: string[] }>).detail;
      if (detail?.changedKeys?.includes('image_update_sidebar_indicators')) {
        refreshRef.current();
      }
    };
    window.addEventListener(SENCHO_SETTINGS_CHANGED, handler);
    return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, handler);
  }, []);

  return { stackUpdates, refresh, sidebarIndicators };
}

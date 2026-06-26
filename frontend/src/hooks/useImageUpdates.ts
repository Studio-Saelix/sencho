import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import type { StackUpdateInfo } from '@/types/imageUpdates';

const IMAGE_UPDATE_POLL_MS = 5 * 60 * 1000;

/**
 * Owns the stack-image-update state and its 5-minute background poll.
 * Re-fetches whenever `activeNodeId` changes; consumers can also call
 * `refresh()` to force a refetch (e.g. after a deploy or a manual
 * registry-check trigger).
 *
 * Extracted from EditorLayout so the polling lifecycle and its state
 * live next to each other instead of being spread across a 3000-line
 * component. The dependency on `apiFetch` keeps the call routed
 * through the active-node header just like before.
 */
export function useImageUpdates(activeNodeId: number | undefined) {
  const [stackUpdates, setStackUpdates] = useState<Record<string, StackUpdateInfo>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/image-updates/detail');
      if (res.ok) {
        setStackUpdates(await res.json() as Record<string, StackUpdateInfo>);
        return;
      }
      // A remote node on an older Sencho lacks /detail; fall back to the boolean
      // map so update badges keep working until that node is upgraded.
      if (res.status === 404) {
        const boolRes = await apiFetch('/image-updates');
        if (boolRes.ok) {
          const bool = await boolRes.json() as Record<string, boolean>;
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
  }, []);

  // Pin the interval to the latest closure without retriggering it on
  // every render the way putting `refresh` into the deps array would.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refreshRef.current();
    const id = setInterval(() => { void refreshRef.current(); }, IMAGE_UPDATE_POLL_MS);
    return () => clearInterval(id);
  }, [activeNodeId]);

  return { stackUpdates, refresh };
}

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import type { SenchoSettingsChangedDetail } from '@/lib/events';

/**
 * Reads the active node's `developer_mode` setting, race-safe against node
 * switches (mirrors the ownership pattern in `useImageUpdates`).
 *
 * The setting is node-scoped: `/settings` is proxied to whichever node is
 * active, so a mid-flight switch must never let node A's response flip the
 * result for node B. A generation counter discards stale responses, and an
 * owner check returns `false` on the render before the reset effect fires.
 *
 * Any failure (network, non-ok, parse) resolves to `false` so the developer
 * overlay stays hidden rather than flickering on a transient error.
 */
export function useDeveloperMode(activeNodeId: number | undefined): boolean {
  const [enabled, setEnabled] = useState(false);

  // Which node owns the current `enabled` value. When `activeNodeId` changes,
  // React renders once with the old owner before the reset effect clears it;
  // returning false on a mismatch avoids a one-frame flash of the wrong node's
  // developer state.
  const [ownerNodeId, setOwnerNodeId] = useState<number | undefined>(activeNodeId);

  // Every node change increments this, and every await is gated against it so a
  // slow response from a previous node is dropped.
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    const targetNodeId = activeNodeId ?? null;
    try {
      const res = await apiFetch('/settings', { nodeId: targetNodeId });
      if (genRef.current !== gen) return;
      if (!res.ok) {
        console.error('[DeveloperMode] settings fetch returned', res.status);
        setEnabled(false);
        return;
      }
      const data = (await res.json()) as Record<string, string>;
      if (genRef.current !== gen) return;
      setEnabled(data.developer_mode === '1');
    } catch (e) {
      if (genRef.current !== gen) return;
      console.error('[DeveloperMode] settings fetch failed:', e);
      setEnabled(false);
    }
  }, [activeNodeId]);

  // Pin the settings-event handler to the latest closure without retriggering
  // the listener effect on every render.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Reset and refetch on mount and on node change. Capture the owning node and
  // clear the flag BEFORE fetching so the guard returns false until the new
  // node's response arrives.
  useEffect(() => {
    genRef.current += 1;
    setEnabled(false); // eslint-disable-line react-hooks/set-state-in-effect
    setOwnerNodeId(activeNodeId); // eslint-disable-line react-hooks/set-state-in-effect
    void refreshRef.current();
  }, [activeNodeId]);

  // Propagate a developer-mode toggle immediately. Refetch when the change set
  // names developer_mode, or when the detail is missing (unknown change set).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Partial<SenchoSettingsChangedDetail>>).detail;
      if (!detail?.changedKeys || detail.changedKeys.includes('developer_mode')) {
        void refreshRef.current();
      }
    };
    window.addEventListener(SENCHO_SETTINGS_CHANGED, handler);
    return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, handler);
  }, []);

  const isOwner = activeNodeId !== undefined && activeNodeId === ownerNodeId;
  return isOwner ? enabled : false;
}

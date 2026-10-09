import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useFindingDismissal } from '@/hooks/useFindingDismissal';
import type { DismissalSurface, FindingDismissal } from '@/types/findingDismissal';

/**
 * The team's dismissals on one surface for one node, and the handler that makes
 * and undoes them. The list is hub-held, so it is read from this instance
 * whatever node is active, and a failed read leaves findings listed rather than hidden.
 * Surfaces whose evidence the hub cannot read send the severity they saw.
 */
export function useNodeDismissals(
  surface: Extract<DismissalSurface, 'networking' | 'security'>,
  nodeId: number | undefined,
  reloadKey: number,
  onGone: () => void,
) {
  const [loaded, setLoaded] = useState<{ nodeId: number; list: FindingDismissal[] } | null>(null);
  // A list read for another node is never shown; a failed re-read keeps this node's last list.
  const dismissals = loaded !== null && loaded.nodeId === nodeId ? loaded.list : [];
  const setDismissals = useCallback((update: (current: FindingDismissal[]) => FindingDismissal[]) => {
    setLoaded(current => (nodeId === undefined ? current : { nodeId, list: update(current !== null && current.nodeId === nodeId ? current.list : []) }));
  }, [nodeId]);

  useEffect(() => {
    if (nodeId === undefined) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await apiFetch(`/fleet/dismissals/${surface}?nodeId=${nodeId}`, { localOnly: true, signal: controller.signal });
        if (!res.ok) {
          console.error(`[${surface}] dismissals read refused:`, res.status);
          toast.error('Dismissed findings could not be loaded. Showing the last list read.');
          return;
        }
        const body: unknown = await res.json();
        const list = typeof body === 'object' && body !== null && 'dismissals' in body ? (body as { dismissals: unknown }).dismissals : null;
        if (!Array.isArray(list)) {
          console.error(`[${surface}] dismissals read returned an unreadable body`);
          toast.error('Dismissed findings could not be loaded. Showing the last list read.');
          return;
        }
        setLoaded({ nodeId, list: list as FindingDismissal[] });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error(`[${surface}] dismissals read failed:`, error);
        toast.error('Dismissed findings could not be loaded. Showing the last list read.');
      }
    };
    void load();
    return () => controller.abort();
  }, [surface, nodeId, reloadKey]);

  const upsert = useCallback((dismissal: FindingDismissal) => {
    setDismissals(current => [...current.filter(item => item.id !== dismissal.id && item.findingKey !== dismissal.findingKey), dismissal]);
  }, [setDismissals]);
  const remove = useCallback((id: number) => {
    setDismissals(current => current.filter(item => item.id !== id));
  }, [setDismissals]);
  const handler = useFindingDismissal({ surface, sendSeverity: true, onUpsert: upsert, onRemove: remove, onGone });

  return { dismissals, ...handler };
}

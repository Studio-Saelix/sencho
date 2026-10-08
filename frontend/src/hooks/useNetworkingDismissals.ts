import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useFindingDismissal } from '@/hooks/useFindingDismissal';
import type { FindingDismissal } from '@/types/findingDismissal';

/**
 * The team's networking dismissals for one node, and the handler that makes and
 * undoes them. The list is hub-held, so it is read from this instance whatever
 * node is active, and a failed read leaves findings listed rather than hidden.
 */
export function useNetworkingDismissals(nodeId: number | undefined, reloadKey: number, onGone: () => void) {
  const [dismissals, setDismissals] = useState<FindingDismissal[]>([]);

  useEffect(() => {
    if (nodeId === undefined) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await apiFetch(`/fleet/dismissals/networking?nodeId=${nodeId}`, { localOnly: true, signal: controller.signal });
        if (!res.ok) {
          console.error('[Networking] dismissals read refused:', res.status);
          setDismissals([]);
          return;
        }
        const body: unknown = await res.json();
        const list = typeof body === 'object' && body !== null && 'dismissals' in body ? (body as { dismissals: unknown }).dismissals : null;
        setDismissals(Array.isArray(list) ? list as FindingDismissal[] : []);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('[Networking] dismissals read failed:', error);
        setDismissals([]);
      }
    };
    void load();
    return () => controller.abort();
  }, [nodeId, reloadKey]);

  const upsert = useCallback((dismissal: FindingDismissal) => {
    setDismissals(current => [...current.filter(item => item.id !== dismissal.id && item.findingKey !== dismissal.findingKey), dismissal]);
  }, []);
  const remove = useCallback((id: number) => {
    setDismissals(current => current.filter(item => item.id !== id));
  }, []);
  const handler = useFindingDismissal({ surface: 'networking', sendSeverity: true, onUpsert: upsert, onRemove: remove, onGone });

  return { dismissals, ...handler };
}

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

/** One live fact for an Actions row. `unavailable` rows render no hint at all. */
export type ActionHint =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; text: string };

interface EstimateResponse {
  totalBytes: number;
  perNode: Array<{ partial?: boolean }>;
}

function isEstimate(value: unknown): value is EstimateResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.totalBytes === 'number' && Array.isArray(v.perNode);
}

/**
 * The hint on the Reclaim row: what a prune would free (images, Sencho-owned, the
 * sheet's default). The estimate endpoint is admin-only, so a non-admin session
 * never asks and the row carries no hint.
 */
export function useFleetActionHints(isAdmin: boolean) {
  const [reclaim, setReclaim] = useState<ActionHint>(isAdmin ? { kind: 'loading' } : { kind: 'unavailable' });
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    async function loadReclaim() {
      try {
        const response = await apiFetch('/fleet/prune/estimate', {
          method: 'POST',
          body: JSON.stringify({ targets: ['images'], scope: 'managed' }),
        });
        const data = response.ok ? await response.json().catch(() => null) : null;
        if (cancelled) return;
        if (!isEstimate(data)) {
          setReclaim({ kind: 'unavailable' });
          return;
        }
        const partial = data.perNode.some((node) => node.partial) ? ' · partial' : '';
        const text = data.totalBytes === 0 ? `nothing to reclaim${partial}` : `~${formatBytes(data.totalBytes)} of images${partial}`;
        setReclaim({ kind: 'ready', text });
      } catch (error) {
        console.error('Failed to estimate fleet prune', error);
        if (!cancelled) setReclaim({ kind: 'unavailable' });
      }
    }
    loadReclaim();
    return () => { cancelled = true; };
  }, [isAdmin, epoch]);

  const refreshReclaim = useCallback(() => setEpoch((value) => value + 1), []);
  return { reclaim, refreshReclaim };
}

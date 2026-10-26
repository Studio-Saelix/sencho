import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { plural } from '@/lib/blueprintTargets';
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
 * The hints on the Actions list: what a Reclaim would free (images, Sencho-owned,
 * the sheet's default) and how many stack labels exist. Both endpoints are
 * admin-only, so a non-admin session never asks and the rows simply carry no hint.
 */
export function useFleetActionHints(isAdmin: boolean) {
  const [reclaim, setReclaim] = useState<ActionHint>(isAdmin ? { kind: 'loading' } : { kind: 'unavailable' });
  const [labels, setLabels] = useState<ActionHint>(isAdmin ? { kind: 'loading' } : { kind: 'unavailable' });
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

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    async function loadLabels() {
      try {
        const response = await apiFetch('/fleet/labels/suggestions');
        const data = response.ok ? await response.json().catch(() => null) : null;
        if (cancelled) return;
        if (!Array.isArray(data?.suggestions)) {
          setLabels({ kind: 'unavailable' });
          return;
        }
        const count = data.suggestions.length;
        setLabels({ kind: 'ready', text: count === 0 ? 'no labels yet' : plural(count, 'label') });
      } catch (error) {
        console.error('Failed to load stack labels', error);
        if (!cancelled) setLabels({ kind: 'unavailable' });
      }
    }
    loadLabels();
    return () => { cancelled = true; };
  }, [isAdmin]);

  const refreshReclaim = useCallback(() => setEpoch((value) => value + 1), []);
  return { reclaim, labels, refreshReclaim };
}

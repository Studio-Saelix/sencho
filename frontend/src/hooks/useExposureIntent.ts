import { useCallback, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { ExposureIntent } from '@/types/networking';

/** One saved intent: `service` is '' for the stack-wide row. */
export interface IntentEntry { service: string; intent: ExposureIntent }

/** Defensively read the intents array from an exposure response body; null when the body is not shaped like one. */
export function asIntents(body: unknown): IntentEntry[] | null {
  const list = (body as { intents?: unknown } | null)?.intents;
  return Array.isArray(list) ? (list as IntentEntry[]) : null;
}

async function serverError(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && body.error !== '' ? body.error : fallback;
}

/** Saves one scope's intent (null clears it). Returns the stack's intents after the save, or null when it failed. */
export async function saveExposureIntent(
  stackName: string,
  service: string,
  intent: ExposureIntent | null,
  nodeId?: number,
): Promise<IntentEntry[] | null> {
  try {
    const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/exposure`, {
      method: 'PUT',
      nodeId,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, intent }),
    });
    if (!res.ok) {
      console.error('[ExposureIntent] save refused:', res.status);
      toast.error(await serverError(res, 'Failed to save the exposure intent.'));
      return null;
    }
    const intents = asIntents(await res.json());
    if (intents === null) toast.error('The exposure intent was sent, but the reply was unreadable. Refresh to confirm.');
    return intents;
  } catch (error) {
    console.error('[ExposureIntent] save failed:', error);
    toast.error('Failed to save the exposure intent.');
    return null;
  }
}

/**
 * Reads and saves one stack's exposure intents for the node it is addressed to.
 * The Networking findings popover and the stack networking panel save through
 * the same request, so a verb on a finding and the panel cannot disagree.
 */
export function useExposureIntent(stackName: string, nodeId?: number) {
  const [intents, setIntents] = useState<IntentEntry[] | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/exposure`, { nodeId });
      if (!res.ok) {
        console.error('[ExposureIntent] load refused:', res.status);
        toast.error(await serverError(res, 'Failed to load the exposure intent.'));
        return;
      }
      const next = asIntents(await res.json());
      if (next === null) toast.error('Failed to load the exposure intent.');
      else setIntents(next);
    } catch (error) {
      console.error('[ExposureIntent] load failed:', error);
      toast.error('Failed to load the exposure intent.');
    }
  }, [stackName, nodeId]);

  const save = useCallback(async (service: string, intent: ExposureIntent | null): Promise<boolean> => {
    setSaving(true);
    try {
      const next = await saveExposureIntent(stackName, service, intent, nodeId);
      if (next === null) return false;
      setIntents(next);
      return true;
    } finally {
      setSaving(false);
    }
  }, [stackName, nodeId]);

  return { intents, saving, load, save };
}

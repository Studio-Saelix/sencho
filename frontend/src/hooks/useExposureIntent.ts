import { useCallback, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { ExposureIntent } from '@/types/networking';

/** One saved intent: `service` is '' for the stack-wide row. */
export interface IntentEntry { service: string; intent: ExposureIntent }

/** Defensively read the intents array from an exposure response body. */
export function asIntents(body: unknown): IntentEntry[] {
  const list = (body as { intents?: unknown })?.intents;
  return Array.isArray(list) ? (list as IntentEntry[]) : [];
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
      toast.error('Failed to save the exposure intent.');
      return null;
    }
    return asIntents(await res.json());
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
        toast.error('Failed to load the exposure intent.');
        return;
      }
      setIntents(asIntents(await res.json()));
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

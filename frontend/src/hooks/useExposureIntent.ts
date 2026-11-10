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

/** How long a save may wait for its reply before it counts as timed out (not confirmed) and the saves behind it go ahead. */
const SAVE_TIMEOUT_MS = 30_000;

/** The tail of each node and stack's chain of saves, so the next one knows what to wait for. */
const saveChains = new Map<string, Promise<void>>();

/**
 * Runs saves to one stack of one node one after another, in the order they were
 * asked for. Each save replies with the stack's rows as the server held them when
 * it applied that save, and a client cannot tell which of two overlapping replies
 * is newer: the requests can be applied in a different order from the one they
 * were sent in. Sending the next only once the last has replied makes the
 * order they were sent the order they were applied, so every reply holds the
 * rows of the saves before it and a later reply is always the newer one. A save
 * that fails, or whose reply does not come within `SAVE_TIMEOUT_MS`, does not
 * hold up the ones behind it here. Abandoning a save's request does not stop the
 * node working on it, so a timed-out save may still be applied later. A node on
 * this version applies saves to a stack in the order they reach it, so a save it
 * has received is applied before the saves sent after it, and a later save waits
 * behind it there if it is stalled.
 */
function inOrder<T>(key: string, run: () => Promise<T>): Promise<T> {
  const turn = (saveChains.get(key) ?? Promise.resolve()).then(run);
  const tail = turn.then(() => undefined, () => undefined);
  saveChains.set(key, tail);
  void tail.then(() => {
    if (saveChains.get(key) === tail) saveChains.delete(key);
  });
  return turn;
}

async function serverError(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && body.error !== '' ? body.error : fallback;
}

async function putExposureIntent(
  stackName: string,
  service: string,
  intent: ExposureIntent | null,
  nodeId?: number,
): Promise<IntentEntry[] | null> {
  // A request that never settles would hold every later save to this stack behind it. The abort
  // only frees this browser: the node may still apply the save, ahead of any save it receives after it.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SAVE_TIMEOUT_MS);
  try {
    const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/exposure`, {
      method: 'PUT',
      nodeId,
      signal: abort.signal,
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
    toast.error(abort.signal.aborted
      ? 'Saving the exposure intent timed out. Refresh to confirm.'
      : 'Failed to save the exposure intent.');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Saves one scope's intent (null clears it). Returns the stack's intents after the
 * save, or null when it failed, timed out or its reply could not be read. Saves to the same
 * stack of the same node (callers pass the node they address) are sent one at a
 * time, in the order they were asked for, whichever surface asks, so a reply
 * holds the result of every save made here before it.
 */
export function saveExposureIntent(
  stackName: string,
  service: string,
  intent: ExposureIntent | null,
  nodeId?: number,
): Promise<IntentEntry[] | null> {
  return inOrder(`${nodeId ?? ''}\0${stackName}`, () => putExposureIntent(stackName, service, intent, nodeId));
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

  const save = useCallback(async (service: string, intent: ExposureIntent | null): Promise<IntentEntry[] | null> => {
    setSaving(true);
    try {
      const next = await saveExposureIntent(stackName, service, intent, nodeId);
      if (next === null) return null;
      setIntents(next);
      return next;
    } finally {
      setSaving(false);
    }
  }, [stackName, nodeId]);

  return { intents, saving, load, save };
}

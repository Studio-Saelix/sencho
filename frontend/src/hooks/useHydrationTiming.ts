import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, listVisibleMsFrom } from '@/lib/hydrationTiming';
import type { HydrationSnapshot } from '@/lib/hydrationTiming';

export interface UseHydrationTiming {
  snapshot: HydrationSnapshot;
  /** Elapsed ms from boot to `list_visible`, or null before it commits. */
  listVisibleMs: number | null;
}

/** Subscribe to the hydration timing store and expose the current snapshot
 *  plus the derived `list_visible` elapsed time for the collapsed chip.
 *  Derives from the snapshot React last read so the chip stays consistent
 *  with the events on screen, not a later live store mutation. */
export function useHydrationTiming(): UseHydrationTiming {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    snapshot,
    listVisibleMs: listVisibleMsFrom(snapshot.events, snapshot.bootStartAt),
  };
}

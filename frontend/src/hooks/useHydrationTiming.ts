import { useSyncExternalStore } from 'react';
import {
  subscribe,
  getSnapshot,
  getAttemptListVisibleMsFrom,
  getSessionListVisibleMsFrom,
} from '@/lib/hydrationTiming';
import type { HydrationSnapshot } from '@/lib/hydrationTiming';

/** Chip readout: the foreground list hydration latency plus the anchor it was
 *  resolved against. The union keeps `listAnchor` non-null exactly when
 *  `listVisibleMs` is non-null. */
type ListReadout =
  | { listVisibleMs: number; listAnchor: 'attempt' | 'session' }
  | { listVisibleMs: null; listAnchor: null };

type UseHydrationTiming = { snapshot: HydrationSnapshot } & ListReadout;

/** Derive the chip readout from the snapshot React last read, not live store
 *  state, so the chip stays consistent with the events on screen. */
function deriveListReadout(snapshot: HydrationSnapshot): ListReadout {
  const foreground = snapshot.lastAttempt;
  if (foreground != null) {
    const attemptMs = getAttemptListVisibleMsFrom(
      snapshot.events,
      foreground.attemptId,
      foreground.createdAt,
    );
    if (attemptMs != null) return { listVisibleMs: attemptMs, listAnchor: 'attempt' };
  }
  const sessionMs = getSessionListVisibleMsFrom(
    snapshot.events,
    snapshot.nodeSessionId,
    snapshot.nodeSessionStartAt,
  );
  return sessionMs == null
    ? { listVisibleMs: null, listAnchor: null }
    : { listVisibleMs: sessionMs, listAnchor: 'session' };
}

/** Subscribe to the hydration timing store and expose the current snapshot
 *  plus the derived foreground `list_visible` elapsed time for the collapsed
 *  chip: attempt-relative when a foreground attempt exists, otherwise
 *  session-relative, never boot-relative, so a node switch minutes after boot
 *  cannot present page age as hydration time. */
export function useHydrationTiming(): UseHydrationTiming {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { snapshot, ...deriveListReadout(snapshot) };
}

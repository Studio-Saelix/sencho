import { useCallback, useRef } from 'react';
import { applyNavigateEvent } from '../mobile-surface';

/**
 * What a navigate event does to the phone surface, split in two because the shell
 * needs the event handler before the surface helpers it depends on exist.
 *
 * `onNavigateEvent` is handed to the navigation state up front. `connect` is
 * called on every render once `isMobile` and the surface hop are known, so the
 * handler never runs against a stale layout. Until it is connected the change
 * applies directly, which is also what a desktop does.
 */
export function useNavigateEventSurface() {
  const handlerRef = useRef<(apply: () => void) => void>((apply) => apply());

  const onNavigateEvent = useCallback((apply: () => void) => handlerRef.current(apply), []);

  const connect = (isMobile: boolean, leaveToContentSurface: (then: () => void) => void) => {
    handlerRef.current = (apply) => applyNavigateEvent(isMobile, leaveToContentSurface, apply);
  };

  return { onNavigateEvent, connect };
}

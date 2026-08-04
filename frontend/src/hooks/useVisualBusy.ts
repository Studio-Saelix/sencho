import { useEffect, useState } from 'react';

/**
 * Keep in sync with `--duration-base` in `frontend/src/index.css`.
 * Default gate before showing delayed busy chrome (spinner / progressive label).
 */
export const DURATION_BASE_MS = 220;

/**
 * Split interaction lock from delayed visual busy so fast ops never flash chrome.
 *
 * - `locked` tracks the raw `pending` flag (caller uses this to disable controls).
 * - `showBusy` becomes true only after `pending` stays true for `delayMs`.
 */
export function useVisualBusy(
  pending: boolean,
  delayMs: number = DURATION_BASE_MS,
): { locked: boolean; showBusy: boolean } {
  const [showBusy, setShowBusy] = useState(false);

  useEffect(() => {
    if (!pending) {
      setShowBusy(false);
      return;
    }
    setShowBusy(false);
    const id = window.setTimeout(() => {
      setShowBusy(true);
    }, delayMs);
    return () => {
      window.clearTimeout(id);
    };
  }, [pending, delayMs]);

  return { locked: pending, showBusy };
}

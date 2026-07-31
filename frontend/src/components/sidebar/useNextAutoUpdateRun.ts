import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import type { ScheduledTask } from '@/types/scheduling';

const POLL_INTERVAL_MS = 60_000;
const INVALIDATE_DEBOUNCE_MS = 250;

async function fetchNextRun(signal: AbortSignal): Promise<number | null> {
  const res = await apiFetch('/scheduled-tasks?action=update', { localOnly: true, signal });
  if (!res.ok) return null;
  const tasks = (await res.json()) as ScheduledTask[];
  let earliest: number | null = null;
  for (const t of tasks) {
    if (!t.enabled) continue;
    if (t.next_run_at == null) continue;
    if (earliest == null || t.next_run_at < earliest) earliest = t.next_run_at;
  }
  return earliest;
}

export function useNextAutoUpdateRun(): number | null {
  const { isAdmin } = useAuth();
  const [nextRunAt, setNextRunAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // This indicator is shown fleet-wide in the sidebar regardless of the active
    // view; gating to admin avoids showing a partial "next auto-update run" to a
    // role with only scoped permissions. Revisit when scoped roles are extended
    // to this indicator.
    if (!isAdmin) {
      setNextRunAt(null); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    let active = true;
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;

    const run = () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      fetchNextRun(ctrl.signal)
        .then((v) => { if (active) setNextRunAt(v); })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          console.error('[useNextAutoUpdateRun] fetch failed:', err);
        });
    };

    run();

    const onInvalidate = (e: Event) => {
      const detail = (e as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope !== 'scheduled-tasks') return;
      if (invalidateTimer) clearTimeout(invalidateTimer);
      invalidateTimer = setTimeout(() => { invalidateTimer = null; run(); }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);

    const interval = setInterval(run, POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (invalidateTimer) clearTimeout(invalidateTimer);
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [isAdmin]);

  return nextRunAt;
}

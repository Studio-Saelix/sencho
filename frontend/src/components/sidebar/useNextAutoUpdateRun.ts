import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
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
  const [nextRunAt, setNextRunAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
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
      const detail = (e as CustomEvent<{ action?: string; scope?: string }>).detail;
      if (detail?.action !== 'auto-update-settings-changed' && detail?.scope !== 'scheduled-tasks') return;
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
  }, []);

  return nextRunAt;
}

import { useCallback, useEffect, useState } from 'react';
import { Copy, Timer, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast-store';
import { useHydrationTiming } from '@/hooks/useHydrationTiming';
import { clearReport, getHydrationReport } from '@/lib/hydrationTiming';
import type { HydrationOutcome } from '@/lib/hydrationTiming';

/** Format an elapsed duration compactly: seconds with one decimal at or above
 *  1s, whole milliseconds below. */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatOffset(ms: number | null): string {
  return ms == null ? '-' : formatMs(ms);
}

function outcomeDotClass(outcome: HydrationOutcome | undefined, critical: boolean): string {
  if (outcome === 'error') return 'bg-destructive';
  if (outcome === 'aborted' || outcome === 'superseded') return 'bg-muted-foreground';
  return critical ? 'bg-brand' : 'bg-success';
}

const POSITION_CLASS =
  'fixed left-4 bottom-6 z-[100] max-md:left-3 max-md:right-3 max-md:bottom-[calc(var(--sn-mobile-tabbar-h)_+_env(safe-area-inset-bottom)_+_0.75rem)]';

/**
 * Developer-mode-only overlay for startup and stack-hydration timing.
 *
 * Mount this only when developer mode is on for the active node; it does not
 * gate itself. It shows a collapsed chip with the foreground (attempt- or
 * session-relative) `list_visible` elapsed time and its anchor, expanding to a
 * phase table with copy/clear actions. It sits below toasts and modals and
 * never covers the mobile tab bar or safe area.
 */
export function HydrationTimingPanel() {
  const { listVisibleMs, listAnchor } = useHydrationTiming();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const chipLabel =
    listVisibleMs == null
      ? 'list …'
      : `list ${formatMs(listVisibleMs)} · ${listAnchor}`;

  const handleCopy = useCallback(async () => {
    try {
      await copyToClipboard(JSON.stringify(getHydrationReport(), null, 2));
      toast.success('Hydration report copied.');
    } catch (e) {
      console.error('[HydrationTiming] copy failed:', e);
      toast.error('Could not copy the hydration report.');
    }
  }, []);

  if (!expanded) {
    return (
      <button
        type="button"
        aria-label={`Hydration timing, ${chipLabel}`}
        data-testid="hydration-chip"
        onClick={() => setExpanded(true)}
        className={cn(
          POSITION_CLASS,
          'flex items-center gap-1.5 rounded-full border border-glass-border bg-popover/95 px-3 py-1.5 text-xs text-foreground shadow-lg backdrop-blur-[10px] backdrop-saturate-[1.15] max-md:right-auto',
        )}
      >
        <Timer className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono tabular-nums">{chipLabel}</span>
      </button>
    );
  }

  // Only build the (potentially large) report while the panel is open.
  const report = getHydrationReport();

  return (
    <div
      role="dialog"
      aria-label="Hydration timing"
      data-testid="hydration-panel"
      className={cn(
        POSITION_CLASS,
        'flex w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-glass-border bg-popover/95 text-xs text-foreground shadow-lg backdrop-blur-[10px] backdrop-saturate-[1.15] max-md:w-auto',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-glass-border px-3 py-2">
        <span className="flex items-center gap-1.5 font-medium">
          <Timer className="h-3.5 w-3.5 text-muted-foreground" />
          Hydration timing
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">{chipLabel}</span>
      </div>

      <div className="flex items-center justify-between gap-2 border-b border-glass-border px-3 py-1.5 text-[0.65rem] text-muted-foreground">
        <span>
          Boot age <span className="font-mono tabular-nums">{formatOffset(report.bootAgeMs)}</span>
        </span>
        <span>
          Session age{' '}
          <span className="font-mono tabular-nums">{formatOffset(report.sessionAgeMs)}</span>
        </span>
      </div>

      <div className="max-h-[50vh] overflow-y-auto max-md:max-h-[40vh]">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-popover/95 text-[0.65rem] uppercase tracking-wide text-muted-foreground backdrop-blur-[10px]">
            <tr>
              <th className="px-3 py-1.5 font-medium">Phase</th>
              <th className="px-3 py-1.5 text-right font-medium">At</th>
              <th className="px-3 py-1.5 text-right font-medium">Dur</th>
            </tr>
          </thead>
          <tbody>
            {report.phases.length === 0 ? (
              <tr>
                <td className="px-3 py-2 text-muted-foreground" colSpan={3}>
                  No events recorded yet.
                </td>
              </tr>
            ) : (
              report.phases.map((p, i) => (
                <tr key={`${p.phase}-${p.attemptId ?? ''}-${i}`} className="border-t border-glass-border/50">
                  <td className="px-3 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          outcomeDotClass(p.outcome, p.critical),
                        )}
                      />
                      <span className="font-mono">{p.phase}</span>
                      {p.proxied && <span className="text-[0.6rem] text-muted-foreground">proxy</span>}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                    {formatOffset(p.offsetMs)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                    {p.durationMs == null ? '-' : formatMs(p.durationMs)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {report.anyProxied && (
        <p className="border-t border-glass-border px-3 py-2 text-[0.65rem] leading-snug text-muted-foreground">
          Some requests were proxied to a remote node. Nodes and proxy debug logs
          need developer mode enabled on the gateway to appear.
        </p>
      )}

      <div className="flex items-center justify-end gap-1.5 border-t border-glass-border px-3 py-2">
        <button
          type="button"
          onClick={handleCopy}
          data-testid="hydration-copy"
          className="flex items-center gap-1 rounded-md border border-glass-border px-2 py-1 text-xs hover:bg-accent"
        >
          <Copy className="h-3 w-3" />
          Copy report
        </button>
        <button
          type="button"
          onClick={clearReport}
          data-testid="hydration-clear"
          className="flex items-center gap-1 rounded-md border border-glass-border px-2 py-1 text-xs hover:bg-accent"
        >
          <Trash2 className="h-3 w-3" />
          Clear
        </button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Collapse hydration timing"
          data-testid="hydration-collapse"
          className="flex items-center gap-1 rounded-md border border-glass-border px-2 py-1 text-xs hover:bg-accent"
        >
          <X className="h-3 w-3" />
          Collapse
        </button>
      </div>
    </div>
  );
}

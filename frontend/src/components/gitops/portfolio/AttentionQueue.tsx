import { BusyButton } from '@/components/ui/busy-button';
import { cn } from '@/lib/utils';
import { attentionLabel, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';
import { openPortfolioApplication } from './portfolioNavigation';
import { byUrgency, useAttentionSteps } from './useAttentionSteps';

/**
 * The exception queue: one entry per application that needs an operator, naming
 * the most urgent reason in a line of its own (so it never hides behind hover),
 * counting the rest, and carrying the step that resolves it. The step runs here
 * when the server offers it (Retry, Resume) and otherwise opens the surface
 * where the work happens (the update review, the stack, the Blueprint sheet).
 */
export function AttentionQueue({
  rows,
  onDrillDown,
}: {
  rows: GitOpsPortfolioRow[];
  onDrillDown?: (row: GitOpsPortfolioRow) => void;
}) {
  const { stepFor, run, isPending } = useAttentionSteps();

  const entries = rows
    .filter(row => row.attention.length > 0)
    .map(row => {
      const reasons = [...row.attention].sort(byUrgency);
      return { row, reason: reasons[0], more: reasons.length - 1 };
    });
  if (entries.length === 0) return null;

  entries.sort((a, b) => byUrgency(a.reason, b.reason) || a.row.name.localeCompare(b.row.name));

  return (
    <section aria-label="Attention required" className="shrink-0 space-y-2">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
        Attention required · {entries.length}
      </h2>
      {/* Bounded so a long queue scrolls inside its card instead of pushing
          the application table out of the non-scrolling page. */}
      <ul className="max-h-56 divide-y divide-card-border/60 overflow-y-auto rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
        {entries.map(({ row, reason, more }) => {
          const label = attentionLabel(reason);
          const next = stepFor(row, reason);
          return (
            <li key={row.id} className="flex items-center gap-2 pr-2">
              <button
                type="button"
                onClick={() => (onDrillDown ? onDrillDown(row) : openPortfolioApplication(row))}
                className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/40"
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
                    POSTURE_TONE_CLASS[label.tone],
                  )}
                >
                  {label.label}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-stat-value">{row.name}</span>
                  <span className="block truncate text-xs text-stat-subtitle">
                    {label.line}
                    {more > 0 && <span className="text-stat-icon"> · +{more} more</span>}
                  </span>
                </span>
              </button>
              <BusyButton
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5 font-mono text-[10px] uppercase tracking-[0.12em]"
                pending={isPending(row.id)}
                onClick={() => { void run(row.id, next.run); }}
              >
                {next.label}
              </BusyButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { attentionLabel, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import type { GitOpsAttentionReason, GitOpsPortfolioRow } from '@/types/gitopsPortfolio';
import { attentionNextStep, openPortfolioApplication } from './portfolioNavigation';

/**
 * The exception queue: one entry per attention reason currently assigned to
 * an application, with the reason's one-line explanation and the application
 * it concerns as the drill-in. Reasons are what the server's classifier
 * attached to each row; the queue groups them and keeps the *why* inline,
 * per the design rule that critical facts never hide behind hover.
 */
export function AttentionQueue({
  rows,
  onDrillDown,
}: {
  rows: GitOpsPortfolioRow[];
  onDrillDown?: (row: GitOpsPortfolioRow) => void;
}) {
  const entries: Array<{
    reason: GitOpsAttentionReason;
    row: GitOpsPortfolioRow;
  }> = [];
  for (const row of rows) {
    if (row.attention.length > 0) entries.push(...row.attention.map(reason => ({ reason, row })));
  }
  if (entries.length === 0) return null;

  const failuresFirst = [...entries].sort((a, b) => {
    const toneOrder = (tone: string) => (tone === 'destructive' ? 0 : 1);
    return toneOrder(attentionLabel(a.reason).tone) - toneOrder(attentionLabel(b.reason).tone)
      || a.row.name.localeCompare(b.row.name);
  });

  return (
    <section aria-label="Attention required" className="shrink-0 space-y-2">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
        Attention required · {entries.length}
      </h2>
      {/* Bounded so a long queue scrolls inside its card instead of pushing
          the application table out of the non-scrolling page. */}
      <ul className="max-h-56 divide-y divide-card-border/60 overflow-y-auto rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
        {failuresFirst.map(({ reason, row }) => {
          const label = attentionLabel(reason);
          const next = attentionNextStep(reason, row);
          return (
            <li key={`${row.id}:${reason}`} className="flex items-center gap-2 pr-2">
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
                  <span className="block truncate text-xs text-stat-subtitle">{label.line}</span>
                </span>
              </button>
              {/* The reason-specific next step. Decisions open the application
                  view, whose authority actions own permission and confirmation. */}
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5 font-mono text-[10px] uppercase tracking-[0.12em]"
                onClick={next.run}
              >
                {next.label}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

import { cn } from '@/lib/utils';
import { attentionLabel, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import type { GitOpsAttentionReason, GitOpsPortfolioRow } from '@/types/gitopsPortfolio';
import { openPortfolioApplication } from './portfolioNavigation';

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
    <section aria-label="Attention required" className="space-y-2">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
        Attention required · {entries.length}
      </h2>
      <ul className="divide-y divide-card-border/60 rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
        {failuresFirst.map(({ reason, row }) => {
          const label = attentionLabel(reason);
          const openable = row.targetMode === 'direct'
            ? row.nodeId !== null && row.stackName !== null
            : row.blueprintId !== null;
          return (
            <li key={`${row.id}:${reason}`}>
              <button
                type="button"
                onClick={openable ? () => (onDrillDown ? onDrillDown(row) : openPortfolioApplication(row)) : undefined}
                disabled={!openable}
                className={cn(
                  'group flex w-full items-start gap-3 px-3 py-2 text-left transition-colors',
                  openable ? 'hover:bg-accent/40' : 'cursor-default',
                )}
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
                <span className="shrink-0 self-center font-mono text-[10px] uppercase tracking-[0.12em] text-stat-icon transition-colors group-hover:text-brand">
                  {openable ? 'Open' : '--'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

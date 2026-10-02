import { useState } from 'react';

import { BusyButton } from '@/components/ui/busy-button';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { GITOPS_SOURCE_CONTROLLER_CAPABILITY } from '@/lib/capabilities';
import { cn } from '@/lib/utils';
import { attentionLabel, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import type { GitOpsAttentionReason, GitOpsPortfolioRow } from '@/types/gitopsPortfolio';
import { attentionNextStep, openPortfolioApplication, type SourceControl } from './portfolioNavigation';

/** Failures read as louder than waiting decisions, so the first reason shown is the one to look at first. */
function byUrgency(a: GitOpsAttentionReason, b: GitOpsAttentionReason): number {
  const rank = (reason: GitOpsAttentionReason) => (attentionLabel(reason).tone === 'destructive' ? 0 : 1);
  return rank(a) - rank(b);
}

/**
 * What this session may do to a Direct application's Git source from the queue:
 * the server must offer the action, the session must be able to edit the stack,
 * and the owning node must run the source controller. Anything else falls back to
 * opening the surface, so a button never promises what would be refused.
 */
function useSourceControl(): (row: GitOpsPortfolioRow) => SourceControl {
  const { can } = useAuth();
  const { nodeMeta } = useNodes();
  return (row) => ({
    can: (action) => {
      if (row.nodeId === null || row.stackName === null) return false;
      const meta = nodeMeta.get(row.nodeId);
      // Optimistic while the node's capabilities are unknown, as the Git source sheet is; a refusal still toasts.
      const capable = meta ? meta.capabilities.includes(GITOPS_SOURCE_CONTROLLER_CAPABILITY) : true;
      return capable
        && can('stack:edit', 'stack', row.stackName, row.nodeId)
        && row.availableActions.includes(action);
    },
  });
}

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
  const controlFor = useSourceControl();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const entries = rows
    .filter(row => row.attention.length > 0)
    .map(row => {
      const reasons = [...row.attention].sort(byUrgency);
      return { row, reason: reasons[0], more: reasons.length - 1 };
    });
  if (entries.length === 0) return null;

  entries.sort((a, b) => byUrgency(a.reason, b.reason) || a.row.name.localeCompare(b.row.name));

  // One flag per row, so a second click on another entry cannot end the first one's busy state early.
  const setPending = (rowId: string, pending: boolean) => setPendingIds(current => {
    const next = new Set(current);
    if (pending) next.add(rowId); else next.delete(rowId);
    return next;
  });
  const run = async (rowId: string, step: () => void | Promise<void>) => {
    setPending(rowId, true);
    try {
      await step();
    } finally {
      setPending(rowId, false);
    }
  };

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
          const next = attentionNextStep(reason, row, controlFor(row));
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
                pending={pendingIds.has(row.id)}
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

import { GITOPS_TONE_CLASS, SOURCE_STATE, RUNTIME_STATE } from '@/lib/gitopsState';
import type { GitOpsRuntimeStatus, GitOpsSourceStatus } from '@/types/gitops';
import { cn } from '@/lib/utils';

interface GitOpsBadgeProps {
  /**
   * Which vocabulary the status belongs to. The two unions overlap on several
   * names (`recovery_required`, `recovery_failed`) with different copy, so the
   * caller has to say which one it is holding rather than let a lookup guess.
   */
  facet: 'source' | 'runtime';
  status: GitOpsSourceStatus | GitOpsRuntimeStatus;
  /**
   * Drops the label to an icon and a tooltip title, for rows too narrow to
   * carry words. The title still states the whole sentence, so the state is
   * never conveyed by colour alone.
   */
  compact?: boolean;
  className?: string;
}

/**
 * One GitOps state as a small inline chip.
 *
 * The chip is a lighter reading of the same state the cards show, for places
 * that list many stacks at once: a dashboard row has space for a word, not a
 * sentence. Both read from the shared vocabulary, so a stack cannot be
 * "pending update" in the sidebar and something else on the dashboard.
 *
 * Presentation only. Whether a stack has GitOps state worth showing is the
 * caller's decision, because the answer differs per surface.
 */
export default function GitOpsBadge({ facet, status, compact = false, className }: GitOpsBadgeProps) {
  const state = facet === 'source'
    ? SOURCE_STATE[status as GitOpsSourceStatus]
    : RUNTIME_STATE[status as GitOpsRuntimeStatus];
  const Icon = state.icon;

  return (
    <span
      data-testid="gitops-badge"
      data-state={status}
      data-tone={state.tone}
      title={state.line}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5',
        'font-mono text-[10px] uppercase tracking-wide',
        GITOPS_TONE_CLASS[state.tone],
        className,
      )}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" strokeWidth={2} aria-hidden />
      {compact ? <span className="sr-only">{state.label}</span> : <span className="truncate">{state.label}</span>}
    </span>
  );
}

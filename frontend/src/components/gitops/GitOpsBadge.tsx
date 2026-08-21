import { GITOPS_TONE_CLASS, SOURCE_STATE, RUNTIME_STATE, type GitOpsStateMeta } from '@/lib/gitopsState';
import type { GitOpsRuntimeStatus, GitOpsSourceStatus } from '@/types/gitops';
import { cn } from '@/lib/utils';

/**
 * Which vocabulary the status belongs to, paired with a status from it.
 *
 * A discriminated union rather than two loose fields: the two status unions
 * overlap on several names (`recovery_required`, `recovery_failed`) with
 * different copy, so pairing them at the type level is what stops a runtime
 * status being rendered with source wording.
 */
type GitOpsBadgeFacet =
  | { facet: 'source'; status: GitOpsSourceStatus }
  | { facet: 'runtime'; status: GitOpsRuntimeStatus };

type GitOpsBadgeProps = GitOpsBadgeFacet & {
  /**
   * Drops the label to an icon and a tooltip title, for rows too narrow to
   * carry words. The title still states the whole sentence, so the state is
   * never conveyed by colour alone.
   */
  compact?: boolean;
  className?: string;
};

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
export default function GitOpsBadge(props: GitOpsBadgeProps) {
  const { compact = false, className } = props;
  // Looked up into an optional, because the status arrives over a proxy from a
  // node that may run a newer vocabulary than this build knows. The maps are
  // closed at compile time, which says nothing about what is on the wire, and
  // an unmapped key would otherwise dereference undefined inside a stack row
  // and take the whole list down with it. Rendering nothing matches what the
  // join already does for a stack it has no state for.
  const state: GitOpsStateMeta | undefined = props.facet === 'source'
    ? SOURCE_STATE[props.status]
    : RUNTIME_STATE[props.status];
  if (!state) return null;
  const Icon = state.icon;

  return (
    <span
      data-testid="gitops-badge"
      data-state={props.status}
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

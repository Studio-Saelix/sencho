import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

import { GITOPS_TONE_CLASS, type GitOpsStateMeta } from '@/lib/gitopsState';
import { cn } from '@/lib/utils';

interface GitOpsStateCardProps {
  /**
   * The whole state as one concept: label, tone, line and icon together. From
   * SOURCE_STATE or RUNTIME_STATE, or built inline for the projection faults,
   * which are limitations rather than facet statuses.
   */
  state: GitOpsStateMeta;
  /** Rendered as data-state so a test can assert the state without matching copy. */
  stateKey: string;
  /** Trailing slot on the header row, for a single small action. */
  action?: ReactNode;
  /** Detail under the line: a short commit sha, the node this target is on. */
  children?: ReactNode;
  'data-testid'?: string;
}

/**
 * One GitOps state, in the drift status card's shell plus the bevel a card is
 * supposed to carry. Presentation only: every decision about which state to
 * show, and whether to show one at all, belongs to the caller.
 */
export default function GitOpsStateCard(
  { state, stateKey, action, children, 'data-testid': testId }: GitOpsStateCardProps,
) {
  const Icon = state.icon;
  return (
    <div
      data-testid={testId}
      data-state={stateKey}
      className={cn('rounded-lg border px-3 py-2.5 shadow-card-bevel', GITOPS_TONE_CLASS[state.tone])}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-px h-4 w-4 shrink-0" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[11px] uppercase tracking-wide">{state.label}</span>
          <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{state.line}</div>
          {children}
        </div>
        {action}
      </div>
    </div>
  );
}

/**
 * An application the projection had reason to believe exists and could not
 * reach. A fault is a limitation rather than a facet status, so it has no entry
 * in the state maps; its copy lives here so the Git source panel, the Drift tab
 * and the Blueprint sheet cannot report the same failure three different ways.
 */
export function GitOpsFaultCard({ message }: { message: string }) {
  return (
    <GitOpsStateCard
      data-testid="gitops-fault"
      stateKey="unreachable"
      state={{
        label: 'gitops state unavailable',
        tone: 'destructive',
        line: message,
        icon: TriangleAlert,
      }}
    />
  );
}

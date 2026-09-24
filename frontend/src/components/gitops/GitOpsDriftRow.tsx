import { driftClassLabel, identityRefLabel } from '@/lib/gitopsState';
import type { GitOpsDriftItem } from '@/types/gitops';

/**
 * One classified divergence between intent and observation, in the
 * expected-to-observed idiom the Drift tab's compose findings use. Shared by
 * the Drift tab and the GitOps application view so one drift item never reads
 * two different ways.
 */
export default function GitOpsDriftRow({ item }: { item: GitOpsDriftItem }) {
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{driftClassLabel(item.class)}</span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">{item.owner}</span>
      </div>
      <div className="mt-1 text-[12px] text-foreground/90">{item.reason}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        <span className="text-stat-subtitle">expected</span>
        <span className="text-foreground/90">{identityRefLabel(item.expected)}</span>
        <span className="text-stat-subtitle">→ observed</span>
        <span className="font-semibold text-foreground">{identityRefLabel(item.observed)}</span>
      </div>
    </div>
  );
}

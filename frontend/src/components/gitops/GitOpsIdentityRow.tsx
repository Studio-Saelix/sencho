import type { ReactNode } from 'react';

/**
 * One term/value row of a GitOps identity grid, shared by the application view
 * and the rollout preview so the two read identically. `title` carries the
 * untruncated value where the visible text is shortened.
 */
export function IdentityRow({ term, title, children }: { term: string; title?: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-stat-subtitle">{term}</dt>
      <dd className="min-w-0 truncate font-mono text-[11px] text-stat-value" title={title}>{children}</dd>
    </>
  );
}

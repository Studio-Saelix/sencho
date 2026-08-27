import { Info } from 'lucide-react';

import { limitationCaveats } from '@/lib/gitopsLimitations';
import { liveCaveats } from '@/lib/gitopsState';
import type { GitOpsRevisionProjection } from '@/types/gitops';
import { cn } from '@/lib/utils';

interface GitOpsCaveatsProps {
  revision: GitOpsRevisionProjection | null;
  className?: string;
}

/**
 * What could not be proven about the state shown above.
 *
 * Deliberately quiet: neutral tone, no icon per line, sitting under the state
 * rather than competing with it. A caveat is not a failure. The state is real
 * and one piece of evidence behind it is missing, so the reader needs to know
 * which part to distrust without being told the whole thing is broken.
 *
 * Renders nothing when there is nothing to qualify, which is the ordinary case.
 * Faults on the absent arm are not shown here; those replace the state entirely
 * and belong to the fault card.
 */
export default function GitOpsCaveats({ revision, className }: GitOpsCaveatsProps) {
  const caveats = revision ? limitationCaveats(liveCaveats(revision)) : [];
  if (caveats.length === 0) return null;

  return (
    <div
      data-testid="gitops-caveats"
      className={cn('rounded-lg border border-muted bg-card/40 px-3 py-2.5', className)}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-px h-4 w-4 shrink-0 text-stat-subtitle" strokeWidth={1.5} aria-hidden />
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[11px] uppercase tracking-wide text-stat-subtitle">
            {caveats.length === 1 ? 'one thing could not be proven' : `${caveats.length} things could not be proven`}
          </span>
          <ul className="mt-1 space-y-1">
            {caveats.map((caveat) => (
              <li key={caveat} className="font-mono text-[11px] leading-relaxed text-foreground/70">
                {caveat}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

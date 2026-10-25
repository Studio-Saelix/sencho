import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { AutoHeight } from '@/components/animate-ui/primitives/effects/auto-height';
import { useReducedTransition } from '@/components/animate-ui/primitives/use-reduced-transition';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface DismissedItem {
  id: string | number;
  title: ReactNode;
  /** Who dismissed it, when, and for how long. */
  meta: string;
  /** Omitted when the account may not restore it. */
  onRestore?: () => void;
  restoring?: boolean;
}

interface DismissedSectionProps {
  items: DismissedItem[];
  /** Opens the list without a click, for a filter that landed on nothing but dismissed findings. */
  forceOpen?: boolean;
}

/**
 * The quiet "N dismissed" row under a findings list. Closed by default, always
 * counted, and the only place a dismissed finding is still readable and
 * restorable: a dismissal moves a finding aside, it never hides that one exists.
 */
export function DismissedSection({ items, forceOpen = false }: DismissedSectionProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const heightTransition = useReducedTransition({ type: 'spring', stiffness: 300, damping: 30, bounce: 0, restDelta: 0.01 } as const);
  if (items.length === 0) return null;
  const expanded = open || forceOpen;

  return (
    <section data-testid="dismissed-section" aria-label="Dismissed findings">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setOpen(value => !value)}
        className="flex items-center gap-1 rounded-sm px-1 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle transition-colors hover:text-stat-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-md:min-h-11"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} strokeWidth={1.5} aria-hidden />
        {items.length} dismissed
      </button>
      <AutoHeight deps={[expanded, items.length]} transition={heightTransition}>
        {expanded && (
          <ul id={listId} className="mt-1.5 rounded-lg border border-muted bg-card/40 px-3 py-1">
            {items.map(item => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-muted py-2 first:border-t-0">
                <div className="min-w-0 opacity-80">
                  <div className="text-[12px] font-medium text-foreground/80">{item.title}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-stat-subtitle">{item.meta}</div>
                </div>
                {item.onRestore && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-brand hover:text-brand max-md:min-h-11" disabled={item.restoring} onClick={item.onRestore}>
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </AutoHeight>
    </section>
  );
}

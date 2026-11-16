import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import { AutoHeight } from '@/components/animate-ui/primitives/effects/auto-height';
import { useReducedTransition } from '@/components/animate-ui/primitives/use-reduced-transition';
import { cn } from '@/lib/utils';

export interface DisclosureProps {
  /** The words on the trigger. */
  label: ReactNode;
  /** A quiet qualifier on the trigger, still visible while collapsed (a size, an exception count). */
  meta?: ReactNode;
  /** `quiet` is the small tracked-mono label under a status block; `row` is a full-width hairline row. */
  variant?: 'quiet' | 'row';
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
  /** Test id for the revealed content. */
  contentTestId?: string;
}

const TRIGGER_CLASS: Record<NonNullable<DisclosureProps['variant']>, string> = {
  quiet:
    'flex items-center gap-1 rounded-sm px-1 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle transition-colors hover:text-stat-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-md:min-h-11',
  row:
    'flex w-full items-center gap-2 rounded-sm py-2 text-left font-mono text-xs text-stat-value transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-md:min-h-11',
};

/**
 * A disclosure that starts collapsed (open with `defaultOpen`, which is read once, so a caller that needs it to follow later state should remount it with a key): a button with a chevron, `aria-expanded`
 * and `aria-controls` wired, the height sprung through AutoHeight on the shared
 * reduced-motion transition. Use it for evidence behind a status block (the
 * Proof layer, DESIGN.md section 1.1) and for any other one-level reveal; never
 * a raw `<details>`.
 */
export function Disclosure({
  label, meta, variant = 'quiet', defaultOpen = false, children, className,
  'data-testid': testId, contentTestId,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  // AutoHeight springs the height, which the MotionConfig reduced-motion path does not cover.
  const heightTransition = useReducedTransition({ type: 'spring', stiffness: 300, damping: 30, bounce: 0, restDelta: 0.01 } as const);
  return (
    <div data-testid={testId} className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(value => !value)}
        className={TRIGGER_CLASS[variant]}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} strokeWidth={1.5} aria-hidden />
        <span className="min-w-0 flex-1 break-words">{label}</span>
        {meta != null && <span className="shrink-0 text-stat-subtitle">{meta}</span>}
      </button>
      <AutoHeight deps={[open]} transition={heightTransition}>
        {open && (
          <div id={contentId} data-testid={contentTestId} className="flex flex-col gap-3 pt-2">
            {children}
          </div>
        )}
      </AutoHeight>
    </div>
  );
}

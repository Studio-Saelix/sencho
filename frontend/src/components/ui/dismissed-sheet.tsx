import { forwardRef, type ReactNode, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { cn } from '@/lib/utils';

export interface DismissedItem {
  id: string | number;
  title: ReactNode;
  /** Why it is set aside: typically who dismissed it, when, and for how long. */
  meta: string;
  /** Omitted when the account may not restore it. */
  onRestore?: () => void;
  restoring?: boolean;
}

/** The dismissed findings with who dismissed each, when, and for how long, and a Restore where the account may. Sits flat in a sheet section: sheets never nest cards. */
function DismissedList({ items }: { items: DismissedItem[] }) {
  return (
    <ul>
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
  );
}

/**
 * The `N dismissed` count in a status line, as the control that opens the
 * dismissed sheet. Renders nothing at zero. Dismissed findings stay counted and
 * reachable: a dismissal moves a finding aside, it never hides that one exists.
 *
 * The ref reaches the real button so the sheet can return keyboard focus to the
 * exact count that opened it.
 */
export const DismissedCountButton = forwardRef<HTMLButtonElement, {
  count: number;
  onClick: () => void;
  className?: string;
}>(function DismissedCountButton({ count, onClick, className }, ref) {
  if (count === 0) return null;
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      onClick={onClick}
      className={cn(
        'rounded-sm underline decoration-dotted underline-offset-4 transition-colors hover:text-stat-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-md:min-h-11',
        className,
      )}
    >
      {count} dismissed
    </button>
  );
});

/** Focus a target only while it is still in the document; a removed opener cannot take focus. */
function focusIfMounted(target: HTMLElement | null | undefined): boolean {
  if (!target || !target.isConnected) return false;
  target.focus();
  return document.activeElement === target;
}

interface DismissedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trip to this list: the path to the surface, ending at the view (for example `['Fleet', 'Readiness']`). */
  crumb: string[];
  items: DismissedItem[];
  /** The list is being re-read, so `items` is not yet the whole answer: say so instead of reading as empty. */
  loading?: boolean;
  /** The count that opened the sheet. Every close control returns keyboard focus here while it is still mounted. */
  openerRef?: RefObject<HTMLButtonElement | null>;
  /**
   * The surviving target when restoring the last item removes the count. Focus
   * moves here instead of falling through to the page body.
   */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Every dismissed finding on a surface, in a system sheet opened from the
 * `N dismissed` count, so a long list never pushes the page's own content down.
 * The list is never narrowed by the surface's filters, so it matches the count
 * that opened it.
 */
export function DismissedSheet({ open, onOpenChange, crumb, items, loading = false, openerRef, fallbackFocusRef }: DismissedSheetProps) {
  // Radix returns focus to a registered trigger, and this count is not one. Take
  // over its close-auto-focus instead: the exact opener first, then the surface's
  // surviving region once restoring the last item has unmounted the count.
  const handleCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (focusIfMounted(openerRef?.current)) return;
    focusIfMounted(fallbackFocusRef?.current);
  };

  return (
    <SystemSheet
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={handleCloseAutoFocus}
      crumb={crumb}
      name="Dismissed findings"
      meta={loading ? 'Updating…' : `${items.length} set aside · still counted, never hidden`}
    >
      <SheetSection title={loading ? 'Dismissed' : `Dismissed · ${items.length}`}>
        {loading
          ? <p className="py-8 text-center text-sm text-muted-foreground">Updating the list…</p>
          : items.length > 0
            ? <DismissedList items={items} />
            : <p className="py-8 text-center text-sm text-muted-foreground">Nothing is dismissed.</p>}
      </SheetSection>
    </SystemSheet>
  );
}

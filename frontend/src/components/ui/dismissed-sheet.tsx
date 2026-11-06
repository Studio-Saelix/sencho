import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
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

/** The dismissed findings with who dismissed each, when, and for how long, and a Restore where the account may. */
export function DismissedList({ items, id, className, flush = false }: { items: DismissedItem[]; id?: string; className?: string; /** Drops the card chrome, for a body that already sits in a sheet section (sheets never nest cards). */ flush?: boolean }) {
  return (
    <ul id={id} className={cn(!flush && 'rounded-lg border border-muted bg-card/40 px-3 py-1', className)}>
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
 */
export function DismissedCountButton({ count, onClick, className }: { count: number; onClick: () => void; className?: string }) {
  if (count === 0) return null;
  return (
    <button
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
}

interface DismissedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trip to this list, per the sheet header recipe (for example `['Fleet', 'Readiness']`). */
  crumb: string[];
  items: DismissedItem[];
}

/**
 * Every dismissed finding on a surface, in a system sheet opened from the
 * `N dismissed` count, so a long list never pushes the page's own content down.
 * The list is never narrowed by the surface's filters, so it matches the count
 * that opened it.
 */
export function DismissedSheet({ open, onOpenChange, crumb, items }: DismissedSheetProps) {
  return (
    <SystemSheet
      open={open}
      onOpenChange={onOpenChange}
      crumb={crumb}
      name="Dismissed findings"
      meta={`${items.length} set aside · still counted, never hidden`}
    >
      <SheetSection title={`Dismissed · ${items.length}`}>
        {items.length > 0
          ? <DismissedList items={items} flush />
          : <p className="py-8 text-center text-sm text-muted-foreground">Nothing is dismissed.</p>}
      </SheetSection>
    </SystemSheet>
  );
}

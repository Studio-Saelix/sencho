import { useId, type ReactNode } from 'react';
import { CloudOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The Home dashboard's section chrome: a beveled card whose header carries a
 * heading-face title, a tracked-mono meta line, and an optional right-hand
 * control. Stack Health and every card below it render through this so the
 * page reads as one system rather than a stack of differently-styled widgets.
 */
export function DashboardPanel({
  title,
  meta,
  actions,
  footer,
  children,
  className,
}: {
  title: string;
  /** Tracked-mono line beside the title (counts, scope, freshness). */
  meta?: ReactNode;
  /** Right-aligned header control, e.g. a scope switch. */
  actions?: ReactNode;
  /** Hairline-separated strip under the body (show more, view all). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-3">
          <h2 id={titleId} className="font-heading text-xl leading-none tracking-tight text-stat-value">
            {title}
          </h2>
          {meta}
        </div>
        {actions}
      </div>
      {children}
      {footer ? <div className="border-t border-border/60 px-5 py-3">{footer}</div> : null}
    </section>
  );
}

/** The tracked-mono meta line that sits beside a panel title. */
export function PanelMeta({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[11px] uppercase tracking-[0.22em] text-stat-subtitle', className)}>
      {children}
    </span>
  );
}

/**
 * The keyboard and screen-reader handle for a row that drills somewhere. The
 * row stays a real table row (so cells keep their column headers) and owns the
 * click handler; this button sits in the primary cell, carries the row's name,
 * and relies on its native click bubbling up to the row, so Enter and Space
 * work without a second handler.
 */
export function RowAction({ label, expanded, children }: {
  label?: string;
  /** For a row that discloses more rows instead of navigating. */
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      className="block w-full min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
    >
      {children}
    </button>
  );
}

/** Amber strip above a panel's rows: what is on screen may be incomplete or out of date. */
export function PanelWarning({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-border/60 bg-warning/[0.04] px-5 py-2 text-xs text-stat-subtitle">
      <CloudOff className="h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.5} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** Placeholder rows while a panel's first answer is in flight. */
export function PanelSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 border-t border-border/60 px-5 py-4">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-6 w-full" />)}
    </div>
  );
}

/** Centered empty or error line inside a panel body. */
export function PanelNotice({ icon, children, className }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 border-t border-border/60 px-5 py-8 text-stat-subtitle', className)}>
      {icon}
      <span className="text-sm">{children}</span>
    </div>
  );
}

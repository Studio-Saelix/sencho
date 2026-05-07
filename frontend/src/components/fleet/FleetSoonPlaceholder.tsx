import type { ReactNode } from 'react';

interface FleetSoonPlaceholderProps {
  icon: ReactNode;
  kicker: string;
  title: string;
  description: string;
  plannedActions: string[];
}

export function FleetSoonPlaceholder({
  icon,
  kicker,
  title,
  description,
  plannedActions,
}: FleetSoonPlaceholderProps) {
  return (
    <div className="mx-auto max-w-3xl rounded-xl border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
      <div className="flex flex-col gap-5 p-8">
        <div className="inline-flex items-center gap-2 text-brand">
          <span className="inline-flex h-4 w-4 items-center justify-center" aria-hidden>
            {icon}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em]">{kicker}</span>
        </div>

        <h3 className="font-serif text-2xl italic leading-tight tracking-[-0.01em] text-stat-value">
          {title}
        </h3>

        <p className="font-sans text-sm leading-relaxed text-stat-subtitle">
          {description}
        </p>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-stat-icon">
            Planned actions
          </span>
          <div className="flex flex-wrap gap-1.5">
            {plannedActions.map((action) => (
              <span
                key={action}
                className="rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-stat-subtitle"
              >
                {action}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

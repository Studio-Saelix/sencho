import { cn } from '@/lib/utils';

const LADDER: { bg: string; label: string }[] = [
    { bg: 'bg-background', label: 'page' },
    { bg: 'bg-card', label: 'card' },
    { bg: 'bg-band', label: 'band' },
    { bg: 'bg-well', label: 'well' },
];

/**
 * Compact, self-contained preview of the current theme. It consumes only global
 * tokens, so it (and the rest of the app) re-render live as the mode, accent, or
 * fine-tune knobs change. A concentrated view of surfaces, borders, ink tiers,
 * status, and the accent without scanning the whole page.
 */
export function ThemePreview() {
    return (
        <div className="group relative overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors hover:border-t-card-border-hover">
            <div className="absolute inset-y-0 left-0 w-[3px] bg-brand" />
            <div className="flex flex-col gap-4 p-5 pl-6">
                {/* Mini masthead: rail + display state word + mono kicker + status dots */}
                <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand">
                            fleet · preview
                        </div>
                        <div className="font-display text-2xl italic leading-none text-stat-value">
                            Healthy
                        </div>
                        <div className="mt-1.5 font-mono text-[11px] text-stat-subtitle">
                            6 nodes · last sync 9s
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-success" />
                        <span className="h-2 w-2 rounded-full bg-warning" />
                        <span className="h-2 w-2 rounded-full bg-destructive" />
                        <span className="h-2 w-2 rounded-full bg-brand" />
                    </div>
                </div>

                {/* Ink tiers */}
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                    <span className="text-stat-value">Value</span>
                    <span className="text-stat-title">Title</span>
                    <span className="text-stat-subtitle">Subtitle</span>
                    <span className="text-stat-icon">Icon</span>
                </div>

                {/* Surface ladder */}
                <div className="grid grid-cols-4 gap-2">
                    {LADDER.map(({ bg, label }) => (
                        <div key={label} className="flex flex-col items-center gap-1.5">
                            <div className={cn('h-9 w-full rounded-md border border-card-border', bg)} />
                            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-stat-icon">
                                {label}
                            </span>
                        </div>
                    ))}
                </div>

                {/* Brand progress + key affordances */}
                <div className="flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-well">
                        <div className="h-full w-[62%] rounded-full bg-brand" />
                    </div>
                    <span className="pointer-events-none select-none rounded-md border border-card-border bg-card px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle shadow-btn-glow">
                        Outline
                    </span>
                    <span className="pointer-events-none select-none rounded-md bg-brand px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-foreground">
                        Primary
                    </span>
                </div>
            </div>
        </div>
    );
}

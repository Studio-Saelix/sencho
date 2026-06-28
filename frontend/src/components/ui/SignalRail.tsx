import { cn } from '@/lib/utils';
import { Sparkline } from '@/components/ui/sparkline';

export type SignalTone = 'value' | 'warn' | 'error' | 'subtitle';

export interface SignalTile {
    kicker: string;
    value: string;
    tone?: SignalTone;
    /** Optional series for a 64x20 sparkline stroked in brand cyan. */
    spark?: number[];
    /** When set, the tile renders as a button that navigates on click. */
    onClick?: () => void;
}

interface SignalRailProps {
    tiles: SignalTile[];
    className?: string;
}

const toneClass: Record<SignalTone, string> = {
    value: 'text-stat-value',
    warn: 'text-warning',
    error: 'text-destructive',
    subtitle: 'text-stat-subtitle',
};

export function SignalRail({ tiles, className }: SignalRailProps) {
    if (tiles.length === 0) return null;
    return (
        <div
            className={cn(
                'shrink-0 grid border-b border-card-border bg-card',
                className,
            )}
            style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
        >
            {tiles.map((tile, idx) => {
                const inner = (
                    <>
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
                                {tile.kicker}
                            </span>
                            <span
                                className={cn(
                                    'font-mono tabular-nums tracking-tight text-2xl leading-none',
                                    toneClass[tile.tone ?? 'value'],
                                )}
                            >
                                {tile.value}
                            </span>
                        </div>
                        {tile.spark && tile.spark.length > 1 ? (
                            <div className="h-5 w-16 shrink-0 opacity-90">
                                <Sparkline
                                    points={tile.spark}
                                    stroke="var(--brand)"
                                    fill="var(--brand)"
                                    strokeWidth={1.25}
                                />
                            </div>
                        ) : null}
                    </>
                );
                const cellClass = cn(
                    'flex items-center justify-between gap-4 px-5 py-[var(--density-tile-y)] text-left',
                    idx > 0 && 'border-l border-card-border',
                    tile.onClick && 'cursor-pointer transition-colors hover:bg-accent/5',
                );
                return tile.onClick ? (
                    <button key={tile.kicker} type="button" onClick={tile.onClick} className={cellClass}>
                        {inner}
                    </button>
                ) : (
                    <div key={tile.kicker} className={cellClass}>
                        {inner}
                    </div>
                );
            })}
        </div>
    );
}

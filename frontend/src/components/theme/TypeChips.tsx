import { cn } from '@/lib/utils';
import type { TypeChipOption } from './typeOptions';

interface TypeChipsProps<T extends string> {
    value: T;
    options: TypeChipOption<T>[];
    onChange: (id: T) => void;
    columns?: 3 | 4;
    ariaLabel?: string;
    className?: string;
}

/**
 * A row of preview chips for type personalization: each chip renders a sample
 * glyph in the option's own face (or size) above its name, with the selected
 * chip highlighted in the accent. Shared by the topbar Type section and
 * Settings → Appearance → Typography. Mirrors AccentPicker's selected treatment.
 */
export function TypeChips<T extends string>({
    value,
    options,
    onChange,
    columns = 3,
    ariaLabel,
    className,
}: TypeChipsProps<T>) {
    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            className={cn('grid gap-2', columns === 4 ? 'grid-cols-4' : 'grid-cols-3', className)}
        >
            {options.map((o) => {
                const active = o.id === value;
                return (
                    <button
                        key={o.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={o.name}
                        onClick={() => onChange(o.id)}
                        className={cn(
                            'flex flex-col items-center justify-center gap-1.5 rounded-md border px-2 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
                            active
                                ? 'border-brand/40 bg-brand/10'
                                : 'border-card-border bg-card hover:bg-accent',
                        )}
                    >
                        <span className="leading-none text-stat-value" style={o.previewStyle}>
                            {o.preview}
                        </span>
                        <span
                            className={cn(
                                'font-mono text-[9px] uppercase tracking-[0.12em]',
                                active ? 'text-brand' : 'text-stat-subtitle',
                            )}
                        >
                            {o.name}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

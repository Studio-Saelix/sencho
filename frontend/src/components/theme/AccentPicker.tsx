import { cn } from '@/lib/utils';
import { ACCENTS, type AccentId } from '@/hooks/use-theme';

interface AccentPickerProps {
    value: AccentId;
    onChange: (accent: AccentId) => void;
    className?: string;
}

/**
 * The eight swappable accent hues as a swatch grid. Each dot renders the accent
 * at a representative lightness so it reads on both dark and light panels; the
 * selected swatch gets a ring in its own hue. Shared by the topbar quick switch
 * and Settings → Appearance.
 */
export function AccentPicker({ value, onChange, className }: AccentPickerProps) {
    return (
        <div role="radiogroup" aria-label="Accent" className={cn('grid grid-cols-4 gap-2', className)}>
            {ACCENTS.map((a) => {
                const color = `oklch(0.745 ${a.c} ${a.h})`;
                const active = a.id === value;
                return (
                    <button
                        key={a.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={a.label}
                        title={a.label}
                        onClick={() => onChange(a.id)}
                        className={cn(
                            'flex h-8 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
                            active ? 'border-card-border-hover bg-card' : 'border-card-border hover:bg-accent',
                        )}
                    >
                        <span
                            className="h-4 w-4 rounded-full"
                            style={{
                                background: color,
                                boxShadow: active ? `0 0 0 2px var(--card), 0 0 0 4px ${color}` : undefined,
                            }}
                        />
                    </button>
                );
            })}
        </div>
    );
}

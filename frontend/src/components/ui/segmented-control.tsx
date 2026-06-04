import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  badge?: string | number;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentedControlOption<T>[];
  onChange: (next: T) => void;
  ariaLabel?: string;
  iconOnly?: boolean;
  fullWidth?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  iconOnly,
  fullWidth,
  className,
}: SegmentedControlProps<T>) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const focusIndex = (index: number) => {
    const clamped = (index + options.length) % options.length;
    const target = buttonsRef.current[clamped];
    const opt = options[clamped];
    if (target && opt) {
      target.focus();
      onChange(opt.value);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusIndex(current + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusIndex(current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusIndex(options.length - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center rounded-md border border-card-border bg-card p-0.5',
        fullWidth && 'flex w-full',
        className,
      )}
    >
      {options.map((opt, index) => {
        const active = value === opt.value;
        const Icon = opt.icon;
        const hasBadge = opt.badge !== undefined && opt.badge !== '';
        const a11yLabel = iconOnly
          ? opt.label
          : hasBadge
            ? `${opt.label}, ${opt.badge}`
            : undefined;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              buttonsRef.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={a11yLabel}
            title={iconOnly ? opt.label : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              'flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
              fullWidth && 'flex-1 justify-center',
              active
                ? 'bg-brand/10 text-brand'
                : 'text-stat-subtitle hover:text-stat-value',
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" strokeWidth={1.5} /> : null}
            {iconOnly ? null : <span>{opt.label}</span>}
            {hasBadge ? (
              <span
                aria-hidden="true"
                className={cn(
                  'ml-0.5 rounded-sm px-1 text-[9px] tabular-nums',
                  active ? 'bg-brand/20 text-brand' : 'bg-muted text-stat-subtitle',
                )}
              >
                {opt.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

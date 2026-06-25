import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface NumberChipProps {
    value: string;
    onChange: (v: string) => void;
    suffix: string;
    min?: number;
    max?: number;
    step?: number;
    warnOver?: number;
    disabled?: boolean;
}

export function NumberChip({ value, onChange, suffix, min, max, step = 1, warnOver, disabled }: NumberChipProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (editing) inputRef.current?.select();
    }, [editing]);

    // When the chip is externally disabled (e.g. master toggle OFF), force
    // exit from edit mode so the greyed-out button state is shown consistently.
    useEffect(() => {
        if (disabled) setEditing(false);
    }, [disabled]);

    const startEdit = () => {
        if (disabled) return;
        setDraft(value);
        setEditing(true);
    };

    const commit = () => {
        const trimmed = draft.trim();
        const parsed = Number(trimmed);
        if (trimmed !== '' && Number.isFinite(parsed)) {
            let next = parsed;
            if (typeof min === 'number') next = Math.max(min, next);
            if (typeof max === 'number') next = Math.min(max, next);
            onChange(String(next));
        }
        setEditing(false);
    };

    const numeric = Number(value);
    const warn = typeof warnOver === 'number' && Number.isFinite(numeric) && numeric > warnOver;

    const chipClass = cn(
        'inline-flex items-baseline gap-1 rounded-md border px-2.5 py-1 font-mono text-sm tabular-nums tracking-tight transition-colors min-w-[78px] justify-end focus-within:ring-2 focus-within:ring-brand/50 focus-within:outline-none',
        warn
            ? 'border-warning/40 bg-warning/10 text-warning'
            : 'border-card-border bg-card text-stat-value hover:border-brand/50',
    );

    if (editing) {
        return (
            <span className={chipClass}>
                <input
                    ref={inputRef}
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commit();
                        if (e.key === 'Escape') setEditing(false);
                    }}
                    className="w-12 bg-transparent text-right outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    disabled={disabled}
                />
                <span className="text-stat-subtitle">{suffix}</span>
            </span>
        );
    }

    return (
        <button
            type="button"
            className={cn(chipClass, 'focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed')}
            onClick={startEdit}
            disabled={disabled}
        >
            <span>{value || '0'}</span>
            <span className="text-stat-subtitle">{suffix}</span>
        </button>
    );
}

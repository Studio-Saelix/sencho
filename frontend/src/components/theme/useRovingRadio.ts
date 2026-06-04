import { useRef, type KeyboardEvent } from 'react';

/**
 * Roving-tabindex keyboard model for a single-select radio group rendered as a
 * grid of buttons (AccentPicker, TypeChips). Exactly one item is tabbable (the
 * selected one, or the first when nothing matches), and Arrow / Home / End move
 * focus and selection together, matching the WAI-ARIA radiogroup pattern (and
 * the existing SegmentedControl). Returns a props factory for each item.
 */
export function useRovingRadio<T extends string>(values: T[], current: T, onChange: (value: T) => void) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const selectedIndex = values.indexOf(current);
    const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const move = (index: number) => {
        const n = values.length;
        if (n === 0) return;
        const i = ((index % n) + n) % n;
        refs.current[i]?.focus();
        onChange(values[i]);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                e.preventDefault();
                move(index + 1);
                break;
            case 'ArrowLeft':
            case 'ArrowUp':
                e.preventDefault();
                move(index - 1);
                break;
            case 'Home':
                e.preventDefault();
                move(0);
                break;
            case 'End':
                e.preventDefault();
                move(values.length - 1);
                break;
        }
    };

    return (index: number) => ({
        ref: (el: HTMLButtonElement | null) => {
            refs.current[index] = el;
        },
        tabIndex: index === tabbableIndex ? 0 : -1,
        onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onKeyDown(e, index),
    });
}

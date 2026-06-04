import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccentPicker } from './AccentPicker';

// Covers the roving-radio keyboard model added via useRovingRadio (shared with
// TypeChips). ACCENTS order is orange, amber, lime, cyan, blue, violet, magenta, steel.

describe('AccentPicker keyboard model', () => {
    it('exposes exactly one tabbable radio (the selected one)', () => {
        render(<AccentPicker value="cyan" onChange={() => {}} />);
        const radios = screen.getAllByRole('radio');
        const tabbable = radios.filter((r) => r.getAttribute('tabindex') === '0');
        expect(tabbable).toHaveLength(1);
        expect(tabbable[0].getAttribute('aria-label')).toBe('Cyan');
    });

    it('ArrowRight moves selection to the next accent, ArrowLeft to the previous', () => {
        const onChange = vi.fn();
        render(<AccentPicker value="cyan" onChange={onChange} />);
        const cyan = screen.getByRole('radio', { name: 'Cyan' });
        fireEvent.keyDown(cyan, { key: 'ArrowRight' });
        expect(onChange).toHaveBeenLastCalledWith('blue');
        fireEvent.keyDown(cyan, { key: 'ArrowLeft' });
        expect(onChange).toHaveBeenLastCalledWith('lime');
    });

    it('Home selects the first accent, End selects the last', () => {
        const onChange = vi.fn();
        render(<AccentPicker value="cyan" onChange={onChange} />);
        const cyan = screen.getByRole('radio', { name: 'Cyan' });
        fireEvent.keyDown(cyan, { key: 'Home' });
        expect(onChange).toHaveBeenLastCalledWith('orange');
        fireEvent.keyDown(cyan, { key: 'End' });
        expect(onChange).toHaveBeenLastCalledWith('steel');
    });
});

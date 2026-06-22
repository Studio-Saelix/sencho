import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SegmentedControl } from './segmented-control';

const OPTS = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
];

describe('SegmentedControl disabled', () => {
    it('marks the group aria-disabled and ignores clicks when disabled', () => {
        const onChange = vi.fn();
        render(<SegmentedControl value="a" options={OPTS} onChange={onChange} disabled ariaLabel="Mode" />);
        expect(screen.getByRole('radiogroup', { name: 'Mode' }).getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(screen.getByRole('radio', { name: 'B' }));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores arrow-key navigation when disabled', () => {
        const onChange = vi.fn();
        render(<SegmentedControl value="a" options={OPTS} onChange={onChange} disabled ariaLabel="Mode" />);
        fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'ArrowRight' });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('still fires onChange when enabled', () => {
        const onChange = vi.fn();
        render(<SegmentedControl value="a" options={OPTS} onChange={onChange} ariaLabel="Mode" />);
        fireEvent.click(screen.getByRole('radio', { name: 'B' }));
        expect(onChange).toHaveBeenCalledWith('b');
    });

    it('commits onChange on arrow-key navigation when enabled', () => {
        const onChange = vi.fn();
        render(<SegmentedControl value="a" options={OPTS} onChange={onChange} ariaLabel="Mode" />);
        fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'ArrowRight' });
        expect(onChange).toHaveBeenCalledWith('b');
    });

    it('keeps a keyboard entry point when no option is active (value=null)', () => {
        render(<SegmentedControl value={null} options={OPTS} onChange={() => {}} ariaLabel="Mode" />);
        const radios = screen.getAllByRole('radio');
        expect(radios.some((r) => r.getAttribute('aria-checked') === 'true')).toBe(false);
        // The first option anchors the roving tabindex so Tab still reaches the group.
        expect(radios[0].getAttribute('tabindex')).toBe('0');
        expect(radios[1].getAttribute('tabindex')).toBe('-1');
    });
});

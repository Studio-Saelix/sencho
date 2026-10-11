/**
 * The shared number chip singularizes a plural suffix at 1, and snaps a typed
 * value to its own step so a fraction never reaches an integer setting's
 * route validation. The history window covers "day"; the generations chip in
 * the Stacks section uses the same control; the Docker janitor chip covers a
 * genuinely fractional step.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NumberChip } from '../SystemControls';

// One render per test, so the role queries below only ever see the chip the
// test itself mounted.
afterEach(() => cleanup());

describe('NumberChip suffix', () => {
    it('reads generation when one rollback generation is retained', () => {
        render(<NumberChip value="1" onChange={() => {}} suffix="generations" min={0} max={50} />);
        expect(screen.getByText('generation')).toBeInTheDocument();
    });

    it('keeps the plural suffix above 1', () => {
        render(<NumberChip value="2" onChange={() => {}} suffix="generations" min={0} max={50} />);
        expect(screen.getByText('generations')).toBeInTheDocument();
    });
});

describe('NumberChip step', () => {
    function commitValue(draft: string, props: Partial<React.ComponentProps<typeof NumberChip>> = {}) {
        const onChange = vi.fn();
        render(<NumberChip value="30" onChange={onChange} suffix="days" min={1} max={365} {...props} />);
        fireEvent.click(screen.getByRole('button'));
        const input = screen.getByRole('spinbutton');
        fireEvent.change(input, { target: { value: draft } });
        fireEvent.blur(input);
        return onChange;
    }

    it('rounds a typed fraction up to the whole step an integer setting validates', () => {
        // 1.5 used to be clamped but written verbatim, so the save sent "1.5"
        // and the route rejected it with a bare validation error.
        expect(commitValue('1.5')).toHaveBeenCalledWith('2');
    });

    it('rounds a typed fraction down to the whole step', () => {
        expect(commitValue('1.4')).toHaveBeenCalledWith('1');
    });

    it('keeps a genuinely fractional step on a chip that asks for one', () => {
        // The Docker janitor chip is a float setting, so 0.5 must survive.
        expect(commitValue('10.3', { min: 0, step: 0.5 })).toHaveBeenCalledWith('10.5');
    });

    it('clamps after rounding, so a fraction below the floor cannot round down under it', () => {
        expect(commitValue('0.4')).toHaveBeenCalledWith('1');
    });
});

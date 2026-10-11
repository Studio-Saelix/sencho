/**
 * The shared number chip singularizes a plural suffix at 1. The history window
 * covers "day"; this covers the generations chip in the Stacks section, which
 * uses the same control.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NumberChip } from '../SystemControls';

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

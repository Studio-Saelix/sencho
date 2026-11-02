/**
 * The shared exposure-intent picker: the clear pill reads "unset" on the stack
 * row and "inherit" on a per-service row, and it names what applies instead
 * when nothing is declared (the panel's `auto (detected)`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExposureIntentPicker } from './ExposureIntentPicker';

describe('ExposureIntentPicker', () => {
  it('shows the inherited intent on a cleared service row', () => {
    render(<ExposureIntentPicker value={null} inherited="internal" canEdit onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'inherit' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('→ internal')).toBeInTheDocument();
  });

  it('shows auto (detected) when nothing is declared and detection applies', () => {
    render(<ExposureIntentPicker value={null} inherited={null} autoLabel="auto (detected)" canEdit onChange={vi.fn()} />);
    expect(screen.getByText('→ auto (detected)')).toBeInTheDocument();
  });

  it('prefers the inherited intent over the auto label', () => {
    render(<ExposureIntentPicker value={null} inherited="public" autoLabel="auto (detected)" canEdit onChange={vi.fn()} />);
    expect(screen.getByText('→ public')).toBeInTheDocument();
    expect(screen.queryByText('→ auto (detected)')).not.toBeInTheDocument();
  });

  it('omits the auto label once an intent is declared', () => {
    render(<ExposureIntentPicker value="internal" inherited={null} autoLabel="auto (detected)" canEdit onChange={vi.fn()} />);
    expect(screen.queryByText(/auto \(detected\)/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'internal' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears back to the inherited scope', () => {
    const onChange = vi.fn();
    render(<ExposureIntentPicker value="public" inherited="internal" canEdit onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'inherit' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

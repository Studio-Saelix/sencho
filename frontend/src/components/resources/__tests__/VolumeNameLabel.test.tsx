import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VolumeNameLabel } from '../VolumeNameLabel';

const ANON = '079dfda49f2c483f80f1d4f6b1865be55af54a0298507a0e588aae551134ba62';

describe('VolumeNameLabel', () => {
  it('truncates an anonymous name and exposes the full hash on hover', () => {
    render(<VolumeNameLabel name={ANON} showChip />);
    const text = screen.getByTestId('volume-name-text');
    expect(text).toHaveTextContent('079dfda49f2c…');
    expect(text).toHaveAttribute('title', ANON);
    expect(screen.getByTestId('anon-volume-chip')).toBeInTheDocument();
  });

  it('renders a named volume in full with no chip', () => {
    render(<VolumeNameLabel name="app_pgdata" showChip />);
    expect(screen.getByTestId('volume-name-text')).toHaveTextContent('app_pgdata');
    expect(screen.queryByTestId('anon-volume-chip')).not.toBeInTheDocument();
  });

  it('omits the chip when showChip is not set, but still truncates', () => {
    render(<VolumeNameLabel name={ANON} />);
    expect(screen.getByTestId('volume-name-text')).toHaveTextContent('079dfda49f2c…');
    expect(screen.queryByTestId('anon-volume-chip')).not.toBeInTheDocument();
  });
});

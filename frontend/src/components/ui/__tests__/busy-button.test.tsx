import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { BusyButton } from '../busy-button';
import { DURATION_BASE_MS } from '@/hooks/useVisualBusy';

describe('BusyButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables immediately when pending without showing spinner yet', () => {
    render(
      <BusyButton pending busyLabel="Saving...">
        Save
      </BusyButton>,
    );
    const btn = screen.getByRole('button', { name: /Save/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.querySelector('.animate-spin')).toBeNull();
  });

  it('shows spinner and progressive label after the visual delay', () => {
    render(
      <BusyButton pending busyLabel="Saving...">
        Save
      </BusyButton>,
    );
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    expect(screen.getByRole('button', { name: /Saving/i })).toBeDisabled();
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });

  it('signals busy via aria-busy and label without requiring spin animation', () => {
    render(
      <BusyButton pending busyLabel="Deleting...">
        Delete
      </BusyButton>,
    );
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    const btn = screen.getByRole('button', { name: /Deleting/i });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveTextContent('Deleting...');
    // Spinner is enhancement only; the accessible name and aria-busy are primary.
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });
});

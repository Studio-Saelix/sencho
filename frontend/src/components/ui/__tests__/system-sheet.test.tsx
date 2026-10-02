import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RefreshCw } from 'lucide-react';
import { SystemSheet, type SystemSheetAction } from '../system-sheet';
import { DURATION_BASE_MS } from '@/hooks/useVisualBusy';

function sheetWith(action: SystemSheetAction) {
  return (
    <SystemSheet open onOpenChange={vi.fn()} crumb={['Stack', 'web']} name="web" secondaryActions={[action]}>
      body
    </SystemSheet>
  );
}

describe('SystemSheet toolbar busy feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('locks a pending action at once without spinning yet', () => {
    render(sheetWith({ label: 'Pulling', onClick: vi.fn(), icon: RefreshCw, pending: true }));
    const button = screen.getByRole('button', { name: 'Pulling' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.querySelector('svg')).not.toHaveClass('animate-spin');
  });

  it('spins the action\'s own icon once the work outlasts the busy delay', () => {
    render(sheetWith({ label: 'Pulling', onClick: vi.fn(), icon: RefreshCw, pending: true }));
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    const icon = screen.getByRole('button', { name: 'Pulling' }).querySelector('svg');
    expect(icon).toHaveClass('animate-spin');
    expect(icon).toHaveClass('lucide-refresh-cw');
  });

  it('leaves an idle action enabled, unbusy, and still', () => {
    render(sheetWith({ label: 'Pull now', onClick: vi.fn(), icon: RefreshCw }));
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    const button = screen.getByRole('button', { name: 'Pull now' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button.querySelector('svg')).not.toHaveClass('animate-spin');
  });
});

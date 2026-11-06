import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RefreshCw, ShieldCheck, Loader2 } from 'lucide-react';
import { IconBusyButton } from '../icon-busy-button';
import { DURATION_BASE_MS } from '@/hooks/useVisualBusy';

describe('IconBusyButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is enabled and still when idle', () => {
    render(<IconBusyButton icon={RefreshCw} pending={false} aria-label="Refresh" />);
    const btn = screen.getByRole('button', { name: 'Refresh' });
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute('aria-busy');
    expect(btn.querySelector('svg')).not.toHaveClass('animate-spin');
  });

  it('locks at once but waits for the delay before spinning', () => {
    render(<IconBusyButton icon={RefreshCw} pending aria-label="Refresh" />);
    const btn = screen.getByRole('button', { name: 'Refresh' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.querySelector('svg')).not.toHaveClass('animate-spin');
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    expect(btn.querySelector('svg')).toHaveClass('animate-spin');
  });

  it('never spins when the work finishes inside the delay', () => {
    const { rerender } = render(<IconBusyButton icon={RefreshCw} pending aria-label="Refresh" />);
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS - 20);
    });
    rerender(<IconBusyButton icon={RefreshCw} pending={false} aria-label="Refresh" />);
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    const btn = screen.getByRole('button', { name: 'Refresh' });
    expect(btn).toBeEnabled();
    expect(btn.querySelector('svg')).not.toHaveClass('animate-spin');
  });

  it('swaps the label through stacked copies after the delay', () => {
    render(<IconBusyButton icon={RefreshCw} pending label="Recheck" busyLabel="Rechecking..." />);
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    expect(screen.getByRole('button', { name: 'Rechecking...' })).toHaveAttribute('aria-busy', 'true');
  });

  it('swaps to busyIcon instead of turning the resting icon', () => {
    const { container } = render(
      <IconBusyButton icon={ShieldCheck} busyIcon={Loader2} pending aria-label="Scan" />,
    );
    expect(container.querySelector('.lucide-shield-check')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    expect(container.querySelector('.lucide-shield-check')).toBeNull();
    expect(container.querySelector('.lucide-loader-circle')).toHaveClass('animate-spin');
  });

  it('stays disabled when the caller disables it while idle', () => {
    render(<IconBusyButton icon={RefreshCw} pending={false} disabled aria-label="Refresh" />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });
});

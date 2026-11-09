import type { FormEvent } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
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

  it('returns to idle after busy chrome has shown', () => {
    const { rerender, container } = render(
      <IconBusyButton icon={ShieldCheck} busyIcon={Loader2} pending label="Scan" />,
    );
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
    rerender(<IconBusyButton icon={ShieldCheck} busyIcon={Loader2} pending={false} label="Scan" />);
    const btn = screen.getByRole('button', { name: 'Scan' });
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute('aria-busy');
    expect(container.querySelector('.lucide-shield-check')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('does not submit a form by default', () => {
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <IconBusyButton icon={RefreshCw} pending={false} aria-label="Refresh" />
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('fires onClick when idle and not while pending', () => {
    const onClick = vi.fn();
    const { rerender } = render(<IconBusyButton icon={RefreshCw} pending={false} onClick={onClick} aria-label="Refresh" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<IconBusyButton icon={RefreshCw} pending onClick={onClick} aria-label="Refresh" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

});

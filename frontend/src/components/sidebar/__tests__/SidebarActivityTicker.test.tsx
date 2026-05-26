import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarActivityTicker } from '../SidebarActivityTicker';
import type { SidebarActivitySummary } from '../useSidebarActivitySummary';
import type { NotificationItem } from '@/components/dashboard/types';

const baseNotif: NotificationItem = {
  id: 42,
  level: 'info',
  message: 'web deployed',
  timestamp: Math.floor(Date.now() / 1000) - 12,
  is_read: 0,
  stack_name: 'web',
};

function renderWith(summary: SidebarActivitySummary) {
  const onAction = vi.fn();
  const utils = render(<SidebarActivityTicker summary={summary} onAction={onAction} />);
  return { ...utils, onAction };
}

describe('SidebarActivityTicker', () => {
  it('renders the quiet-live idle copy with a green dot', () => {
    renderWith({ kind: 'quiet-live' });
    expect(screen.getByText(/Live · no stack changes in 1h/i)).toBeInTheDocument();
    expect(screen.getByTestId('ticker-dot')).toHaveClass('bg-success');
  });

  it('renders the disconnected state with an amber dot and notifications-paused kicker', () => {
    renderWith({ kind: 'disconnected' });
    expect(screen.getByText(/Notifications reconnecting/)).toBeInTheDocument();
    expect(screen.getByText(/NOTIFICATIONS PAUSED/)).toBeInTheDocument();
    expect(screen.getByTestId('ticker-dot')).toHaveClass('bg-warning');
  });

  it('renders an active deploy with pulsing brand dot and stack name', () => {
    renderWith({ kind: 'active-op', stackName: 'api', action: 'deploy', startedAt: Date.now() - 1000 });
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.getByText(/Deploying/)).toBeInTheDocument();
    const dot = screen.getByTestId('ticker-dot');
    expect(dot).toHaveClass('bg-brand');
    expect(dot).toHaveClass('animate-pulse');
  });

  it('renders failure state with destructive dot and routes click to open-stack-notification', () => {
    const errNotif = { ...baseNotif, level: 'error' as const, message: 'deploy failed' };
    const { onAction } = renderWith({ kind: 'failure', notif: errNotif });
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
    expect(screen.getByTestId('ticker-dot')).toHaveClass('bg-destructive');
    fireEvent.click(screen.getByRole('button'));
    expect(onAction).toHaveBeenCalledWith({
      kind: 'open-stack-notification',
      summary: { kind: 'failure', notif: errNotif },
    });
  });

  it('renders automation state with next-run time, and routes click to open-auto-updates', () => {
    const nextRun = Math.floor(Date.now() / 1000) + 600;
    const { onAction } = renderWith({ kind: 'automation', nextRunAt: nextRun });
    expect(screen.getByText(/Auto-update/)).toBeInTheDocument();
    expect(screen.getByText(/next run/)).toBeInTheDocument();
    expect(screen.getByTestId('ticker-dot')).toHaveClass('bg-warning');
    fireEvent.click(screen.getByRole('button'));
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-auto-updates' });
  });

  it('renders recent-event with stack name and routes click to open-stack-notification', () => {
    const { onAction } = renderWith({ kind: 'recent-event', notif: baseNotif });
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText(/deployed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(onAction).toHaveBeenCalledWith({
      kind: 'open-stack-notification',
      summary: { kind: 'recent-event', notif: baseNotif },
    });
  });

  it('quiet-live click opens activity', () => {
    const { onAction } = renderWith({ kind: 'quiet-live' });
    fireEvent.click(screen.getByRole('button'));
    expect(onAction).toHaveBeenCalledWith({ kind: 'open-activity' });
  });

  it('active-op and disconnected are non-clickable noops', () => {
    const { onAction, rerender } = renderWith({ kind: 'active-op', stackName: 'api', action: 'deploy', startedAt: Date.now() });
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onAction).not.toHaveBeenCalled();
    rerender(<SidebarActivityTicker summary={{ kind: 'disconnected' }} onAction={onAction} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

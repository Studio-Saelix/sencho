import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationPanel } from '../NotificationPanel';
import type { NotificationItem } from '../dashboard/types';
import type { Node } from '@/context/NodeContext';
import * as AuthContext from '@/context/AuthContext';

vi.mock('@/context/AuthContext');
vi.mock('@/lib/muteRules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/muteRules')>()),
  createMuteFromNotification: vi.fn().mockResolvedValue(true),
}));

const nodes = [{ id: 1, name: 'local', type: 'local' }] as unknown as Node[];

function notif(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    level: 'warning',
    message: 'web is unhealthy',
    timestamp: Date.now(),
    is_read: 0,
    nodeId: 1,
    stack_name: 'web',
    category: 'monitor_alert',
    ...overrides,
  };
}

function setup(opts: { notifications?: NotificationItem[]; isAdmin?: boolean } = {}) {
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    isAdmin: opts.isAdmin ?? false,
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
  const handlers = {
    onMarkAllRead: vi.fn(),
    onMarkRead: vi.fn(),
    onClearAll: vi.fn(),
    onDelete: vi.fn(),
    onNavigate: vi.fn(),
    onOpenChange: vi.fn(),
  };
  render(
    <NotificationPanel
      notifications={opts.notifications ?? [notif()]}
      nodes={nodes}
      open
      {...handlers}
    />,
  );
  return handlers;
}

describe('NotificationPanel row actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks one row read and leaves the panel open and the row unnavigated', async () => {
    const user = userEvent.setup();
    const target = notif({ id: 4 });
    const h = setup({ notifications: [target] });

    await user.click(screen.getByRole('button', { name: 'Mark read' }));

    expect(h.onMarkRead).toHaveBeenCalledWith(expect.objectContaining({ id: 4, nodeId: 1 }));
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.onOpenChange).not.toHaveBeenCalled();
  });

  it('offers Mark read only on unread rows', () => {
    setup({ notifications: [notif({ id: 1, is_read: 1 }), notif({ id: 2, is_read: 0 })] });
    expect(screen.getAllByRole('button', { name: 'Mark read' })).toHaveLength(1);
  });

  it('shows Mute to an admin and keeps the panel open while muting', async () => {
    const { createMuteFromNotification } = await import('@/lib/muteRules');
    const user = userEvent.setup();
    const h = setup({ isAdmin: true });

    await user.click(screen.getByRole('button', { name: 'Mute options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mute this stack' }));

    expect(createMuteFromNotification).toHaveBeenCalledWith(expect.objectContaining({ stack_name: 'web' }), 'stack');
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.onOpenChange).not.toHaveBeenCalled();
  });

  it('hides Mute from an account that cannot create mute rules', () => {
    setup({ isAdmin: false });
    expect(screen.queryByRole('button', { name: 'Mute options' })).not.toBeInTheDocument();
  });

  it('still navigates and closes the panel when the row itself is clicked', async () => {
    const user = userEvent.setup();
    const h = setup();

    const row = screen.getByRole('button', { name: 'Open web' });
    await user.click(within(row).getByText('web is unhealthy'));

    expect(h.onNavigate).toHaveBeenCalledTimes(1);
    expect(h.onOpenChange).toHaveBeenCalledWith(false);
  });
});

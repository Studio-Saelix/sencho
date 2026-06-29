import { describe, it, expect } from 'vitest';
import type { NotificationItem } from '@/components/dashboard/types';
import {
  countVisibleUnread,
  filterPanelVisible,
  isPanelHiddenNotification,
  isVisibleUnread,
} from '@/lib/notificationVisibility';

function notif(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    level: 'info',
    message: 'test',
    timestamp: 1000,
    is_read: 0,
    ...overrides,
  };
}

describe('notificationVisibility', () => {
  it('hides unread deploy_success from a human actor', () => {
    const n = notif({ category: 'deploy_success', actor_username: 'alice' });
    expect(isPanelHiddenNotification(n)).toBe(true);
    expect(isVisibleUnread(n)).toBe(false);
    expect(countVisibleUnread([n])).toBe(0);
    expect(filterPanelVisible([n])).toEqual([]);
  });

  it('shows unread monitor_alert and node_update_available', () => {
    const monitor = notif({ category: 'monitor_alert', level: 'warning' });
    const update = notif({ category: 'node_update_available' });
    expect(isPanelHiddenNotification(monitor)).toBe(false);
    expect(isVisibleUnread(monitor)).toBe(true);
    expect(isVisibleUnread(update)).toBe(true);
    expect(countVisibleUnread([monitor, update])).toBe(2);
  });

  it('shows scheduler image_update_applied (system actor, not human)', () => {
    const n = notif({ category: 'image_update_applied', actor_username: 'system:scheduler' });
    expect(isPanelHiddenNotification(n)).toBe(false);
    expect(isVisibleUnread(n)).toBe(true);
  });

  it('does not count read panel-hidden notifications as visible unread', () => {
    const n = notif({ category: 'stack_started', actor_username: 'bob', is_read: 1 });
    expect(isPanelHiddenNotification(n)).toBe(true);
    expect(isVisibleUnread(n)).toBe(false);
  });

  it('badge count ignores hidden unread but includes visible unread', () => {
    const hidden = notif({ id: 1, category: 'deploy_success', actor_username: 'alice' });
    const visible = notif({ id: 2, category: 'monitor_alert', level: 'error' });
    expect(countVisibleUnread([hidden, visible])).toBe(1);
  });
});

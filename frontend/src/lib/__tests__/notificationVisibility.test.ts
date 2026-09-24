import { describe, it, expect } from 'vitest';
import type { NotificationItem } from '@/components/dashboard/types';
import {
  countVisibleUnread,
  filterPanelVisible,
  isActionableAlert,
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

  it('shows unread dev_build_update_available', () => {
    const n = notif({ category: 'dev_build_update_available' });
    expect(isPanelHiddenNotification(n)).toBe(false);
    expect(isVisibleUnread(n)).toBe(true);
    expect(countVisibleUnread([n])).toBe(1);
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

describe('isActionableAlert', () => {
  it('passes warnings and errors', () => {
    expect(isActionableAlert(notif({ category: 'monitor_alert', level: 'warning' }))).toBe(true);
    expect(isActionableAlert(notif({ category: 'deploy_failure', level: 'error' }))).toBe(true);
  });

  it('passes the info categories that ask for an action', () => {
    expect(isActionableAlert(notif({ category: 'image_update_available' }))).toBe(true);
    expect(isActionableAlert(notif({ category: 'node_update_available' }))).toBe(true);
    expect(isActionableAlert(notif({ category: 'dev_build_update_available' }))).toBe(true);
  });

  it('rejects info rows that only report history', () => {
    // A completion record with nothing to act on, even from a system actor, so
    // it is not panel-hidden and the category is the only thing excluding it.
    expect(isActionableAlert(notif({ category: 'image_update_applied', actor_username: 'system:scheduler' }))).toBe(false);
    expect(isActionableAlert(notif({ category: 'health_gate_passed' }))).toBe(false);
    expect(isActionableAlert(notif({ category: 'monitor_alert' }))).toBe(false);
  });

  it('rejects an info row with no category', () => {
    expect(isActionableAlert(notif())).toBe(false);
  });

  it('rejects info rows the feed hides', () => {
    expect(isActionableAlert(notif({ category: 'deploy_success', actor_username: 'alice' }))).toBe(false);
    expect(isActionableAlert(notif({ category: 'stack_restarted', actor_username: 'bob' }))).toBe(false);
  });

  it('treats severity as the stronger signal than the category filter', () => {
    // The category filter only applies at info level, so a warning in a
    // routinely-hidden category is still actionable.
    expect(isActionableAlert(notif({ category: 'stack_restarted', level: 'warning' }))).toBe(true);
  });

  it('does not care whether the row has been read', () => {
    // The Home preview answers "what needs me", not "what is new"; read state
    // belongs to the bell badge.
    expect(isActionableAlert(notif({ category: 'monitor_alert', level: 'error', is_read: 1 }))).toBe(true);
  });
});

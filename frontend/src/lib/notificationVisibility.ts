import type { NotificationCategory, NotificationItem } from '@/components/dashboard/types';

const PANEL_HIDDEN_CATEGORIES = new Set<NotificationCategory>([
  'deploy_success',
  'stack_started',
  'stack_stopped',
  'stack_restarted',
  'image_update_applied',
]);

function isHumanActor(actor: string | null | undefined): boolean {
  if (actor == null || actor === '') return false;
  if (actor === 'system' || actor.startsWith('system:')) return false;
  return true;
}

/**
 * User-initiated stack success events are surfaced in the activity timeline
 * and sidebar ticker; hide them from the notification panel feed.
 */
export function isPanelHiddenNotification(n: NotificationItem): boolean {
  if (n.level !== 'info' || n.category === undefined) return false;
  if (!PANEL_HIDDEN_CATEGORIES.has(n.category as NotificationCategory)) return false;
  return isHumanActor(n.actor_username);
}

export function isVisibleUnread(n: NotificationItem): boolean {
  return !n.is_read && !isPanelHiddenNotification(n);
}

export function countVisibleUnread(notifications: NotificationItem[]): number {
  return notifications.filter(isVisibleUnread).length;
}

export function filterPanelVisible(notifications: NotificationItem[]): NotificationItem[] {
  return notifications.filter((n) => !isPanelHiddenNotification(n));
}

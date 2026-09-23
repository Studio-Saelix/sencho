import type { NotificationCategory, NotificationItem } from '@/components/dashboard/types';

const PANEL_HIDDEN_CATEGORIES = new Set<NotificationCategory>([
  'deploy_success',
  'stack_started',
  'stack_stopped',
  'stack_restarted',
  'stack_taken_down',
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

/**
 * Info-level categories that still ask the operator to do something. Absent on
 * purpose: `image_update_applied`, a completion record with nothing to act on.
 * The Home preview answers "what needs me", not "what happened"; applied rows
 * would otherwise crowd warnings out of its fixed-size preview.
 */
const ACTIONABLE_INFO_CATEGORIES = new Set<NotificationCategory>([
  'image_update_available',
  'node_update_available',
  'dev_build_update_available',
]);

/**
 * Narrower than `filterPanelVisible`, the feed's own predicate: on top of what
 * the panel already hides, this also drops info-level rows outside
 * `ACTIONABLE_INFO_CATEGORIES`. The feed keeps those rows; the preview does not.
 */
export function isActionableAlert(n: NotificationItem): boolean {
  if (isPanelHiddenNotification(n)) return false;
  if (n.level === 'warning' || n.level === 'error') return true;
  if (n.level !== 'info' || n.category === undefined) return false;
  return ACTIONABLE_INFO_CATEGORIES.has(n.category as NotificationCategory);
}

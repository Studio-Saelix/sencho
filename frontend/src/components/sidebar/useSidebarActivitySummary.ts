import { useEffect, useMemo, useReducer } from 'react';
import type { ActionVerb, DeployPanelState } from '@/context/DeployFeedbackContext';
import type { NotificationItem } from '@/components/dashboard/types';

const NOW_TICK_MS = 10_000;
const FAILURE_WINDOW_SECS = 24 * 60 * 60;
const RECENT_WINDOW_SECS = 60 * 60;

export type SidebarActivitySummary =
  | { kind: 'active-op'; stackName: string; action: ActionVerb; startedAt: number }
  | { kind: 'failure'; notif: NotificationItem }
  | { kind: 'automation'; nextRunAt: number }
  | { kind: 'recent-event'; notif: NotificationItem }
  | { kind: 'quiet-live' }
  | { kind: 'disconnected' };

interface SummaryInputs {
  notifications: NotificationItem[];
  tickerConnected: boolean;
  panelState: DeployPanelState;
  panelStartedAt: number | null;
  nextAutoUpdateRunAt: number | null;
}

function findFailure(notifications: NotificationItem[], nowSecs: number): NotificationItem | null {
  for (const n of notifications) {
    if (n.level !== 'error') continue;
    if (n.is_read) continue;
    // System-level errors with no stack_name cannot be routed via
    // navigateToNotification; let the top-bar NotificationPanel surface them
    // instead so the sidebar footer's "view logs" click always lands somewhere.
    if (!n.stack_name) continue;
    if (nowSecs - n.timestamp > FAILURE_WINDOW_SECS) continue;
    return n;
  }
  return null;
}

function findRecent(notifications: NotificationItem[], nowSecs: number): NotificationItem | null {
  for (const n of notifications) {
    if (!n.stack_name) continue;
    if (n.level === 'error') continue;
    if (nowSecs - n.timestamp > RECENT_WINDOW_SECS) continue;
    return n;
  }
  return null;
}

/**
 * Priority cascade (first match wins):
 *   1. active-op:    a deploy panel is preparing/streaming
 *   2. failure:      newest unread stack-scoped error in the last 24h
 *   3. recent-event: newest non-error stack notification in the last hour
 *   4. automation:   a next auto-update run is scheduled
 *   5. disconnected: notification WebSocket is down
 *   6. quiet-live:   nothing else to surface
 *
 * Note: recent-event preempts automation because a fresh deploy/restart event
 * is more time-relevant than ambient steady-state ("your last action was 30s
 * ago" beats "auto-update will run at 02:00"). The PR description and tests
 * follow the same order; if you change the cascade, update both.
 */
function deriveSummary(inputs: SummaryInputs, nowSecs: number): SidebarActivitySummary {
  const { panelState, panelStartedAt, notifications, nextAutoUpdateRunAt, tickerConnected } = inputs;

  if (panelState.isOpen && (panelState.status === 'preparing' || panelState.status === 'streaming') && panelStartedAt !== null) {
    return { kind: 'active-op', stackName: panelState.stackName, action: panelState.action, startedAt: panelStartedAt };
  }

  // Notifications are pre-sorted newest-first by useNotifications.
  const failure = findFailure(notifications, nowSecs);
  if (failure) {
    return { kind: 'failure', notif: failure };
  }

  const recent = findRecent(notifications, nowSecs);
  if (!recent && nextAutoUpdateRunAt !== null) {
    return { kind: 'automation', nextRunAt: nextAutoUpdateRunAt };
  }

  if (recent) {
    return { kind: 'recent-event', notif: recent };
  }

  if (!tickerConnected) {
    return { kind: 'disconnected' };
  }

  return { kind: 'quiet-live' };
}

export function useSidebarActivitySummary(inputs: SummaryInputs): SidebarActivitySummary {
  const [tick, forceTick] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const id = setInterval(forceTick, NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => deriveSummary(inputs, Math.floor(Date.now() / 1000)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      tick,
      inputs.notifications,
      inputs.tickerConnected,
      inputs.panelState.isOpen,
      inputs.panelState.stackName,
      inputs.panelState.action,
      inputs.panelState.status,
      inputs.panelStartedAt,
      inputs.nextAutoUpdateRunAt,
    ],
  );
}

// Exported for unit tests so we don't need to spin up a renderer to validate cascade logic.
export const __testing = { deriveSummary };

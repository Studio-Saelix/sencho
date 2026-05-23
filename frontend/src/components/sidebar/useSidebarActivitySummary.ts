import { useEffect, useMemo, useReducer } from 'react';
import type { ActionVerb, DeployPanelState } from '@/context/DeployFeedbackContext';
import type { NotificationItem } from '@/components/dashboard/types';

const NOW_TICK_MS = 10_000;
const FAILURE_WINDOW_SECS = 24 * 60 * 60;
const RECENT_WINDOW_SECS = 60 * 60;

export type SidebarActivitySummary =
  | { kind: 'active-op'; stackName: string; action: ActionVerb; startedAt: number }
  | { kind: 'failure'; notif: NotificationItem }
  | { kind: 'automation'; enabledCount: number; totalCount: number; nextRunAt: number }
  | { kind: 'recent-event'; notif: NotificationItem }
  | { kind: 'quiet-live' }
  | { kind: 'disconnected' };

interface SummaryInputs {
  notifications: NotificationItem[];
  tickerConnected: boolean;
  panelState: DeployPanelState;
  panelStartedAt: number | null;
  /** Pre-aggregated by the caller so the memo dep list stays scalar; see EditorLayout. */
  autoUpdateEnabledCount: number;
  totalStackCount: number;
  nextAutoUpdateRunAt: number | null;
}

function findFailure(notifications: NotificationItem[], nowSecs: number): NotificationItem | null {
  for (const n of notifications) {
    if (n.level !== 'error') continue;
    if (n.is_read) continue;
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

function deriveSummary(inputs: SummaryInputs, nowSecs: number): SidebarActivitySummary {
  const { panelState, panelStartedAt, notifications, autoUpdateEnabledCount, totalStackCount, nextAutoUpdateRunAt, tickerConnected } = inputs;

  if (panelState.isOpen && (panelState.status === 'preparing' || panelState.status === 'streaming') && panelStartedAt !== null) {
    return { kind: 'active-op', stackName: panelState.stackName, action: panelState.action, startedAt: panelStartedAt };
  }

  // Notifications are pre-sorted newest-first by useNotifications.
  const failure = findFailure(notifications, nowSecs);
  if (failure) {
    return { kind: 'failure', notif: failure };
  }

  const recent = findRecent(notifications, nowSecs);
  if (!recent && autoUpdateEnabledCount > 0 && nextAutoUpdateRunAt !== null) {
    return { kind: 'automation', enabledCount: autoUpdateEnabledCount, totalCount: totalStackCount, nextRunAt: nextAutoUpdateRunAt };
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
      inputs.autoUpdateEnabledCount,
      inputs.totalStackCount,
      inputs.nextAutoUpdateRunAt,
    ],
  );
}

// Exported for unit tests so we don't need to spin up a renderer to validate cascade logic.
export const __testing = { deriveSummary };

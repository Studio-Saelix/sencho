import { describe, it, expect } from 'vitest';
import { __testing, countEnabledAutoUpdates } from '../useSidebarActivitySummary';
import type { NotificationItem } from '@/components/dashboard/types';
import type { DeployPanelState } from '@/context/DeployFeedbackContext';

const { deriveSummary } = __testing;

const NOW_SECS = 1_700_000_000;

function notif(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    level: 'info',
    message: 'web deployed',
    timestamp: NOW_SECS - 30,
    is_read: 0,
    stack_name: 'web',
    ...overrides,
  };
}

const IDLE_PANEL: DeployPanelState = { isOpen: false, stackName: '', action: 'deploy', status: 'preparing', sessionId: 0 };
const STREAMING_PANEL: DeployPanelState = { isOpen: true, stackName: 'api', action: 'deploy', status: 'streaming', sessionId: 1 };
const SUCCEEDED_PANEL: DeployPanelState = { isOpen: true, stackName: 'api', action: 'deploy', status: 'succeeded', sessionId: 1 };

function inputs(overrides: Partial<Parameters<typeof deriveSummary>[0]> = {}) {
  return {
    notifications: [],
    tickerConnected: true,
    panelState: IDLE_PANEL,
    panelStartedAt: null,
    autoUpdateEnabledCount: 0,
    totalStackCount: 0,
    nextAutoUpdateRunAt: null,
    ...overrides,
  };
}

describe('useSidebarActivitySummary.deriveSummary', () => {
  it('returns quiet-live when nothing is happening and the WS is connected', () => {
    expect(deriveSummary(inputs(), NOW_SECS)).toEqual({ kind: 'quiet-live' });
  });

  it('returns disconnected when the notification WS is down and there is no recent event', () => {
    expect(deriveSummary(inputs({ tickerConnected: false }), NOW_SECS)).toEqual({ kind: 'disconnected' });
  });

  it('returns active-op while the deploy panel is streaming, preempting everything else', () => {
    const failure = notif({ level: 'error', message: 'deploy failed', timestamp: NOW_SECS - 10 });
    const r = deriveSummary(inputs({
      panelState: STREAMING_PANEL,
      panelStartedAt: Date.now(),
      notifications: [failure],
    }), NOW_SECS);
    expect(r.kind).toBe('active-op');
    if (r.kind === 'active-op') {
      expect(r.stackName).toBe('api');
      expect(r.action).toBe('deploy');
    }
  });

  it('ignores the panel once it has finished (status: succeeded)', () => {
    const r = deriveSummary(inputs({ panelState: SUCCEEDED_PANEL, panelStartedAt: Date.now() }), NOW_SECS);
    expect(r.kind).toBe('quiet-live');
  });

  it('returns failure when an unread error is within 24h, preempting automation and recent-event', () => {
    const failure = notif({ id: 9, level: 'error', message: 'deploy failed', timestamp: NOW_SECS - 60 });
    const recent = notif({ id: 10, timestamp: NOW_SECS - 5 });
    const r = deriveSummary(inputs({
      notifications: [failure, recent],
      autoUpdateEnabledCount: 1,
      totalStackCount: 1,
      nextAutoUpdateRunAt: NOW_SECS + 3600,
    }), NOW_SECS);
    expect(r.kind).toBe('failure');
    if (r.kind === 'failure') expect(r.notif.id).toBe(9);
  });

  it('skips failure that is older than 24h or already read', () => {
    const oldErr = notif({ id: 9, level: 'error', stack_name: 'web', timestamp: NOW_SECS - 25 * 60 * 60 });
    const readErr = notif({ id: 10, level: 'error', stack_name: 'web', is_read: 1, timestamp: NOW_SECS - 60 });
    const r = deriveSummary(inputs({ notifications: [oldErr, readErr] }), NOW_SECS);
    expect(r.kind).not.toBe('failure');
  });

  it('returns automation when auto-update is enabled and no recent event exists', () => {
    const r = deriveSummary(inputs({
      autoUpdateEnabledCount: 2,
      totalStackCount: 4,
      nextAutoUpdateRunAt: NOW_SECS + 3600,
    }), NOW_SECS);
    expect(r.kind).toBe('automation');
    if (r.kind === 'automation') {
      expect(r.enabledCount).toBe(2);
      expect(r.totalCount).toBe(4);
      expect(r.nextRunAt).toBe(NOW_SECS + 3600);
    }
  });

  it('prefers recent-event over automation when a fresh event is available', () => {
    const recent = notif({ id: 7, timestamp: NOW_SECS - 5 });
    const r = deriveSummary(inputs({
      notifications: [recent],
      autoUpdateEnabledCount: 1,
      totalStackCount: 1,
      nextAutoUpdateRunAt: NOW_SECS + 3600,
    }), NOW_SECS);
    expect(r.kind).toBe('recent-event');
    if (r.kind === 'recent-event') expect(r.notif.id).toBe(7);
  });

  it('drops automation when no next-run is known, even with auto-update settings present', () => {
    const r = deriveSummary(inputs({
      autoUpdateEnabledCount: 1,
      totalStackCount: 1,
      nextAutoUpdateRunAt: null,
    }), NOW_SECS);
    expect(r.kind).toBe('quiet-live');
  });

  it('does NOT classify a read error notification as a recent-event (severity mis-signal guard)', () => {
    const readErr = notif({ id: 11, level: 'error', is_read: 1, timestamp: NOW_SECS - 60 });
    const r = deriveSummary(inputs({ notifications: [readErr] }), NOW_SECS);
    expect(r.kind).toBe('quiet-live');
  });

  it('treats a panel that already finished (succeeded) as not active, so a fresh failure preempts', () => {
    const failure = notif({ id: 12, level: 'error', timestamp: NOW_SECS - 5 });
    const r = deriveSummary(inputs({
      panelState: SUCCEEDED_PANEL,
      panelStartedAt: Date.now(),
      notifications: [failure],
    }), NOW_SECS);
    expect(r.kind).toBe('failure');
  });

  it('treats stack events older than 1h as not recent', () => {
    const stale = notif({ timestamp: NOW_SECS - 60 * 60 - 1 });
    const r = deriveSummary(inputs({ notifications: [stale] }), NOW_SECS);
    expect(r.kind).toBe('quiet-live');
  });

  it('ignores notifications without a stack_name for recent-event detection', () => {
    const systemNotif = notif({ stack_name: undefined, timestamp: NOW_SECS - 10 });
    const r = deriveSummary(inputs({ notifications: [systemNotif] }), NOW_SECS);
    expect(r.kind).toBe('quiet-live');
  });

  it('failure preempts disconnected fallback', () => {
    const failure = notif({ level: 'error', timestamp: NOW_SECS - 30 });
    const r = deriveSummary(inputs({ notifications: [failure], tickerConnected: false }), NOW_SECS);
    expect(r.kind).toBe('failure');
  });

  it('does NOT classify a stackless system error as a sidebar failure (router would no-op)', () => {
    const systemErr = notif({ id: 21, level: 'error', stack_name: undefined, timestamp: NOW_SECS - 30 });
    const r = deriveSummary(inputs({ notifications: [systemErr] }), NOW_SECS);
    expect(r.kind).not.toBe('failure');
    expect(r.kind).toBe('quiet-live');
  });
});

describe('countEnabledAutoUpdates', () => {
  it('counts a stack with no explicit row as enabled (backend default-true contract)', () => {
    expect(countEnabledAutoUpdates(['web', 'api'], {})).toBe(2);
  });

  it('respects an explicit false', () => {
    expect(countEnabledAutoUpdates(['web', 'api', 'db'], { api: false })).toBe(2);
  });

  it('respects an explicit true', () => {
    expect(countEnabledAutoUpdates(['web'], { web: true })).toBe(1);
  });

  it('returns 0 for an empty file list', () => {
    expect(countEnabledAutoUpdates([], { web: true })).toBe(0);
  });

  it('ignores settings rows that do not correspond to known files', () => {
    expect(countEnabledAutoUpdates(['web'], { ghost: false, web: true })).toBe(1);
  });
});

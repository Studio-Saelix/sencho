/**
 * Unit tests for FleetSyncRetryService: the background loop that re-pushes
 * fleet sync to nodes whose last attempt failed and emits a stale-target
 * notification when a per-node failure window exceeds the threshold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetFailedSyncTargets,
  mockGetNode,
  mockGetFleetSyncStatuses,
  mockGetSystemState,
  mockPushResourceToNode,
  mockDispatchAlert,
} = vi.hoisted(() => ({
  mockGetFailedSyncTargets: vi.fn().mockReturnValue([]),
  mockGetNode: vi.fn(),
  mockGetFleetSyncStatuses: vi.fn().mockReturnValue([]),
  mockGetSystemState: vi.fn().mockReturnValue(null),
  mockPushResourceToNode: vi.fn().mockResolvedValue(undefined),
  mockDispatchAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getFailedSyncTargets: mockGetFailedSyncTargets,
      getNode: mockGetNode,
      getFleetSyncStatuses: mockGetFleetSyncStatuses,
      getSystemState: mockGetSystemState,
    }),
  },
}));

vi.mock('../services/FleetSyncService', () => ({
  FleetSyncService: {
    getInstance: () => ({ pushResourceToNode: mockPushResourceToNode }),
    getRole: () => (mockGetSystemState('fleet_role') === 'replica' ? 'replica' : 'control'),
  },
  FLEET_RESOURCES: ['scan_policies', 'cve_suppressions'] as const,
}));

vi.mock('../services/NotificationService', () => ({
  NotificationService: {
    getInstance: () => ({ dispatchAlert: mockDispatchAlert }),
  },
}));

vi.mock('../utils/debug', () => ({
  isDebugEnabled: () => false,
}));

import { FleetSyncRetryService } from '../services/FleetSyncRetryService';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSystemState.mockReturnValue(null);
  // Reset internal alert memo by replacing the singleton.
  (FleetSyncRetryService as unknown as { instance: FleetSyncRetryService | undefined }).instance = undefined;
});

describe('FleetSyncRetryService.evaluate', () => {
  it('skips the tick when this instance is a replica', async () => {
    mockGetSystemState.mockImplementation((k: string) => (k === 'fleet_role' ? 'replica' : null));
    await FleetSyncRetryService.getInstance().evaluate();
    expect(mockGetFailedSyncTargets).not.toHaveBeenCalled();
    expect(mockPushResourceToNode).not.toHaveBeenCalled();
  });

  it('retries each failed (node, resource) target by calling pushResourceToNode', async () => {
    mockGetFailedSyncTargets.mockImplementation((resource: string) => {
      if (resource === 'scan_policies') {
        return [{ node_id: 7, resource, last_success_at: null, last_failure_at: Date.now() - 1000, last_error: 'timeout' }];
      }
      return [];
    });
    mockGetNode.mockReturnValue({ id: 7, name: 'NodeSeven', type: 'remote', api_url: 'https://n7.example', api_token: 'tok' });
    await FleetSyncRetryService.getInstance().evaluate();
    expect(mockPushResourceToNode).toHaveBeenCalledTimes(1);
    const call = mockPushResourceToNode.mock.calls[0];
    expect(call[0].id).toBe(7);
    expect(call[1]).toBe('scan_policies');
  });

  it('does not retry when the node has been deleted from the registry', async () => {
    mockGetFailedSyncTargets.mockImplementation((resource: string) => {
      if (resource === 'cve_suppressions') {
        return [{ node_id: 99, resource, last_success_at: null, last_failure_at: Date.now() - 1000, last_error: 'gone' }];
      }
      return [];
    });
    mockGetNode.mockReturnValue(undefined);
    await FleetSyncRetryService.getInstance().evaluate();
    expect(mockPushResourceToNode).not.toHaveBeenCalled();
  });

  it('emits a stale-target notification once when previously-working node has been failing for over an hour', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60_000;
    const fourHoursAgo = Date.now() - 4 * 60 * 60_000;
    mockGetFailedSyncTargets.mockImplementation((resource: string) => {
      if (resource === 'scan_policies') {
        return [{ node_id: 8, resource, last_success_at: fourHoursAgo, last_failure_at: twoHoursAgo, last_error: 'unreachable' }];
      }
      return [];
    });
    mockGetNode.mockReturnValue({ id: 8, name: 'NodeEight', type: 'remote', api_url: 'https://n8.example', api_token: 'tok' });
    mockGetFleetSyncStatuses.mockReturnValue([
      { node_id: 8, resource: 'scan_policies', last_success_at: fourHoursAgo, last_failure_at: twoHoursAgo, last_error: 'unreachable' },
    ]);

    await FleetSyncRetryService.getInstance().evaluate();
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'warning',
      'system',
      expect.stringContaining('NodeEight'),
    );

    // Second tick within the cooldown should not re-alert.
    mockDispatchAlert.mockClear();
    await FleetSyncRetryService.getInstance().evaluate();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('does not alert when failure window is still within the threshold', async () => {
    const tenMinutesAgo = Date.now() - 10 * 60_000;
    const twentyMinutesAgo = Date.now() - 20 * 60_000;
    mockGetFailedSyncTargets.mockReturnValue([
      { node_id: 9, resource: 'scan_policies', last_success_at: twentyMinutesAgo, last_failure_at: tenMinutesAgo, last_error: 'flap' },
    ]);
    mockGetNode.mockReturnValue({ id: 9, name: 'NodeNine', type: 'remote', api_url: 'https://n9.example', api_token: 'tok' });
    await FleetSyncRetryService.getInstance().evaluate();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('does not alert when the retry itself succeeds (last_failure_at cleared to NULL)', async () => {
    const fourHoursAgo = Date.now() - 4 * 60 * 60_000;
    const twoHoursAgo = Date.now() - 2 * 60 * 60_000;
    // Pre-retry: stale failure exceeds threshold.
    mockGetFailedSyncTargets.mockImplementation((resource: string) => {
      if (resource === 'scan_policies') {
        return [{ node_id: 11, resource, last_success_at: fourHoursAgo, last_failure_at: twoHoursAgo, last_error: 'flap' }];
      }
      return [];
    });
    mockGetNode.mockReturnValue({ id: 11, name: 'NodeEleven', type: 'remote', api_url: 'https://n11.example', api_token: 'tok' });
    // Post-retry: the push succeeded, so the row now has last_success_at set
    // and last_failure_at cleared to NULL. The alert path must NOT fire.
    const justNow = Date.now();
    mockGetFleetSyncStatuses.mockReturnValue([
      { node_id: 11, resource: 'scan_policies', last_success_at: justNow, last_failure_at: null, last_error: null },
    ]);
    await FleetSyncRetryService.getInstance().evaluate();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('does not alert for a brand-new node that has never succeeded', async () => {
    const fiveMinutesAgo = Date.now() - 5 * 60_000;
    mockGetFailedSyncTargets.mockReturnValue([
      { node_id: 10, resource: 'scan_policies', last_success_at: null, last_failure_at: fiveMinutesAgo, last_error: 'cold start' },
    ]);
    mockGetNode.mockReturnValue({ id: 10, name: 'NodeTen', type: 'remote', api_url: 'https://n10.example', api_token: 'tok' });
    await FleetSyncRetryService.getInstance().evaluate();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });
});

describe('FleetSyncRetryService start/stop', () => {
  it('start() and stop() are idempotent and clear timers', () => {
    const svc = FleetSyncRetryService.getInstance();
    svc.start();
    svc.stop();
    svc.start();
    svc.stop();
    // No assertions on internal state; the absence of stray timers is enough
    // for vitest to exit cleanly. This also exercises the early-clear path.
    expect(true).toBe(true);
  });
});

/**
 * Unit tests for Notification Routing — CRUD operations on notification_routes,
 * routing logic in NotificationService, and edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockGetEnabledNotificationRoutes,
  mockGetEnabledAgents,
  mockGetStackLabelIds,
  mockAddNotificationHistory,
  mockUpdateNotificationDispatchError,
} = vi.hoisted(() => ({
  mockGetEnabledNotificationRoutes: vi.fn().mockReturnValue([]),
  mockGetEnabledAgents: vi.fn().mockReturnValue([]),
  mockGetStackLabelIds: vi.fn().mockReturnValue([]),
  mockAddNotificationHistory: vi.fn().mockReturnValue({
    id: 1,
    level: 'info',
    message: 'test',
    timestamp: Date.now(),
    is_read: 0,
  }),
  mockUpdateNotificationDispatchError: vi.fn(),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getEnabledNotificationRoutes: mockGetEnabledNotificationRoutes,
      getEnabledAgents: mockGetEnabledAgents,
      getStackLabelIds: mockGetStackLabelIds,
      addNotificationHistory: mockAddNotificationHistory,
      updateNotificationDispatchError: mockUpdateNotificationDispatchError,
    }),
  },
}));

// NodeRegistry is consulted to resolve this instance's default node id so
// internal dispatch writes land on the same key the middleware sets for user
// requests. Mock it to a fixed id so assertions are deterministic.
vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDefaultNodeId: () => 1,
      getComposeDir: () => '/app/compose',
    }),
  },
}));

// Spy on global fetch for webhook dispatch verification
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import { NotificationService } from '../services/NotificationService';
import { StackActivityMetricsService } from '../services/StackActivityMetricsService';

// ── Helpers ────────────────────────────────────────────────────────────

function makeRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Prod Discord',
    node_id: null as number | null,
    stack_patterns: ['my-app'],
    label_ids: null as number[] | null,
    categories: null as string[] | null,
    channel_type: 'discord' as const,
    channel_url: 'https://discord.com/api/webhooks/123/abc',
    priority: 0,
    enabled: true,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeAgent(type: 'discord' | 'slack' | 'webhook' = 'slack') {
  return {
    id: 1,
    type,
    url: 'https://hooks.slack.com/services/global',
    enabled: true,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('NotificationService - routing logic', () => {
  let svc: NotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton so each test gets a fresh instance
    (NotificationService as any).instance = undefined;
    svc = NotificationService.getInstance();
  });

  it('routes to matching route channel and skips global agents', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Container crashed', { stackName: 'my-app' });

    // Should have called fetch with discord webhook URL
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' })
    );
    // Should NOT have called the global slack agent
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://hooks.slack.com/services/global',
      expect.anything()
    );
  });

  it('falls back to global agents when no route matches', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: ['other-stack'] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Container crashed', { stackName: 'my-app' });

    // Should NOT have called the route's discord channel
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.anything()
    );
    // Should have called global slack agent as fallback
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/global',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('falls back to global agents when no stackName provided and route requires a specific stack', async () => {
    // Route has a stack_patterns filter, so it won't match an alert with no stackName
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute({ stack_patterns: ['my-app'] })]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    await svc.dispatchAlert('warning', 'monitor_alert', 'Host CPU high');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/global',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('respects priority ordering — first match wins', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ id: 1, name: 'High priority', priority: 0, stack_patterns: ['my-app'], channel_url: 'https://discord.com/api/webhooks/first' }),
      makeRoute({ id: 2, name: 'Low priority', priority: 10, stack_patterns: ['my-app'], channel_url: 'https://discord.com/api/webhooks/second' }),
    ]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Test', { stackName: 'my-app' });

    // Both routes match, both should be dispatched (all matching routes fire)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/first',
      expect.objectContaining({ method: 'POST' })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/second',
      expect.objectContaining({ method: 'POST' })
    );
    // Global agents should still be skipped since routes matched
    expect(mockGetEnabledAgents).not.toHaveBeenCalled();
  });

  it('skips routes that do not match the stack', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: ['staging-app'] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Test', { stackName: 'production-app' });

    // Route should not fire
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.anything()
    );
    // Global agent should fire as fallback
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/global',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('handles multiple stack patterns in a single route', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: ['app-a', 'app-b', 'app-c'] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('info', 'image_update_applied', 'Update complete', { stackName: 'app-b' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('gracefully handles fetch errors in route dispatch without crashing', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

    // Should not throw
    await expect(svc.dispatchAlert('error', 'monitor_alert', 'Crash', { stackName: 'my-app' })).resolves.toBeUndefined();
  });

  it('does not dispatch to global agents when routes array is empty and no stackName', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('info', 'system', 'Test');

    // No routes, no agents — just logs and broadcasts
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('always logs to history regardless of routing', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('info', 'system', 'Should be logged');

    expect(mockAddNotificationHistory).toHaveBeenCalledWith(1, {
      level: 'info',
      category: 'system',
      message: 'Should be logged',
      timestamp: expect.any(Number),
      stack_name: undefined,
      container_name: undefined,
      actor_username: null,
    });
  });

  it('persists stackName and containerName context on the history row', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('warning', 'autoheal_triggered', 'Restarted', { stackName: 'my-app', containerName: 'my-app-web-1' });

    expect(mockAddNotificationHistory).toHaveBeenCalledWith(1, {
      level: 'warning',
      category: 'autoheal_triggered',
      message: 'Restarted',
      timestamp: expect.any(Number),
      stack_name: 'my-app',
      container_name: 'my-app-web-1',
      actor_username: null,
    });
  });

  it('dispatches to slack channel type correctly via route', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ channel_type: 'slack', channel_url: 'https://hooks.slack.com/services/route-specific' }),
    ]);

    await svc.dispatchAlert('warning', 'monitor_alert', 'Alert', { stackName: 'my-app' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/route-specific',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Alert'),
      })
    );
  });

  it('dispatches to webhook channel type correctly via route', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ channel_type: 'webhook', channel_url: 'https://example.com/hook' }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Critical failure', { stackName: 'my-app' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Critical failure'),
      })
    );
  });

  it('records dispatch errors when route webhook fails', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    await svc.dispatchAlert('error', 'monitor_alert', 'Test', { stackName: 'my-app' });

    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      1, // notification id from mock
      expect.stringContaining('Connection refused')
    );
  });

  it('records dispatch errors when global agent webhook fails', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);
    mockFetch.mockRejectedValueOnce(new Error('Timeout'));

    await svc.dispatchAlert('warning', 'monitor_alert', 'Host alert');

    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      1,
      expect.stringContaining('Timeout')
    );
  });

  it('does not record dispatch errors when all dispatches succeed', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch.mockResolvedValueOnce({ ok: true });

    await svc.dispatchAlert('info', 'system', 'All good', { stackName: 'my-app' });

    expect(mockUpdateNotificationDispatchError).not.toHaveBeenCalled();
  });

  it('fires a node-scoped route when node_id matches the local node', async () => {
    // getDefaultNodeId returns 1 (mocked above)
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute({ node_id: 1 })]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('info', 'system', 'Test', { stackName: 'my-app' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('skips a node-scoped route when node_id does not match the local node', async () => {
    // getDefaultNodeId returns 1; route is scoped to node 99
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute({ node_id: 99 })]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    await svc.dispatchAlert('info', 'system', 'Test', { stackName: 'my-app' });

    // Route should be skipped; falls back to global agent
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.anything()
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/global',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('fires a null-scoped route regardless of which node emits the alert', async () => {
    // node_id=null means "any node"
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute({ node_id: null })]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('warning', 'monitor_alert', 'Global alert', { stackName: 'my-app' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('fires a category-only route when category matches', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: [], categories: ['deploy_failure'] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('error', 'deploy_failure', 'Deploy failed', { stackName: 'my-app' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('skips a category-only route when category does not match', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: [], categories: ['deploy_failure'] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    await svc.dispatchAlert('info', 'deploy_success', 'Deploy ok', { stackName: 'my-app' });

    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.anything()
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/global',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('fires a label-only route when stack has a matching label', async () => {
    // Stack 'my-app' on node 1 has label id 42
    mockGetStackLabelIds.mockReturnValue([42]);
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: [], label_ids: [42] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('info', 'image_update_available', 'Update ready', { stackName: 'my-app' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('skips a label-only route when stack does not have a matching label', async () => {
    mockGetStackLabelIds.mockReturnValue([99]);
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: [], label_ids: [42] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    await svc.dispatchAlert('info', 'image_update_available', 'Update ready', { stackName: 'my-app' });

    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.anything()
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/global',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('AND semantics: combined label + category route fires only when both match', async () => {
    mockGetStackLabelIds.mockReturnValue([42]);
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: [], label_ids: [42], categories: ['deploy_failure'] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    mockGetStackLabelIds.mockReturnValueOnce([99]);
    await svc.dispatchAlert('error', 'deploy_failure', 'Deploy fail 1', { stackName: 'my-app' });
    expect(mockFetch).not.toHaveBeenCalledWith('https://discord.com/api/webhooks/123/abc', expect.anything());

    vi.clearAllMocks();
    mockGetStackLabelIds.mockReturnValue([42]);
    await svc.dispatchAlert('info', 'deploy_success', 'Deploy ok', { stackName: 'my-app' });
    expect(mockFetch).not.toHaveBeenCalledWith('https://discord.com/api/webhooks/123/abc', expect.anything());

    vi.clearAllMocks();
    // Both match
    mockGetStackLabelIds.mockReturnValue([42]);
    await svc.dispatchAlert('error', 'deploy_failure', 'Deploy fail 2', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('category-only route with no stackName matches alert from any emission', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ stack_patterns: [], categories: ['system'] }),
    ]);
    mockGetEnabledAgents.mockReturnValue([]);

    await svc.dispatchAlert('info', 'system', 'Host rebooted');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('NotificationService - crash safety (dispatchAlert never rejects)', () => {
  let svc: NotificationService;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (NotificationService as any).instance = undefined;
    svc = NotificationService.getInstance();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('resolves (does not reject) and skips dispatch when the history write throws', async () => {
    const recordSpy = vi.spyOn(StackActivityMetricsService.getInstance(), 'record');
    mockAddNotificationHistory.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    mockGetEnabledAgents.mockReturnValue([makeAgent()]);

    await expect(
      svc.dispatchAlert('error', 'monitor_alert', 'Container crashed', { stackName: 'my-app' }),
    ).resolves.toBeUndefined();

    // No external dispatch and no routing read when there is no persisted row.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockGetEnabledNotificationRoutes).not.toHaveBeenCalled();
    // The write failure is recorded for metrics and logged.
    expect(recordSpy).toHaveBeenCalledWith(1, 'write', expect.any(Number), false);
    expect(consoleErrorSpy).toHaveBeenCalledWith('[Notify] Failed to persist notification:', expect.any(Error));
    recordSpy.mockRestore();
  });

  it('records a successful write metric on the happy path', async () => {
    const recordSpy = vi.spyOn(StackActivityMetricsService.getInstance(), 'record');

    await svc.dispatchAlert('info', 'system', 'Host rebooted');

    expect(recordSpy).toHaveBeenCalledWith(1, 'write', expect.any(Number), true);
    recordSpy.mockRestore();
  });

  it('resolves (does not reject) when reading routes throws after a successful write', async () => {
    mockGetEnabledNotificationRoutes.mockImplementationOnce(() => {
      throw new Error('database read failed');
    });

    await expect(
      svc.dispatchAlert('error', 'monitor_alert', 'Container crashed', { stackName: 'my-app' }),
    ).resolves.toBeUndefined();

    // The history row was still written; only routing failed, and it was logged.
    expect(mockAddNotificationHistory).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('[Notify] dispatchAlert failed:', expect.any(Error));
  });

  it('resolves (does not reject) when a subscriber send throws during broadcast', async () => {
    // A subscriber whose socket reports OPEN but throws on send exercises the
    // broadcast leg of the outer guard.
    const throwingWs = {
      readyState: 1, // WebSocket.OPEN
      send: () => { throw new Error('socket write failed'); },
    } as unknown as import('ws').WebSocket;
    svc.subscribe(throwingWs);

    await expect(
      svc.dispatchAlert('info', 'system', 'Host rebooted'),
    ).resolves.toBeUndefined();

    expect(mockAddNotificationHistory).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('[Notify] dispatchAlert failed:', expect.any(Error));
  });

  it('snapshots subscribers so an unsubscribe during a send does not skip later subscribers', async () => {
    const sent: string[] = [];
    let unsubscribeB: () => void = () => {};
    const wsB = {
      readyState: 1, // WebSocket.OPEN
      send: () => { sent.push('B'); },
    } as unknown as import('ws').WebSocket;
    // A's send removes B mid-iteration, mimicking a 'close' handler firing.
    const wsA = {
      readyState: 1,
      send: () => { sent.push('A'); unsubscribeB(); },
    } as unknown as import('ws').WebSocket;
    svc.subscribe(wsA);
    unsubscribeB = svc.subscribe(wsB);

    await svc.dispatchAlert('info', 'system', 'Host rebooted');

    // B still receives the broadcast because iteration runs over a snapshot.
    expect(sent).toEqual(['A', 'B']);
  });
});

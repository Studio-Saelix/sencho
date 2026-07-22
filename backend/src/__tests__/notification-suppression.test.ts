/**
 * Unit tests for notification suppression in NotificationService.dispatchAlert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetEnabledNotificationRoutes,
  mockGetEnabledAgents,
  mockGetStackLabelIds,
  mockAddNotificationHistory,
  mockUpdateNotificationDispatchError,
  mockGetEnabledNotificationSuppressionRules,
  mockUpdateNotificationSuppressionMatch,
  mockBroadcast,
  mockGetGlobalSettings,
} = vi.hoisted(() => ({
  mockGetEnabledNotificationRoutes: vi.fn().mockReturnValue([]),
  mockGetEnabledAgents: vi.fn().mockReturnValue([]),
  mockGetStackLabelIds: vi.fn().mockReturnValue([]),
  mockAddNotificationHistory: vi.fn().mockReturnValue({
    id: 1,
    level: 'error',
    message: 'test',
    timestamp: Date.now(),
    is_read: 0,
  }),
  mockUpdateNotificationDispatchError: vi.fn(),
  mockGetEnabledNotificationSuppressionRules: vi.fn().mockReturnValue([]),
  mockUpdateNotificationSuppressionMatch: vi.fn(),
  mockBroadcast: vi.fn(),
  mockGetGlobalSettings: vi.fn().mockReturnValue({ notification_dispatch_retries: '0' }),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getEnabledNotificationRoutes: mockGetEnabledNotificationRoutes,
      getEnabledAgents: mockGetEnabledAgents,
      getStackLabelIds: mockGetStackLabelIds,
      addNotificationHistory: mockAddNotificationHistory,
      updateNotificationDispatchError: mockUpdateNotificationDispatchError,
      getEnabledNotificationSuppressionRules: mockGetEnabledNotificationSuppressionRules,
      updateNotificationSuppressionMatch: mockUpdateNotificationSuppressionMatch,
      getGlobalSettings: mockGetGlobalSettings,
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDefaultNodeId: () => 1,
      getComposeDir: () => '/app/compose',
    }),
  },
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import { NotificationService } from '../services/NotificationService';
import { StackActivityMetricsService } from '../services/StackActivityMetricsService';

function makeSuppressionRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Mute crashes',
    node_id: null as number | null,
    stack_patterns: [] as string[],
    label_ids: null as number[] | null,
    categories: ['monitor_alert'] as string[] | null,
    levels: null as string[] | null,
    applies_to: 'both' as const,
    enabled: true,
    expires_at: null as number | null,
    schedule: null as null,
    scheduleInvalid: false,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeRoute() {
  return {
    id: 1,
    name: 'Prod Discord',
    node_id: null,
    stack_patterns: ['my-app'],
    label_ids: null,
    categories: null,
    levels: null,
    channel_type: 'discord' as const,
    channel_url: 'https://discord.com/api/webhooks/123/abc',
    priority: 0,
    enabled: true,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

describe('NotificationService - suppression logic', () => {
  let svc: NotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    (NotificationService as unknown as { instance?: NotificationService }).instance = undefined;
    svc = NotificationService.getInstance();
    vi.spyOn(
      svc as unknown as { broadcastToSubscribers: (n: unknown) => void },
      'broadcastToSubscribers',
    ).mockImplementation(mockBroadcast);
    vi.spyOn(StackActivityMetricsService.getInstance(), 'record').mockImplementation(() => {});
  });

  it('suppresses category via external dispatch', async () => {
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([
      makeSuppressionRule({ categories: ['monitor_alert'], applies_to: 'external' }),
    ]);
    mockGetEnabledAgents.mockReturnValue([{ type: 'slack', url: 'https://hooks.slack.com/x', enabled: true }]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Container crashed', { stackName: 'my-app' });

    expect(mockBroadcast).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('suppresses severity via bell only', async () => {
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([
      makeSuppressionRule({ levels: ['error'], applies_to: 'bell', categories: null }),
    ]);
    mockGetEnabledAgents.mockReturnValue([{ type: 'slack', url: 'https://hooks.slack.com/x', enabled: true }]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Container crashed', { stackName: 'my-app' });

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('suppresses both bell and external', async () => {
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([
      makeSuppressionRule({ categories: ['monitor_alert'], applies_to: 'both' }),
    ]);
    mockGetEnabledAgents.mockReturnValue([{ type: 'slack', url: 'https://hooks.slack.com/x', enabled: true }]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Crash', { stackName: 'my-app' });

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateNotificationSuppressionMatch).toHaveBeenCalledWith(1, {
      rules: [{ id: 1, name: 'Mute crashes' }],
      bellSuppressed: true,
      externalSuppressed: true,
    });
  });

  it('allows dispatch when no suppression rules match', async () => {
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([]);
    mockGetEnabledAgents.mockReturnValue([{ type: 'slack', url: 'https://hooks.slack.com/x', enabled: true }]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Crash');

    expect(mockBroadcast).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('routing still works when suppression does not match', async () => {
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([
      makeSuppressionRule({ categories: ['deploy_success'], applies_to: 'both' }),
    ]);
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Crash', { stackName: 'my-app' });

    expect(mockBroadcast).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('suppresses inside weekly window and records match', async () => {
    // Monday 2026-07-20 03:00 UTC inside 02:00-06:00 Mon window
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-20T03:00:00.000Z'));
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([
      makeSuppressionRule({
        categories: ['monitor_alert'],
        applies_to: 'both',
        schedule: { days: [1], start_minute: 120, end_minute: 360, tz: 'UTC' },
      }),
    ]);
    mockGetEnabledAgents.mockReturnValue([{ type: 'slack', url: 'https://hooks.slack.com/x', enabled: true }]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Crash', { stackName: 'my-app' });

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateNotificationSuppressionMatch).toHaveBeenCalled();
    expect(mockGetEnabledNotificationSuppressionRules).toHaveBeenCalledWith(Date.parse('2026-07-20T03:00:00.000Z'));
  });

  it('does not suppress outside weekly window', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-20T12:00:00.000Z'));
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([
      makeSuppressionRule({
        categories: ['monitor_alert'],
        applies_to: 'both',
        schedule: { days: [1], start_minute: 120, end_minute: 360, tz: 'UTC' },
      }),
    ]);
    mockGetEnabledAgents.mockReturnValue([{ type: 'slack', url: 'https://hooks.slack.com/x', enabled: true }]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Crash', { stackName: 'my-app' });

    expect(mockBroadcast).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
    expect(mockUpdateNotificationSuppressionMatch).not.toHaveBeenCalled();
  });

  it('does not suppress when stored schedule is invalid', async () => {
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([
      makeSuppressionRule({
        categories: ['monitor_alert'],
        applies_to: 'both',
        schedule: null,
        scheduleInvalid: true,
      }),
    ]);
    mockGetEnabledAgents.mockReturnValue([{ type: 'slack', url: 'https://hooks.slack.com/x', enabled: true }]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Crash', { stackName: 'my-app' });

    expect(mockBroadcast).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
    expect(mockUpdateNotificationSuppressionMatch).not.toHaveBeenCalled();
  });

  it('does not suppress when scheduled rule is expired relative to atMs', async () => {
    const atMs = Date.parse('2026-07-20T03:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(atMs);
    // getEnabled already filters expiry; empty list simulates expired
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([]);
    mockGetEnabledAgents.mockReturnValue([{ type: 'slack', url: 'https://hooks.slack.com/x', enabled: true }]);

    await svc.dispatchAlert('error', 'monitor_alert', 'Crash', { stackName: 'my-app' });

    expect(mockGetEnabledNotificationSuppressionRules).toHaveBeenCalledWith(atMs);
    expect(mockBroadcast).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });
});

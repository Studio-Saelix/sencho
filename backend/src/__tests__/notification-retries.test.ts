/**
 * Configurable in-process notification dispatch retries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockGetEnabledNotificationRoutes,
  mockGetEnabledNotificationSuppressionRules,
  mockGetEnabledAgents,
  mockGetStackLabelIds,
  mockAddNotificationHistory,
  mockUpdateNotificationDispatchError,
  mockGetGlobalSettings,
} = vi.hoisted(() => ({
  mockGetEnabledNotificationRoutes: vi.fn().mockReturnValue([]),
  mockGetEnabledNotificationSuppressionRules: vi.fn().mockReturnValue([]),
  mockGetEnabledAgents: vi.fn().mockReturnValue([]),
  mockGetStackLabelIds: vi.fn().mockReturnValue([]),
  mockAddNotificationHistory: vi.fn().mockReturnValue({
    id: 42,
    level: 'error',
    message: 'test',
    timestamp: Date.now(),
    is_read: 0,
  }),
  mockUpdateNotificationDispatchError: vi.fn(),
  mockGetGlobalSettings: vi.fn().mockReturnValue({ notification_dispatch_retries: '0' }),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getEnabledNotificationRoutes: mockGetEnabledNotificationRoutes,
      getEnabledNotificationSuppressionRules: mockGetEnabledNotificationSuppressionRules,
      getEnabledAgents: mockGetEnabledAgents,
      getStackLabelIds: mockGetStackLabelIds,
      addNotificationHistory: mockAddNotificationHistory,
      updateNotificationDispatchError: mockUpdateNotificationDispatchError,
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

vi.mock('../services/StackActivityMetricsService', () => ({
  StackActivityMetricsService: {
    getInstance: () => ({ record: vi.fn() }),
  },
}));

import { NotificationService } from '../services/NotificationService';

const DISCORD = 'https://discord.com/api/webhooks/1/token';

function makeRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Prod Discord',
    node_id: null as number | null,
    stack_patterns: [] as string[],
    label_ids: null as number[] | null,
    categories: null as string[] | null,
    levels: null as ('info' | 'warning' | 'error')[] | null,
    channel_type: 'discord' as const,
    channel_url: DISCORD,
    priority: 0,
    enabled: true,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe('notification dispatch retries', () => {
  let svc: NotificationService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (NotificationService as unknown as { instance?: NotificationService }).instance = undefined;
    NotificationService.setRetryDelayMsForTests(0);
    svc = NotificationService.getInstance();
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    mockGetEnabledNotificationRoutes.mockReturnValue([]);
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([]);
    mockGetEnabledAgents.mockReturnValue([]);
    mockGetStackLabelIds.mockReturnValue([]);
    mockUpdateNotificationDispatchError.mockClear();
    mockAddNotificationHistory.mockClear();
    mockGetGlobalSettings.mockReset();
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '0' });
  });

  afterEach(() => {
    NotificationService.setRetryDelayMsForTests(1000);
    vi.unstubAllGlobals();
  });

  it('retries=0 performs a single fetch', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '0' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockGetGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it('retries=2 on persistent 5xx performs three attempts', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch.mockResolvedValue({ ok: false, status: 502 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      42,
      expect.stringContaining('HTTP 502'),
    );
  });

  it('uses a fixed 1s delay between retryable attempts in production config', async () => {
    NotificationService.setRetryDelayMsForTests(1000);
    vi.useFakeTimers();
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '1' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    try {
      const p = svc.dispatchAlert('error', 'monitor_alert', 'down');
      // First attempt runs immediately; do not advance AbortSignal.timeout (10s).
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after success on the second attempt', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockUpdateNotificationDispatchError).not.toHaveBeenCalled();
    expect(mockAddNotificationHistory).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable 4xx', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '3' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads settings once for multi-destination fanout', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '1' });
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ id: 1, name: 'A', channel_url: `${DISCORD}-a` }),
      makeRoute({ id: 2, name: 'B', channel_url: `${DISCORD}-b` }),
    ]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockGetGlobalSettings).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to zero retries when settings throw and still sends once', async () => {
    mockGetGlobalSettings.mockImplementation(() => {
      throw new Error('db down');
    });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to zero retries for corrupt stored values', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '9' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry unsupported channel types', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ channel_type: 'sms' as 'discord', channel_url: 'https://example.com' }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Unsupported channel type'),
    );
  });

  it('aggregates final errors from multiple failed destinations', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '0' });
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeRoute({ id: 1, name: 'One', channel_url: `${DISCORD}-1` }),
      makeRoute({ id: 2, name: 'Two', channel_url: `${DISCORD}-2` }),
    ]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    const joined = mockUpdateNotificationDispatchError.mock.calls[0][1] as string;
    expect(joined).toContain('Route "One"');
    expect(joined).toContain('Route "Two"');
  });

  it('records the last attempt message for a destination after retries', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '1' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute({ name: 'Flaky' })]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    const joined = mockUpdateNotificationDispatchError.mock.calls[0][1] as string;
    expect(joined).toContain('HTTP 503');
    expect(joined).not.toContain('HTTP 500');
  });

  describe('channel retry classification matrix', () => {
    const channels: Array<{ type: 'discord' | 'slack' | 'webhook' | 'ntfy'; url: string }> = [
      { type: 'discord', url: DISCORD },
      { type: 'slack', url: 'https://hooks.slack.com/services/T/B/X' },
      { type: 'webhook', url: 'https://example.com/hooks/sencho' },
      { type: 'ntfy', url: 'https://ntfy.sh/test' },
    ];

    for (const channel of channels) {
      it(`${channel.type}: does not retry non-retryable 4xx`, async () => {
        mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '3' });
        mockGetEnabledNotificationRoutes.mockReturnValue([
          makeRoute({ channel_type: channel.type, channel_url: channel.url }),
        ]);
        mockFetch.mockResolvedValue({ ok: false, status: 404 });

        await svc.dispatchAlert('error', 'monitor_alert', 'down');

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it(`${channel.type}: retries persistent 5xx for configured extras`, async () => {
        mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
        mockGetEnabledNotificationRoutes.mockReturnValue([
          makeRoute({ channel_type: channel.type, channel_url: channel.url }),
        ]);
        mockFetch.mockResolvedValue({ ok: false, status: 502 });

        await svc.dispatchAlert('error', 'monitor_alert', 'down');

        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it(`${channel.type}: stops after a successful retry`, async () => {
        mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
        mockGetEnabledNotificationRoutes.mockReturnValue([
          makeRoute({ channel_type: channel.type, channel_url: channel.url }),
        ]);
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 503 })
          .mockResolvedValueOnce({ ok: true, status: 200 });

        await svc.dispatchAlert('error', 'monitor_alert', 'down');

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockUpdateNotificationDispatchError).not.toHaveBeenCalled();
      });
    }
  });


  describe('testDispatch parity', () => {
    it('retries a retryable failure then succeeds', async () => {
      mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '1' });
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 502 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      await svc.testDispatch('discord', DISCORD);

      expect(mockGetGlobalSettings).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a non-retryable test failure', async () => {
      mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '3' });
      mockFetch.mockResolvedValue({ ok: false, status: 401 });

      await expect(svc.testDispatch('discord', DISCORD)).rejects.toMatchObject({
        status: 401,
        retryable: false,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

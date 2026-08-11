/**
 * Templated payload dispatch through NotificationService: variable
 * substitution, retry stability, ntfy JSON publish, Apprise destination
 * merging, non-goal enforcement (routes never templated), and regression
 * guards for untemplated agents.
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
    message: 'down',
    timestamp: 1700000000000,
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

const WEBHOOK_URL = 'https://example.com/hooks/sencho';

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
    channel_url: 'https://discord.com/api/webhooks/1/token',
    priority: 0,
    enabled: true,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    node_id: 1,
    type: 'webhook' as const,
    url: WEBHOOK_URL,
    enabled: true,
    config: null as string | null,
    payload_template: null as string | null,
    ...overrides,
  };
}

describe('templated payload dispatch', () => {
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

  it('substitutes all template variables from the dispatch context', async () => {
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        payload_template:
          '{"level":"{{level}}","message":"{{message}}","category":"{{category}}",'
          + '"timestamp":"{{timestamp}}","stack_name":"{{stack_name}}","actor":"{{actor}}"}',
      }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down', { stackName: 'web', actor: 'boris' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      level: 'error',
      message: 'down',
      category: 'monitor_alert',
      timestamp: new Date(1700000000000).toISOString(),
      stack_name: 'web',
      actor: 'boris',
    });
  });

  it('renders the persisted history-row timestamp, stable across retries', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '1' });
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({ payload_template: '{"timestamp": "{{timestamp}}", "message": "{{message}}"}' }),
    ]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const first = mockFetch.mock.calls[0][1] as RequestInit;
    const second = mockFetch.mock.calls[1][1] as RequestInit;
    expect(String(first.body)).toBe(String(second.body));
    expect(JSON.parse(String(first.body))).toEqual({
      timestamp: new Date(1700000000000).toISOString(),
      message: 'down',
    });
  });

  it('treats a 4xx on a templated agent as non-retryable even with extras configured', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '3' });
    mockGetEnabledAgents.mockReturnValue([makeAgent({ payload_template: '{"m":"{{message}}"}' })]);
    mockFetch.mockResolvedValue({ ok: false, status: 400 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      42,
      expect.stringContaining('webhook rejected templated payload with HTTP 400'),
    );
  });

  it('posts JSON to a normalized ntfy URL without plaintext headers', async () => {
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        type: 'ntfy',
        url: 'https://ntfy.sh/mytopic/',
        payload_template: '{"message": "{{message}}"}',
      }),
    ]);

    await svc.dispatchAlert('warning', 'stack_restarted', 'up again', { stackName: 'blog' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [target, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(target).toBe('https://ntfy.sh/mytopic');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.headers).not.toHaveProperty('Title');
    expect(init.headers).not.toHaveProperty('Priority');
    expect(init.headers).not.toHaveProperty('Tags');
    expect(JSON.parse(String(init.body))).toEqual({ message: 'up again' });
  });

  it('translates ntfy URL userinfo into Basic authorization for templated posts', async () => {
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        type: 'ntfy',
        url: 'https://user:pass@ntfy.sh/mytopic',
        payload_template: '{"message": "{{message}}"}',
      }),
    ]);

    await svc.dispatchAlert('info', 'system', 'hello');

    const [target, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(target).toBe('https://ntfy.sh/mytopic');
    expect(init.headers).toMatchObject({ Authorization: 'Basic dXNlcjpwYXNz' });
    expect(JSON.parse(String(init.body))).toEqual({ message: 'hello' });
  });

  it('merges stored Apprise destination URLs into the rendered body', async () => {
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        type: 'apprise',
        url: 'http://apprise.local/notify',
        config: JSON.stringify({ urls: 'discord://token@id' }),
        payload_template: '{"title": "{{level}}", "body": "{{message}}"}',
      }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'error',
      body: 'down',
      urls: 'discord://token@id',
    });
  });

  it('treats an Apprise 204 on the templated path as a non-retryable no-delivery', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        type: 'apprise',
        url: 'http://apprise.local/notify',
        config: JSON.stringify({ urls: 'discord://token@id' }),
        payload_template: '{"title": "{{level}}"}',
      }),
    ]);
    mockFetch.mockResolvedValue({ ok: true, status: 204 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      42,
      expect.stringContaining('no delivery (HTTP 204)'),
    );
  });

  it('does not fetch and records a non-retryable error for a corrupt stored template', async () => {
    mockGetEnabledAgents.mockReturnValue([makeAgent({ payload_template: '{"a":' })]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Templated payload could not be rendered'),
    );
  });

  it('ignores a stored agent template when a notification route matches', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeRoute()]);
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({ payload_template: '{"custom": "{{level}}"}' }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    const [target, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(target).toBe('https://discord.com/api/webhooks/1/token');
    const body = JSON.parse(String(init.body)) as { embeds?: unknown[]; custom?: unknown };
    expect(body.custom).toBeUndefined();
    expect(Array.isArray(body.embeds)).toBe(true);
  });

  it('merges stored Apprise tags for keyed endpoints into the rendered body', async () => {
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        type: 'apprise',
        url: 'http://apprise.local/notify/test-key',
        config: JSON.stringify({ tags: 'ops' }),
        payload_template: '{"title": "{{level}}"}',
      }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ title: 'error', tag: 'ops' });
  });

  it('does not merge a tag for keyed Apprise endpoints without tags', async () => {
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        type: 'apprise',
        url: 'http://apprise.local/notify/test-key',
        config: '{}',
        payload_template: '{"title": "{{level}}"}',
      }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ title: 'error' });
  });

  it('treats a whitespace-only stored template as no template', async () => {
    mockGetEnabledAgents.mockReturnValue([makeAgent({ type: 'webhook', payload_template: '   ' })]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { source?: string };
    expect(body.source).toBe('sencho');
  });

  it('classifies a network failure on the templated path as retryable', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '1' });
    mockGetEnabledAgents.mockReturnValue([makeAgent({ payload_template: '{"m": "{{message}}"}' })]);
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockUpdateNotificationDispatchError).not.toHaveBeenCalled();
  });

  it('rejects a non-object rendered template on the Apprise path without fetching', async () => {
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        type: 'apprise',
        url: 'http://apprise.local/notify',
        config: '{}',
        payload_template: '"{{message}}"',
      }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      42,
      expect.stringContaining('must render a JSON object'),
    );
  });

  it('rejects an invalid stored Apprise config on the templated path without fetching', async () => {
    mockGetEnabledAgents.mockReturnValue([
      makeAgent({
        type: 'apprise',
        url: 'http://apprise.local/notify',
        config: '{not-json',
        payload_template: '{"title": "{{level}}"}',
      }),
    ]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Stored Apprise configuration is invalid'),
    );
  });

  it('keeps the built-in payload for an untemplated agent', async () => {
    mockGetEnabledAgents.mockReturnValue([makeAgent({ type: 'webhook' })]);

    await svc.dispatchAlert('error', 'monitor_alert', 'down');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { level: string; message: string; source: string };
    expect(body).toMatchObject({ level: 'error', message: 'down', source: 'sencho' });
  });

  it('testDispatch renders the template with the test message and system category', async () => {
    await svc.testDispatch(
      'webhook',
      WEBHOOK_URL,
      undefined,
      '{"message": "{{message}}", "level": "{{level}}", "category": "{{category}}"}',
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      message: '🔌 Test Notification from Sencho!',
      level: 'info',
      category: 'system',
    });
  });
});

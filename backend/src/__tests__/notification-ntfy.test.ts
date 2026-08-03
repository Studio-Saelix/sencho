/**
 * ntfy delivery through NotificationService: plain-text body, Priority/Tags
 * headers per severity, Content-Type, and error classification.
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
    id: 99,
    level: 'info',
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
    getInstance: () => ({
      record: vi.fn(),
    }),
  },
}));

import { NotificationService, NotificationDeliveryError } from '../services/NotificationService';

const NTFY_URL = 'https://ntfy.sh/test-topic';

function makeNtfyRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'ntfy route',
    node_id: null,
    stack_patterns: ['my-app'],
    label_ids: null,
    categories: null,
    levels: null,
    channel_type: 'ntfy' as const,
    channel_url: NTFY_URL,
    config: null,
    priority: 0,
    enabled: true,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function makeNtfyAgent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'ntfy' as const,
    url: NTFY_URL,
    enabled: true,
    config: null,
    ...overrides,
  };
}

describe('NotificationService - ntfy delivery', () => {
  let svc: NotificationService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (NotificationService as unknown as { instance?: NotificationService }).instance = undefined;
    svc = NotificationService.getInstance();
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    mockGetEnabledNotificationRoutes.mockReturnValue([]);
    mockGetEnabledNotificationSuppressionRules.mockReturnValue([]);
    mockGetEnabledAgents.mockReturnValue([]);
    mockUpdateNotificationDispatchError.mockClear();
    mockAddNotificationHistory.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends plain-text body with Content-Type text/plain', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute()]);
    await svc.dispatchAlert('info', 'deploy_success', 'ok', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(NTFY_URL, expect.objectContaining({
      method: 'POST',
      body: 'ok',
      headers: expect.objectContaining({
        'Content-Type': 'text/plain',
      }),
    }));
  });

  it('sets Priority: default for info level', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute()]);
    await svc.dispatchAlert('info', 'deploy_success', 'ok', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(NTFY_URL, expect.objectContaining({
      headers: expect.objectContaining({ 'Priority': 'default' }),
    }));
    // No Tags header for info.
    const call = mockFetch.mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Tags']).toBeUndefined();
  });

  it('sets Priority: high and Tags: warning for warning level', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute()]);
    await svc.dispatchAlert('warning', 'deploy_failure', 'boom', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(NTFY_URL, expect.objectContaining({
      headers: expect.objectContaining({
        'Priority': 'high',
        'Tags': 'warning',
      }),
    }));
  });

  it('sets Priority: urgent and Tags: warning,rotating_light for error level', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute()]);
    await svc.dispatchAlert('error', 'deploy_failure', 'boom', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(NTFY_URL, expect.objectContaining({
      headers: expect.objectContaining({
        'Priority': 'urgent',
        'Tags': 'warning,rotating_light',
      }),
    }));
  });

  it('sets Title header with severity', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute()]);
    await svc.dispatchAlert('error', 'monitor_alert', 'disk full', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(NTFY_URL, expect.objectContaining({
      headers: expect.objectContaining({
        'Title': 'Sencho Alert [ERROR]',
      }),
    }));
  });

  it('dispatches via global agent fallback', async () => {
    mockGetEnabledAgents.mockReturnValue([makeNtfyAgent()]);
    await svc.dispatchAlert('info', 'deploy_success', 'ok');
    expect(mockFetch).toHaveBeenCalledWith(NTFY_URL, expect.objectContaining({
      method: 'POST',
      body: 'ok',
    }));
  });

  it('does not retry 4xx', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute()]);
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await svc.dispatchAlert('error', 'monitor_alert', 'down', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx for configured extras', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute()]);
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await svc.dispatchAlert('error', 'monitor_alert', 'down', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('stops retrying on success', async () => {
    mockGetGlobalSettings.mockReturnValue({ notification_dispatch_retries: '2' });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute()]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await svc.dispatchAlert('error', 'monitor_alert', 'down', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('derives Authorization header from URL userinfo', async () => {
    const authUrl = 'https://user:pass@ntfy.example.com/topic';
    mockGetEnabledNotificationRoutes.mockReturnValue([makeNtfyRoute({ channel_url: authUrl })]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await svc.dispatchAlert('info', 'deploy_success', 'ok', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ntfy.example.com/topic', // userinfo stripped
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': `Basic ${btoa('user:pass')}`,
        }),
      }),
    );
  });
});

/**
 * Apprise delivery through NotificationService: payloads, status classes,
 * fail-closed malformed config, and dispatch_error recording.
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

const KEYED = 'http://apprise.local/notify/key-secret';
const STATELESS = 'http://apprise.local/notify';

function makeAppriseRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Apprise route',
    node_id: null,
    stack_patterns: ['my-app'],
    label_ids: null,
    categories: null,
    levels: null,
    channel_type: 'apprise' as const,
    channel_url: KEYED,
    config: '{}',
    priority: 0,
    enabled: true,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('NotificationService - Apprise delivery', () => {
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

  it('sends keyed payload without tag when tags are empty', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([makeAppriseRoute({ config: '{}' })]);
    await svc.dispatchAlert('warning', 'deploy_failure', 'boom', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(KEYED, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        title: 'Sencho Alert [WARNING]',
        body: 'boom',
        type: 'warning',
      }),
    }));
  });

  it('sends keyed tag and maps error to failure', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeAppriseRoute({ config: JSON.stringify({ tags: 'ops' }) }),
    ]);
    await svc.dispatchAlert('error', 'deploy_failure', 'boom', { stackName: 'my-app' });
    expect(mockFetch).toHaveBeenCalledWith(KEYED, expect.objectContaining({
      body: JSON.stringify({
        title: 'Sencho Alert [ERROR]',
        body: 'boom',
        type: 'failure',
        tag: 'ops',
      }),
    }));
  });

  it('sends stateless urls from stored config via agent fallback', async () => {
    mockGetEnabledAgents.mockReturnValue([{
      type: 'apprise',
      url: STATELESS,
      enabled: true,
      config: JSON.stringify({ urls: 'discord://token mailto://a@b.com' }),
    }]);
    await svc.dispatchAlert('info', 'deploy_success', 'ok');
    expect(mockFetch).toHaveBeenCalledWith(STATELESS, expect.objectContaining({
      body: JSON.stringify({
        title: 'Sencho Alert [INFO]',
        body: 'ok',
        type: 'info',
        urls: 'discord://token mailto://a@b.com',
      }),
    }));
  });

  it('treats HTTP 204 as non-retryable failure and records dispatch_error', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204 });
    mockGetEnabledNotificationRoutes.mockReturnValue([makeAppriseRoute()]);
    await svc.dispatchAlert('info', 'deploy_success', 'ok', { stackName: 'my-app' });
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      99,
      expect.stringContaining('HTTP 204'),
    );
    const errText = String(mockUpdateNotificationDispatchError.mock.calls[0][1]);
    expect(errText).not.toContain('key-secret');
  });

  it('classifies 4xx as non-retryable and 5xx as retryable via testDispatch', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(svc.testDispatch('apprise', KEYED, {})).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 400'),
      retryable: false,
    } satisfies Partial<NotificationDeliveryError>);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(svc.testDispatch('apprise', KEYED, {})).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 503'),
      retryable: true,
    });
  });

  it('wraps network failures as retryable sanitized errors', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(svc.testDispatch('apprise', KEYED, {})).rejects.toMatchObject({
      message: 'Apprise request failed',
      retryable: true,
      status: null,
    });
  });

  it('does not fetch when stored config is malformed and records a sanitized error', async () => {
    mockGetEnabledNotificationRoutes.mockReturnValue([
      makeAppriseRoute({ config: '{broken', channel_url: KEYED }),
    ]);
    await svc.dispatchAlert('info', 'deploy_success', 'ok', { stackName: 'my-app' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateNotificationDispatchError).toHaveBeenCalledWith(
      99,
      expect.stringContaining('Apprise configuration is missing or invalid'),
    );
    expect(String(mockUpdateNotificationDispatchError.mock.calls[0][1])).not.toContain('key-secret');
  });
});

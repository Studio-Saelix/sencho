/**
 * Fleet sync for suppression rules: node_id normalize, capability gate, stale DELETE,
 * durable pending retractions, permanent fan-out to all remotes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetchMeta = vi.fn();
const mockGetProxyTarget = vi.fn();
const mockGetNodes = vi.fn();
const mockGetNode = vi.fn();
const mockRemoteAdvertises = vi.fn();
const mockUpsertPending = vi.fn();
const mockDeletePending = vi.fn();
const mockListPending = vi.fn();

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getNodes: mockGetNodes,
      getNode: mockGetNode,
      upsertNotificationSuppressionPendingRetraction: mockUpsertPending,
      deleteNotificationSuppressionPendingRetraction: mockDeletePending,
      listNotificationSuppressionPendingRetractions: mockListPending,
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getProxyTarget: mockGetProxyTarget,
      fetchMetaForNode: mockFetchMeta,
    }),
  },
}));

vi.mock('../services/LicenseService', () => ({
  LicenseService: {
    getInstance: () => ({
      getProxyHeaders: () => ({ tier: 'community' }),
    }),
  },
}));

vi.mock('../helpers/remoteCapabilities', () => ({
  remoteAdvertisesCapability: (...args: unknown[]) => mockRemoteAdvertises(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  syncSuppressionRuleToFleet,
  syncSuppressionRuleUpdateToFleet,
  replicationTargetIds,
  flushPendingSuppressionRetractions,
} from '../helpers/notificationSuppressionSync';
import type { NotificationSuppressionRule } from '../services/DatabaseService';

function makeRule(overrides: Partial<NotificationSuppressionRule> = {}): NotificationSuppressionRule {
  return {
    id: 42,
    name: 'Fleet mute',
    node_id: null,
    stack_patterns: [],
    label_ids: null,
    categories: null,
    levels: null,
    applies_to: 'both',
    enabled: true,
    expires_at: null,
    schedule: null,
    scheduleInvalid: false,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

const remoteA = { id: 10, name: 'remote-a', type: 'remote' as const };
const remoteB = { id: 11, name: 'remote-b', type: 'remote' as const };

const RETRACTION_CAP = 'notification-suppression-replica-retraction';

function metaWith(...caps: string[]) {
  return { capabilities: caps, online: true };
}

function okDeleteResponse(outcome = 'applied') {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ success: true, outcome }),
  };
}

describe('notificationSuppressionSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNodes.mockReturnValue([remoteA, remoteB]);
    mockGetNode.mockImplementation((id: number) =>
      [remoteA, remoteB].find((n) => n.id === id),
    );
    mockGetProxyTarget.mockImplementation((id: number) => ({
      apiUrl: `http://node-${id}.example:1852`,
      apiToken: 'tok',
    }));
    mockFetch.mockResolvedValue(okDeleteResponse());
    mockRemoteAdvertises.mockResolvedValue(true);
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP, 'notification-suppression-schedule'));
    mockListPending.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replicationTargetIds: fleet-wide all remotes; scoped one remote', () => {
    expect(replicationTargetIds(makeRule({ node_id: null }))).toEqual([10, 11]);
    expect(replicationTargetIds(makeRule({ node_id: 10 }))).toEqual([10]);
  });

  it('unscheduled push sends node_id null without capability probe', async () => {
    syncSuppressionRuleToFleet(makeRule({ schedule: null, node_id: 10 }));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockRemoteAdvertises).not.toHaveBeenCalled();
    expect(mockFetchMeta).not.toHaveBeenCalled();
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.rule.node_id).toBeNull();
    expect(body.rule.schedule).toBeNull();
  });

  it('supported remote receives scheduled rule with node_id null', async () => {
    mockRemoteAdvertises.mockResolvedValue(true);
    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: { days: [6], start_minute: 120, end_minute: 360, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockRemoteAdvertises).toHaveBeenCalled();
    const [url, init] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain('/api/notification-suppression-rules/replica');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.rule.node_id).toBeNull();
    expect(body.rule.schedule.days).toEqual([6]);
  });

  it('schedule unsupported + retraction supported: recoverable DELETE, no POST', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      updated_at: 555,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
    expect(JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)).toEqual({
      kind: 'recoverable',
      source_updated_at: 555,
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('recoverable DELETE applied'))).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(false);
    expect(mockUpsertPending).not.toHaveBeenCalled();
    expect(mockDeletePending).toHaveBeenCalledWith(42, 10);
  });

  it('schedule unsupported + retraction unsupported: no DELETE; queues pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetchMeta.mockResolvedValue(metaWith('notification-suppression'));

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      updated_at: 555,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('queued pending retraction'))).toBe(true);
    expect(mockUpsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        rule_id: 42,
        node_id: 10,
        kind: 'recoverable',
        source_updated_at: 555,
      }),
    );
  });

  it('schedule unsupported + probe unreachable (offline meta): no DELETE; queues pending', async () => {
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetchMeta.mockResolvedValue({ capabilities: [], online: false });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpsertPending.mock.calls[0][0].last_error).toMatch(/unreachable/);
  });

  it('schedule unsupported + probe unreachable (throw): no DELETE; queues pending', async () => {
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetchMeta.mockRejectedValue(new Error('timeout'));

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('schedule unsupported + no proxy after supported probe: queues pending, no POST', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));
    mockGetProxyTarget.mockReturnValue(null);

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(true);
  });

  it('scheduleInvalid: DELETE success when retraction supported, no POST', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => {
      expect(warn.mock.calls.some((c) => String(c[0]).includes('recoverable DELETE applied'))).toBe(true);
    });

    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(false);
  });

  it('scheduleInvalid: opaque DELETE 404 queues pending (not treated as success)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
      json: async () => {
        throw new Error('no json');
      },
    });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(true);
    expect(mockDeletePending).not.toHaveBeenCalled();
  });

  it('scheduleInvalid: DELETE failure queues pending, no POST', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'down',
      json: async () => ({}),
    });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
    expect(mockUpsertPending).toHaveBeenCalled();
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(true);
  });

  it('scheduleInvalid without retraction capability: no DELETE; queues pending', async () => {
    mockFetchMeta.mockResolvedValue(metaWith());

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      updated_at: 777,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'recoverable',
        source_updated_at: 777,
      }),
    );
  });

  it('unscheduled-to-scheduled on unsupported schedule target attempts recoverable path', async () => {
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));
    const previous = makeRule({ node_id: 10, schedule: null });
    const updated = makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    });
    syncSuppressionRuleUpdateToFleet(previous, updated);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
  });

  it('scheduled-to-unscheduled POST refresh does not require capability', async () => {
    mockRemoteAdvertises.mockResolvedValue(false);
    const previous = makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    });
    const updated = makeRule({ node_id: 10, schedule: null });
    syncSuppressionRuleUpdateToFleet(previous, updated);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockRemoteAdvertises).not.toHaveBeenCalled();
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.rule.schedule).toBeNull();
  });

  it('stale targets receive recoverable DELETE when retraction supported', async () => {
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));
    const previous = makeRule({ node_id: null, schedule: null });
    const updated = makeRule({ node_id: 10, schedule: null });
    syncSuppressionRuleUpdateToFleet(previous, updated);
    await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2));

    const deletes = mockFetch.mock.calls.filter((c) => (c[1] as { method: string }).method === 'DELETE');
    expect(deletes.some((c) => String(c[0]).includes('node-11'))).toBe(true);
    const posts = mockFetch.mock.calls.filter((c) => (c[1] as { method: string }).method === 'POST');
    expect(posts.some((c) => String(c[0]).includes('node-10'))).toBe(true);
  });

  it('stale-target without retraction capability: no DELETE; queues pending', async () => {
    mockFetchMeta.mockResolvedValue(metaWith());
    const previous = makeRule({ id: 42, node_id: null, schedule: null, updated_at: 10 });
    const updated = makeRule({ id: 42, node_id: 10, schedule: null, updated_at: 99 });
    syncSuppressionRuleUpdateToFleet(previous, updated);
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());

    const deletes = mockFetch.mock.calls.filter((c) => (c[1] as { method: string }).method === 'DELETE');
    expect(deletes).toHaveLength(0);
    expect(mockUpsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        rule_id: 42,
        node_id: 11,
        kind: 'recoverable',
        source_updated_at: 99,
      }),
    );
  });

  it('stale-target DELETE sends recoverable watermark from updated rule', async () => {
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));
    const previous = makeRule({ id: 42, node_id: null, schedule: null, updated_at: 10 });
    const updated = makeRule({ id: 42, node_id: 10, schedule: null, updated_at: 99 });
    syncSuppressionRuleUpdateToFleet(previous, updated);
    await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2));
    const deletes = mockFetch.mock.calls.filter((c) => (c[1] as { method: string }).method === 'DELETE');
    const stale = deletes.find((c) => String(c[0]).includes('node-11'));
    expect(stale).toBeTruthy();
    expect(JSON.parse((stale![1] as { body: string }).body)).toEqual({
      kind: 'recoverable',
      source_updated_at: 99,
    });
  });

  it('authoritative fleet delete fans permanent retraction to all remotes', async () => {
    const { deleteSuppressionRuleFromFleet } = await import('../helpers/notificationSuppressionSync');
    deleteSuppressionRuleFromFleet(makeRule({ node_id: 10, updated_at: 321 }));
    await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBe(2));

    for (const call of mockFetch.mock.calls) {
      const [, init] = call as [string, { method: string; body: string }];
      expect(init.method).toBe('DELETE');
      expect(JSON.parse(init.body)).toEqual({ kind: 'permanent', source_updated_at: 321 });
    }
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('node-10'))).toBe(true);
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('node-11'))).toBe(true);
  });

  it('authoritative delete transport failure queues pending permanent row', async () => {
    const { deleteSuppressionRuleFromFleet } = await import('../helpers/notificationSuppressionSync');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'down',
      json: async () => ({}),
    });
    deleteSuppressionRuleFromFleet(makeRule({ node_id: 10, updated_at: 321 }));
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());
    expect(mockUpsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'permanent',
        source_updated_at: 321,
      }),
    );
  });

  it('ignored_stale DELETE keeps pending and does not clear', async () => {
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ success: true, outcome: 'ignored_stale' }),
    });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => expect(mockUpsertPending).toHaveBeenCalled());
    expect(mockDeletePending).not.toHaveBeenCalled();
    expect(mockUpsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        last_error: expect.stringMatching(/ignored_stale/),
      }),
    );
  });

  it('flushPendingSuppressionRetractions retries recoverable only when supported', async () => {
    mockListPending.mockReturnValue([
      {
        rule_id: 7,
        node_id: 10,
        kind: 'recoverable',
        source_updated_at: 50,
        created_at: 1,
        updated_at: 2,
        attempts: 1,
        last_error: 'earlier',
      },
    ]);
    mockFetchMeta.mockResolvedValue(metaWith());

    await flushPendingSuppressionRetractions(10);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpsertPending).toHaveBeenCalled();

    mockUpsertPending.mockClear();
    mockFetchMeta.mockResolvedValue(metaWith(RETRACTION_CAP));
    await flushPendingSuppressionRetractions(10);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)).toEqual({
      kind: 'recoverable',
      source_updated_at: 50,
    });
    expect(mockDeletePending).toHaveBeenCalledWith(7, 10);
  });

  it('flushPendingSuppressionRetractions sends permanent without retraction capability', async () => {
    mockListPending.mockReturnValue([
      {
        rule_id: 8,
        node_id: 11,
        kind: 'permanent',
        source_updated_at: 90,
        created_at: 1,
        updated_at: 2,
        attempts: 2,
        last_error: 'offline',
      },
    ]);
    mockFetchMeta.mockResolvedValue(metaWith());

    await flushPendingSuppressionRetractions(11);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)).toEqual({
      kind: 'permanent',
      source_updated_at: 90,
    });
    expect(mockDeletePending).toHaveBeenCalledWith(8, 11);
  });
});

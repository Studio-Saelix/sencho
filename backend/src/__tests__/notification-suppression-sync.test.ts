/**
 * Fleet sync for suppression rules: node_id normalize, capability gate, stale DELETE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetchMeta = vi.fn();
const mockGetProxyTarget = vi.fn();
const mockGetNodes = vi.fn();
const mockGetNode = vi.fn();
const mockRemoteAdvertises = vi.fn();

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getNodes: mockGetNodes,
      getNode: mockGetNode,
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
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    mockRemoteAdvertises.mockResolvedValue(true);
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

  it('probe false + DELETE success: no POST; cleanup logged as removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('replica was removed'))).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(false);
  });

  it('probe false + no proxy target: no successful-cleanup claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRemoteAdvertises.mockResolvedValue(false);
    mockGetProxyTarget.mockReturnValue(null);

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('replica was removed'))).toBe(false);
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(true);
  });

  it('scheduleInvalid: DELETE success, no POST', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => {
      expect(warn.mock.calls.some((c) => String(c[0]).includes('replica removed'))).toBe(true);
    });

    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(false);
  });

  it('scheduleInvalid: DELETE 404 counts as cleanup success, no POST', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'gone' });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => {
      expect(warn.mock.calls.some((c) => String(c[0]).includes('replica removed'))).toBe(true);
    });
    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
  });

  it('scheduleInvalid: DELETE failure logs pending cleanup, no POST', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(true);
  });

  it('scheduleInvalid: no proxy target logs pending, no POST', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetProxyTarget.mockReturnValue(null);

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: null,
      scheduleInvalid: true,
    }));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('replica removed'))).toBe(false);
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(true);
  });

  it('unscheduled-to-scheduled on unsupported target attempts DELETE', async () => {
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const previous = makeRule({ node_id: 10, schedule: null });
    const updated = makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    });
    syncSuppressionRuleUpdateToFleet(previous, updated);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
  });

  it('probe false + DELETE failure: no POST; logs cleanup pending', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRemoteAdvertises.mockResolvedValue(false);
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });

    syncSuppressionRuleToFleet(makeRule({
      node_id: 10,
      schedule: { days: [1], start_minute: 0, end_minute: 60, tz: 'UTC' },
    }));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    expect(mockFetch.mock.calls.every((c) => (c[1] as { method: string }).method === 'DELETE')).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes('cleanup pending'))).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes('rule 42'))).toBe(true);
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

  it('stale targets receive DELETE on scope change', async () => {
    const previous = makeRule({ node_id: null, schedule: null });
    const updated = makeRule({ node_id: 10, schedule: null });
    syncSuppressionRuleUpdateToFleet(previous, updated);
    await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2));

    const deletes = mockFetch.mock.calls.filter((c) => (c[1] as { method: string }).method === 'DELETE');
    expect(deletes.some((c) => String(c[0]).includes('node-11'))).toBe(true);
    const posts = mockFetch.mock.calls.filter((c) => (c[1] as { method: string }).method === 'POST');
    expect(posts.some((c) => String(c[0]).includes('node-10'))).toBe(true);
  });
});

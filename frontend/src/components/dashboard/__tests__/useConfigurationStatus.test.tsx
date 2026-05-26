import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const useNodesMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => useNodesMock(),
}));

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils');
  return {
    ...actual,
    visibilityInterval: () => () => {},
  };
});

import { useConfigurationStatus } from '../useConfigurationStatus';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fireInvalidate(detail: { scope?: string; action?: string } = {}) {
  window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail }));
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(() => Promise.resolve(okJson({
    tier: 'community',
    variant: null,
    notifications: { agents: {}, alertRules: 0, routingRules: { count: 0, enabledCount: 0, locked: true, requiredTier: 'skipper' } },
    automation: {
      autoHeal: { total: 0, enabled: 0 },
      autoUpdate: { enabled: 0, total: 0 },
      scheduledTasks: { total: 0, enabled: 0, locked: true, requiredTier: 'admiral' },
      webhooks: { total: 0, enabled: 0, locked: true, requiredTier: 'skipper' },
    },
    security: {
      mfaEnabled: null,
      ssoEnabled: false,
      ssoProvider: null,
      scanPolicies: { total: 0, enabled: 0, locked: true, requiredTier: 'skipper' },
    },
    thresholds: { cpuLimit: 90, ramLimit: 90, diskLimit: 90, dockerJanitorGb: 5, globalCrash: false },
    backup: { provider: 'disabled', autoUpload: false, locked: false },
  })));
  useNodesMock.mockReset();
  useNodesMock.mockReturnValue({
    activeNode: { id: 1, name: 'Local', type: 'local' },
    nodes: [{ id: 1, name: 'Local', type: 'local' }],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useConfigurationStatus state-invalidate handling', () => {
  it('does not refetch on container or image-update state-invalidate events', async () => {
    renderHook(() => useConfigurationStatus());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const baseline = apiFetchMock.mock.calls.length;

    act(() => {
      for (let i = 0; i < 5; i += 1) fireInvalidate({ scope: 'stack' });
      for (let i = 0; i < 5; i += 1) fireInvalidate({ scope: 'image-updates' });
    });
    await act(async () => { vi.advanceTimersByTime(2_000); });

    // Neither container churn nor image-update bursts mutate the
    // configuration payload; the filtered listener must ignore them.
    expect(apiFetchMock.mock.calls.length).toBe(baseline);
  });

  it('refetches once on a scheduled-tasks invalidation', async () => {
    renderHook(() => useConfigurationStatus());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const baseline = apiFetchMock.mock.calls.length;

    act(() => {
      // Burst three scheduled-tasks-change events; the debounce should
      // collapse them into a single refetch.
      fireInvalidate({ scope: 'scheduled-tasks', action: 'created' });
      fireInvalidate({ scope: 'scheduled-tasks', action: 'toggled' });
      fireInvalidate({ scope: 'scheduled-tasks', action: 'deleted' });
    });
    // Before debounce window elapses, no new fetch.
    expect(apiFetchMock.mock.calls.length).toBe(baseline);

    await act(async () => { vi.advanceTimersByTime(300); });
    expect(apiFetchMock.mock.calls.length).toBe(baseline + 1);
  });
});

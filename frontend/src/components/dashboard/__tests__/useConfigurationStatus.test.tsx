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
import { emitMuteRulesChanged } from '@/lib/muteRules';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fireInvalidate(detail: { scope?: string; action?: string } = {}) {
  window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail }));
}

function fireConnection(connected: boolean) {
  window.dispatchEvent(new CustomEvent('sencho:notifications-connection', { detail: { connected } }));
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(() => Promise.resolve(okJson({
    tier: 'community',
    notifications: { agents: {}, alertRules: 0, routingRules: { count: 0, enabledCount: 0, locked: true } },
    automation: {
      autoHeal: { total: 0, enabled: 0 },
      autoUpdate: { enabled: 0, total: 0 },
      scheduledTasks: { total: 0, enabled: 0, locked: true },
      webhooks: { total: 0, enabled: 0, locked: true },
    },
    security: {
      mfaEnabled: null,
      ssoEnabled: false,
      ssoProvider: null,
      scanPolicies: { total: 0, enabled: 0, locked: false },
    },
    thresholds: { cpuLimit: 90, ramLimit: 90, diskLimit: 90, dockerJanitorGb: 5, globalCrash: false, hostAlertsEnabled: true },
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

describe('useConfigurationStatus stream convergence', () => {
  it('refetches once when the notification stream reports a connection', async () => {
    renderHook(() => useConfigurationStatus());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const baseline = apiFetchMock.mock.calls.length;

    await act(async () => { fireConnection(true); await Promise.resolve(); });

    // The connected edge is a convergence signal, not a reconnect signal
    // specifically: it lands on the first connect too. It needs no debounce
    // because it fires once per edge.
    expect(apiFetchMock.mock.calls.length).toBe(baseline + 1);
  });

  it('does not refetch when the notification stream drops', async () => {
    renderHook(() => useConfigurationStatus());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const baseline = apiFetchMock.mock.calls.length;

    await act(async () => { fireConnection(false); vi.advanceTimersByTime(2_000); });

    expect(apiFetchMock.mock.calls.length).toBe(baseline);
  });
});

describe('useConfigurationStatus in-place edits', () => {
  it('refetches when a mute rule is created while Home stays mounted', async () => {
    renderHook(() => useConfigurationStatus());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const baseline = apiFetchMock.mock.calls.length;

    await act(async () => { emitMuteRulesChanged(); await Promise.resolve(); });

    expect(apiFetchMock.mock.calls.length).toBe(baseline + 1);
  });
});

describe('useConfigurationStatus node switches', () => {
  it('drops a response that lands after the active node changed', async () => {
    let resolveSlow: (res: Response) => void = () => {};
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSlow = resolve; }));

    const { result, rerender } = renderHook(() => useConfigurationStatus());
    // Switch nodes while node 1's request is still in flight; node 2's fetch
    // keeps the default payload but with a marker the test can see.
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    useNodesMock.mockReturnValue({
      activeNode: { id: 2, name: 'edge', type: 'remote' },
      nodes: [{ id: 1, name: 'Local', type: 'local' }, { id: 2, name: 'edge', type: 'remote' }],
    });
    rerender();

    await act(async () => {
      resolveSlow(okJson({ tier: 'paid', notifications: { agents: {} } }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Node 1's answer must not paint under node 2, and node 2 is still loading.
    expect(result.current.status).toBeNull();
    expect(result.current.loading).toBe(true);
  });
});

describe('useConfigurationStatus failed refreshes', () => {
  it('keeps the last payload and marks it stale when a later refresh fails, then clears on success', async () => {
    const { result } = renderHook(() => useConfigurationStatus());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).not.toBeNull();
    expect(result.current.stale).toBe(false);

    apiFetchMock.mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 502 })));
    await act(async () => { fireConnection(true); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).not.toBeNull();
    expect(result.current.stale).toBe(true);

    await act(async () => { fireConnection(true); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.stale).toBe(false);
  });

  it('lets only the newest of two overlapping requests write', async () => {
    const { result } = renderHook(() => useConfigurationStatus());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    let resolveOld: (res: Response) => void = () => {};
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }));
    apiFetchMock.mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 502 })));
    await act(async () => { fireConnection(true); fireConnection(true); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.stale).toBe(true);

    // The older request answering late must not overwrite the newer outcome.
    await act(async () => { resolveOld(okJson({ tier: 'paid', notifications: { agents: {} } })); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.stale).toBe(true);
    expect(result.current.status?.tier).toBe('community');
  });
});

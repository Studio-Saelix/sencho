import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DeployFeedbackProvider, useDeployFeedback } from '../DeployFeedbackContext';
import { DEPLOY_FEEDBACK_KEY } from '@/hooks/use-deploy-feedback-enabled';
import { DEPLOY_FEEDBACK_STYLE_KEY } from '@/hooks/use-deploy-feedback-style';

// Only the health-gate poll touches the network; mock apiFetch so a poll can be
// asserted to target the captured node. Other exports stay real.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

// Mock serviceUpdate (apiFetch is already mocked above) and toast-store.
vi.mock('@/lib/serviceUpdate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/serviceUpdate')>();
  return { ...actual, fetchStackRecoveries: vi.fn(), requestServiceRestore: vi.fn() };
});
import { fetchStackRecoveries, requestServiceRestore, type StackRecoveryEntry } from '@/lib/serviceUpdate';

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => 'toast-1'),
    dismiss: vi.fn(),
  },
}));
import { toast } from '@/components/ui/toast-store';

/** A successful /recoveries read. */
const recoveries = (entries: StackRecoveryEntry[]) => ({ ok: true as const, recoveries: entries });
/** A failed /recoveries read, which must never read as "no recoveries". */
const readFailed = (error = 'fetch failed') => ({ ok: false as const, error });

function recoveryEntry(overrides: Partial<StackRecoveryEntry> = {}): StackRecoveryEntry {
  return {
    serviceName: 'sibling',
    recoveryId: 'rec-sibling',
    healthGateId: 'gate-sibling',
    healthGateStatus: 'failed',
    healthGateReason: 'timeout',
    healthGateFailureSource: 'primary',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <DeployFeedbackProvider>{children}</DeployFeedbackProvider>;
}

describe('DeployFeedbackContext', () => {
  beforeEach(() => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'true');
    vi.mocked(apiFetch).mockReset();
    vi.mocked(fetchStackRecoveries).mockReset();
    vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([]));
    vi.mocked(requestServiceRestore).mockReset();
    vi.useRealTimers();
  });
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('releases the deploy when the progress stream fails before connecting', async () => {
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let deployRan = false;
    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog({ stackName: 'web', action: 'deploy', nodeId: null }, async (started) => {
        await started;
        deployRan = true;
        return { ok: true };
      });
      // Let runWithLog install the start gate and let run() reach `await started`.
      await Promise.resolve();
    });

    // The deploy must not have fired yet: it is gated on the progress stream.
    expect(deployRan).toBe(false);

    // A connect failure (e.g. the admin-only /ws gate rejecting a scoped deployer,
    // or a reverse proxy blocking the upgrade) must release the gate, not hang.
    await act(async () => {
      result.current.onTerminalError();
      await outer;
    });

    expect(deployRan).toBe(true);
    expect(result.current.panelState.progressUnavailable).toBe(true);
    expect(result.current.panelState.status).toBe('succeeded');
  });

  it('marks progress unavailable on a mid-stream drop without re-running or blocking the deploy', async () => {
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let runCount = 0;
    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog({ stackName: 'web', action: 'deploy', nodeId: null }, async (started) => {
        await started;
        runCount += 1;
        return { ok: true };
      });
      await Promise.resolve();
    });

    // Stream connects -> gate releases (after the 50ms buffer) -> deploy runs once.
    await act(async () => {
      result.current.onTerminalReady();
      await outer;
    });
    expect(runCount).toBe(1);
    expect(result.current.panelState.status).toBe('succeeded');

    // A late socket drop only flags unavailability; it must not re-settle or re-run.
    act(() => {
      result.current.onTerminalError();
    });
    expect(result.current.panelState.progressUnavailable).toBe(true);
    expect(runCount).toBe(1);
  });

  it('releases the deploy via the connect timeout when the stream never signals', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useDeployFeedback(), { wrapper });

      let runCount = 0;
      let outer: Promise<unknown> | undefined;
      await act(async () => {
        outer = result.current.runWithLog({ stackName: 'web', action: 'deploy', nodeId: null }, async (started) => {
          await started;
          runCount += 1;
          return { ok: true };
        });
        await Promise.resolve();
      });

      expect(runCount).toBe(0);
      // Neither ready nor error fires; the 8s fallback must still release the deploy
      // and flag live output unavailable so the modal stops showing "Connecting...".
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
        await outer;
      });
      expect(runCount).toBe(1);
      expect(result.current.panelState.progressUnavailable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the truncation sentinel instead of stacking it on repeated overflow', () => {
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    act(() => {
      result.current.onMessage(Array.from({ length: 6000 }, (_, i) => `a ${i}`).join('\n'));
    });
    act(() => {
      result.current.onMessage('b 0\nb 1');
    });

    expect(result.current.logRows.length).toBe(5001);
    expect(result.current.logRows.filter((r) => r.id === 'row-truncated').length).toBe(1);
    expect(result.current.logRows[0].id).toBe('row-truncated');
    expect(result.current.logRows[result.current.logRows.length - 1].message).toContain('b 1');
  });

  it('runs immediately with no panel when the feature is disabled', async () => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let deployRan = false;
    await act(async () => {
      await result.current.runWithLog({ stackName: 'web', action: 'deploy', nodeId: null }, async (started) => {
        await started;
        deployRan = true;
        return { ok: true };
      });
    });

    expect(deployRan).toBe(true);
    expect(result.current.panelState.isOpen).toBe(false);
  });

  it('silently polls a service health gate when Deploy Progress is disabled', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        if (String(url).includes('/health-gate')) {
          return new Response(JSON.stringify({
            id: 'gate-svc', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now(),
            targetScope: 'service', serviceName: 'api', failureSource: null,
          }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });
      const { result } = renderHook(() => useDeployFeedback(), { wrapper });

      await act(async () => {
        await result.current.runWithLog(
          { stackName: 'web', action: 'update', nodeId: null, serviceName: 'api' },
          async (started) => {
            await started;
            return { ok: true, healthGateId: 'gate-svc', recoveryId: 'rec-1' };
          },
        );
      });

      expect(result.current.panelState.isOpen).toBe(false);
      expect(result.current.healthGate).toMatchObject({
        gateId: 'gate-svc', serviceName: 'api', recoveryId: 'rec-1', status: 'observing',
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/stacks/web/health-gate?gateId=gate-svc'),
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps service gate recovery after the panel is closed', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        if (String(url).includes('/health-gate')) {
          return new Response(JSON.stringify({
            id: 'gate-svc', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now(),
            targetScope: 'service', serviceName: 'api', failureSource: null,
          }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });
      const { result } = renderHook(() => useDeployFeedback(), { wrapper });

      let outer: Promise<unknown> | undefined;
      await act(async () => {
        outer = result.current.runWithLog(
          { stackName: 'web', action: 'update', nodeId: null, serviceName: 'api' },
          async (started) => {
            await started;
            return { ok: true, healthGateId: 'gate-svc', recoveryId: 'rec-keep' };
          },
        );
        await Promise.resolve();
      });
      // onTerminalReady schedules the deploy gate release after 50ms.
      await act(async () => {
        result.current.onTerminalReady();
        await vi.advanceTimersByTimeAsync(60);
        await outer;
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.healthGate?.recoveryId).toBe('rec-keep');

      act(() => { result.current.onPanelClose(); });
      expect(result.current.panelState.isOpen).toBe(false);
      expect(result.current.healthGate).toMatchObject({
        gateId: 'gate-svc', recoveryId: 'rec-keep', status: 'observing',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps log rows and marks the truncation point', () => {
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    const chunk = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n');
    act(() => {
      result.current.onMessage(chunk);
    });

    expect(result.current.logRows.length).toBe(5001);
    expect(result.current.logRows[0].id).toBe('row-truncated');
    expect(result.current.logRows[result.current.logRows.length - 1].message).toContain('line 5999');
  });

  it('stores the operation node id on the panel state', async () => {
    localStorage.setItem(DEPLOY_FEEDBACK_STYLE_KEY, 'inline');
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog({ stackName: 'web', action: 'update', nodeId: 7 }, async (s) => { await s; return { ok: true }; });
      await Promise.resolve();
    });
    // nodeId is stamped synchronously when the panel opens, before the gate.
    expect(result.current.panelState.nodeId).toBe(7);

    await act(async () => { result.current.onTerminalReady(); await outer; });
  });

  it('polls the health gate on the captured node and stamps it on the gate state', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(
      JSON.stringify({ id: 'g1', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now() }),
      { status: 200 },
    ));
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog({ stackName: 'web', action: 'update', nodeId: 7 }, async (started) => {
        await started;
        return { ok: true, healthGateId: 'g1' };
      });
      await Promise.resolve();
    });

    await act(async () => {
      result.current.onTerminalReady();
      await outer;
      // Let the immediate gate tick's apiFetch resolve and its setHealthGate land.
      await Promise.resolve();
      await Promise.resolve();
    });

    const gateCall = vi.mocked(apiFetch).mock.calls.find((c) => String(c[0]).includes('/health-gate'));
    expect(gateCall).toBeDefined();
    expect(gateCall?.[1]).toEqual(expect.objectContaining({ nodeId: 7 }));
    expect(result.current.healthGate?.nodeId).toBe(7);

    act(() => { result.current.onPanelClose(); });
  });

  it('minimized is false before any session', () => {
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });
    expect(result.current.minimized).toBe(false);
  });

  it('inline style starts the session minimized (banner is the surface)', async () => {
    localStorage.setItem(DEPLOY_FEEDBACK_STYLE_KEY, 'inline');
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog({ stackName: 'web', action: 'update', nodeId: null }, async (started) => {
        await started;
        return { ok: true };
      });
      await Promise.resolve();
    });
    expect(result.current.minimized).toBe(true);
    expect(result.current.panelState.isOpen).toBe(true);

    await act(async () => { result.current.onTerminalReady(); await outer; });
  });

  it('modal style starts not minimized and gates the deploy on the stream', async () => {
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let deployRan = false;
    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog({ stackName: 'web', action: 'deploy', nodeId: 3 }, async (started) => {
        await started;
        deployRan = true;
        return { ok: true };
      });
      await Promise.resolve();
    });

    expect(result.current.minimized).toBe(false);
    expect(result.current.panelState.nodeId).toBe(3);
    expect(deployRan).toBe(false);

    await act(async () => {
      result.current.onTerminalReady();
      await outer;
    });
    expect(deployRan).toBe(true);
  });

  it('setMinimized toggles, and onPanelClose resets it', async () => {
    localStorage.setItem(DEPLOY_FEEDBACK_STYLE_KEY, 'inline');
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog({ stackName: 'web', action: 'update', nodeId: null }, async (s) => { await s; return { ok: true }; });
      await Promise.resolve();
    });
    expect(result.current.minimized).toBe(true);

    act(() => result.current.setMinimized(false));
    expect(result.current.minimized).toBe(false);

    await act(async () => { result.current.onTerminalReady(); await outer; });

    act(() => result.current.onPanelClose());
    expect(result.current.minimized).toBe(false);
    expect(result.current.panelState.isOpen).toBe(false);
  });
});

describe('overlapping silent gates', () => {
  beforeEach(() => {
    // Deploy Progress must be disabled so the silent gate recovery resurface logic runs.
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
  });

  afterEach(() => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'true');
  });

  async function runServiceUpdate(
    nodeId: number | null = null,
    stackName = 'web',
    serviceName = 'api',
    initialRecoveries: StackRecoveryEntry[] = [],
  ) {
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });
    // startGatePolling's tick() needs apiFetch to return a health-gate response.
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (!String(url).includes('/recoveries')) {
        return new Response(JSON.stringify({ id: 'gate-svc', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now(), targetScope: 'service', serviceName: 'api', failureSource: null }), { status: 200 });
      }
      return new Response(JSON.stringify(initialRecoveries), { status: 200 });
    });
    // fetchStackRecoveries is called inside runWithLog's !isEnabled branch.
    // Give it a real implementation that returns initialRecoveries so the
    // for-of loop doesn't throw and the resurface logic actually runs.
    vi.mocked(fetchStackRecoveries).mockImplementation(async () => recoveries(initialRecoveries));
    const startedPromise = new Promise<void>(resolve => { setTimeout(resolve, 0); });

    await act(async () => {
      result.current.runWithLog(
        { stackName, action: 'update', nodeId, serviceName },
        async (started) => { await started; await startedPromise; return { ok: true, healthGateId: 'gate-svc', recoveryId: 'rec-1' }; },
      );
      await Promise.resolve();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });
    return result;
  }

  it('surfaces a failed sibling recovery as a Restore toast at session start', async () => {
    const siblingRecovery = recoveryEntry();
    await runServiceUpdate(null, 'web', 'api', [siblingRecovery]);

    expect(toast.error).toHaveBeenCalled();
    const [msg, opts] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain('sibling');
    expect(opts).toMatchObject({ duration: 120_000, action: { label: 'Restore' } });
  });

  it('excludes the current service row from the sibling-check set', async () => {
    await runServiceUpdate(null, 'web', 'api', [recoveryEntry({
      serviceName: 'api', recoveryId: 'rec-api', healthGateId: 'gate-api',
    })]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('re-surfaces a failed sibling on a later silent session after watched state clears', async () => {
    const sibling = recoveryEntry();
    await runServiceUpdate(null, 'web', 'api', [sibling]);
    const firstToastCount = (toast.error as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(firstToastCount).toBeGreaterThan(0);

    await runServiceUpdate(null, 'web', 'api', [sibling]);
    const secondToastCount = (toast.error as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(secondToastCount).toBeGreaterThan(firstToastCount);
  });

  it('ignores a sibling-recovery response that lands after a newer session started', async () => {
    // Session 1's /recoveries fetch is still in flight when session 2 begins.
    // When the stale response finally lands it must not toast or arm a watch
    // from a view the newer session has already superseded.
    let resolveFirst: (entries: StackRecoveryEntry[]) => void = () => {};
    const firstFetch = new Promise<StackRecoveryEntry[]>((resolve) => { resolveFirst = resolve; });
    vi.mocked(fetchStackRecoveries)
      .mockImplementationOnce(() => firstFetch.then(recoveries))
      .mockResolvedValue(recoveries([]));
    vi.mocked(apiFetch).mockImplementation(async () =>
      new Response(JSON.stringify({
        id: 'gate-svc', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now(),
        targetScope: 'service', serviceName: 'api', failureSource: null,
      }), { status: 200 }),
    );

    const { result } = renderHook(() => useDeployFeedback(), { wrapper });
    const runUpdate = (gateId: string) =>
      result.current.runWithLog(
        { stackName: 'web', action: 'update', nodeId: null, serviceName: 'api' },
        async (started) => { await started; return { ok: true, healthGateId: gateId, recoveryId: 'rec-1' }; },
      );

    await act(async () => { await runUpdate('gate-svc-1'); });
    await act(async () => { await runUpdate('gate-svc-2'); });

    const failedSibling = recoveryEntry();
    await act(async () => {
      resolveFirst([failedSibling]);
      await firstFetch;
      await Promise.resolve();
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('continues polling an observing sibling and surfaces it when it transitions to failed', async () => {
    const observingEntry = recoveryEntry({ healthGateStatus: 'observing', healthGateReason: null, healthGateFailureSource: null });
    const failedEntry = recoveryEntry();

    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useDeployFeedback(), { wrapper });
      const gateBody = {
        id: 'gate-svc', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now(),
        targetScope: 'service', serviceName: 'api', failureSource: null,
      };
      vi.mocked(apiFetch).mockImplementation(async () =>
        new Response(JSON.stringify(gateBody), { status: 200 }),
      );
      vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([observingEntry]));

      let runDone: Promise<unknown> | undefined;
      await act(async () => {
        runDone = result.current.runWithLog(
          { stackName: 'web', action: 'update', nodeId: null, serviceName: 'api' },
          async (started) => {
            await started;
            return { ok: true, healthGateId: 'gate-svc', recoveryId: 'rec-1' };
          },
        );
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => { await runDone; });
      expect(toast.error).not.toHaveBeenCalled();

      vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([failedEntry]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(toast.error).toHaveBeenCalled();
      const [msg, opts] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(msg).toContain('sibling');
      expect(opts).toMatchObject({ duration: 120_000, action: { label: 'Restore' } });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect((toast.error as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sibling recoveries with Deploy Progress on', () => {
  // DEPLOY_FEEDBACK_KEY defaults to 'true' in the top-level beforeEach.
  const failedSibling = recoveryEntry();

  async function runEnabledServiceUpdate() {
    vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([failedSibling]));
    vi.mocked(apiFetch).mockImplementation(async () =>
      new Response(JSON.stringify({
        id: 'gate-svc', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now(),
        targetScope: 'service', serviceName: 'api', failureSource: null,
      }), { status: 200 }),
    );
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog(
        { stackName: 'web', action: 'update', nodeId: null, serviceName: 'api' },
        async (started) => { await started; return { ok: true, healthGateId: 'gate-svc', recoveryId: 'rec-1' }; },
      );
      await Promise.resolve();
    });
    await act(async () => {
      result.current.onTerminalReady();
      await outer;
      await Promise.resolve();
      await Promise.resolve();
    });
    return result;
  }

  function expectSiblingRestoreToast() {
    expect(toast.error).toHaveBeenCalled();
    const [msg, opts] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain('sibling');
    expect(opts).toMatchObject({ duration: 120_000, action: { label: 'Restore' } });
  }

  it('surfaces a failed sibling as a Restore toast on the enabled path', async () => {
    await runEnabledServiceUpdate();
    expectSiblingRestoreToast();
  });

  it('keeps watching an observing sibling after the panel is dismissed', async () => {
    vi.useFakeTimers();
    try {
      const observingSibling = recoveryEntry({ healthGateStatus: 'observing', healthGateReason: null, healthGateFailureSource: null });
      vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([observingSibling]));
      vi.mocked(apiFetch).mockImplementation(async () =>
        new Response(JSON.stringify({
          id: 'gate-svc', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now(),
          targetScope: 'service', serviceName: 'api', failureSource: null,
        }), { status: 200 }),
      );
      const { result } = renderHook(() => useDeployFeedback(), { wrapper });

      let outer: Promise<unknown> | undefined;
      await act(async () => {
        outer = result.current.runWithLog(
          { stackName: 'web', action: 'update', nodeId: null, serviceName: 'api' },
          async (started) => { await started; return { ok: true, healthGateId: 'gate-svc', recoveryId: 'rec-1' }; },
        );
        await Promise.resolve();
      });
      await act(async () => {
        result.current.onTerminalReady();
        await vi.advanceTimersByTimeAsync(60);
        await outer;
        await Promise.resolve();
        await Promise.resolve();
      });
      // Observing sibling produces no toast yet.
      expect(toast.error).not.toHaveBeenCalled();

      // Dismiss the panel: the service gate keeps watching silently, and so
      // must the sibling poll.
      act(() => { result.current.onPanelClose(); });
      expect(result.current.panelState.isOpen).toBe(false);

      vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([failedSibling]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expectSiblingRestoreToast();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A service whose update is still observing must keep its Restore offer no
 * matter what the next operation does to the deploy session: an overlapping
 * update that fails or returns no gate, a panel close after the second gate
 * settles, an update on another stack, or a Restore click of a sibling.
 */
describe('an overlapping operation never cancels an earlier Restore offer', () => {
  type Session = { current: ReturnType<typeof useDeployFeedback> };
  type RunOutcome = { ok: boolean; healthGateId?: string | null; recoveryId?: string | null; errorMessage?: string };

  const observing = (serviceName: string, recoveryId: string) => recoveryEntry({
    serviceName, recoveryId, healthGateId: `gate-${serviceName}`,
    healthGateStatus: 'observing', healthGateReason: null, healthGateFailureSource: null,
  });
  const failed = (serviceName: string, recoveryId: string) => recoveryEntry({
    serviceName, recoveryId, healthGateId: `gate-${serviceName}`,
  });

  /** Health-gate read keyed by gate id, echoing the requested id back. */
  function mockGates(byGateId: Record<string, 'observing' | 'passed' | 'failed' | 'unknown'> = {}) {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      const gateId = new URL(String(url), 'http://localhost').searchParams.get('gateId') ?? '';
      return new Response(JSON.stringify({
        id: gateId, status: byGateId[gateId] ?? 'observing', reason: null,
        windowSeconds: 90, startedAt: Date.now(), targetScope: 'service', serviceName: 'api', failureSource: null,
      }), { status: 200 });
    });
  }

  /** Drives one runWithLog session to completion, stream gate included. */
  async function runSession(
    session: Session,
    params: { stackName?: string; serviceName?: string; action?: 'update' | 'deploy'; nodeId?: number | null },
    outcome: RunOutcome,
  ) {
    let done: Promise<unknown> | undefined;
    await act(async () => {
      done = session.current.runWithLog(
        { stackName: 'web', action: 'update', nodeId: null, serviceName: 'api', ...params },
        async (started) => { await started; return outcome; },
      );
      await Promise.resolve();
    });
    await act(async () => {
      session.current.onTerminalReady();
      await vi.advanceTimersByTimeAsync(60);
      await done;
    });
    // Let the immediate gate tick and the sibling-recovery read settle.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  }

  const tick = (ms = 4_000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  function restoreToasts(): [string, { action?: { label: string; onClick: () => void } }][] {
    return (toast.error as ReturnType<typeof vi.fn>).mock.calls as [
      string, { action?: { label: string; onClick: () => void } },
    ][];
  }

  function expectRestoreToast(serviceName: string) {
    const match = restoreToasts().find(([msg]) => msg.includes(`"${serviceName}"`));
    expect(match, `no Restore toast offered for "${serviceName}"`).toBeDefined();
    expect(match![1].action).toMatchObject({ label: 'Restore' });
  }

  /** The onClick of the Restore action on the toast offered for `serviceName`. */
  function restoreActionFor(serviceName: string) {
    const match = restoreToasts().find(([msg]) => msg.includes(`"${serviceName}"`));
    expect(match, `no Restore toast offered for "${serviceName}"`).toBeDefined();
    return match![1].action!.onClick;
  }

  function renderSession() {
    return renderHook(() => useDeployFeedback(), { wrapper });
  }

  beforeEach(() => {
    // Set per test rather than inherited: two of these run the silent path, and
    // the setting must not leak into the next test in this block.
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'true');
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.info).mockClear();
  });

  it('keeps the earlier service watched when the overlapping update fails', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await runSession(result, { serviceName: 'db' }, { ok: false, errorMessage: 'compose up failed' });

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the earlier service watched when the overlapping update has no health gate', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      // No healthcheck, the gate setting is off, or the concurrency cap hit.
      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: null });

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the earlier service watched when the panel closes after the second gate settles', async () => {
    vi.useFakeTimers();
    try {
      mockGates({ 'gate-db': 'passed' });
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([
        observing('api', 'rec-api'), observing('db', 'rec-db'),
      ]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });
      // The second gate passed, so closing the panel ends that run's watch. It
      // must not end the first service's pending Restore offer with it.
      expect(result.current.healthGate).toMatchObject({ gateId: 'gate-db', status: 'passed' });
      act(() => { result.current.onPanelClose(); });

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stack watched when the next update runs on another stack', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      const byStack: Record<string, ReturnType<typeof recoveries> | ReturnType<typeof readFailed>> = {
        web: recoveries([observing('api', 'rec-api'), observing('db', 'rec-db')]),
        billing: recoveries([observing('ledger', 'rec-ledger')]),
      };
      vi.mocked(fetchStackRecoveries).mockImplementation(async ({ stackName }) => byStack[stackName] ?? recoveries([]));
      const { result } = renderSession();

      await runSession(result, { stackName: 'web', serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await runSession(result, { stackName: 'web', serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });
      // An update on a different stack cancels the deploy session, not the
      // other stack's pending Restore offer.
      await runSession(result, { stackName: 'billing', serviceName: 'ledger' }, { ok: true, healthGateId: 'gate-ledger', recoveryId: 'rec-ledger' });

      byStack.web = recoveries([failed('api', 'rec-api'), observing('db', 'rec-db')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers no Restore for service snapshots after a stack-scoped deploy', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([failed('api', 'rec-api')]));
      const { result } = renderSession();

      // A full deploy replaced the images that snapshot would roll back to, so
      // re-offering it is a rollback to state the operator just replaced.
      await runSession(result, { action: 'deploy', serviceName: undefined }, { ok: true, healthGateId: 'gate-stack' });
      await tick();

      expect(toast.error).not.toHaveBeenCalled();
      expect(fetchStackRecoveries).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps watching through a failed recoveries read', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });

      // A 429, a 5xx, a proxy blip, or a node predating the route must not read
      // as "the recovery is gone".
      read = readFailed();
      await tick();
      await tick();
      expect(toast.error).not.toHaveBeenCalled();

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers nothing for a poll that was already in flight when the deploy replaced the images', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      type Read = ReturnType<typeof recoveries> | ReturnType<typeof readFailed>;
      let resolvePoll: (read: Read) => void = () => {};
      const inFlight = new Promise<Read>((resolve) => { resolvePoll = resolve; });
      let surfaceDone = false;
      vi.mocked(fetchStackRecoveries).mockImplementation(() =>
        surfaceDone ? inFlight : Promise.resolve(recoveries([observing('api', 'rec-api')])),
      );
      const { result } = renderSession();

      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });
      // A poll is outstanding when the deploy lands, and its response is a
      // failure for a snapshot the deploy just replaced.
      surfaceDone = true;
      await tick();
      await runSession(result, { action: 'deploy', serviceName: undefined }, { ok: true, healthGateId: 'gate-stack' });

      await act(async () => {
        resolvePoll(recoveries([failed('api', 'rec-api')]));
        await inFlight;
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a service watched after its own gate could not be read', async () => {
    vi.useFakeTimers();
    try {
      // The by-id gate read keeps failing while the recoveries read still works,
      // which is what resolves the gate to unknown and ends its primary poll.
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        if (String(url).includes('gateId=gate-api')) return new Response('{}', { status: 500 });
        return new Response(JSON.stringify({
          id: 'gate-db', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now(),
          targetScope: 'service', serviceName: 'db', failureSource: null,
        }), { status: 200 });
      });
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await tick(); await tick(); await tick();
      expect(result.current.healthGate).toMatchObject({ gateId: 'gate-api', status: 'unknown' });

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a snapshot once when the primary gate and the stack watch both see it fail', async () => {
    // The silent no-gate path leaves the running session's gate polling while a
    // later update arms the same service on the stack watch, so two pollers can
    // discover one failure. The recoveries row and the gate row are separate
    // reads, which is exactly how they diverge in production too.
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
    vi.useFakeTimers();
    try {
      mockGates({ 'gate-api': 'failed' });
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      // The primary poller resolves the gate as failed and offers the snapshot.
      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      expect(restoreToasts().filter(([msg]) => msg.includes('"api"'))).toHaveLength(1);

      // A gate-less update on the silent path keeps that poller running and
      // surfaces the same service onto the stack watch.
      await runSession(result, { serviceName: 'db' }, { ok: true });
      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expect(restoreToasts().filter(([msg]) => msg.includes('"api"'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a service watched after a re-arm following failed reads', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });
      read = readFailed();
      await tick(); await tick(); await tick();
      // A successful read of the stack re-arms the service, which proves the
      // route is answerable, so the failed-read budget starts over.
      read = recoveries([observing('api', 'rec-api')]);
      await runSession(result, { serviceName: 'ledger' }, { ok: true, healthGateId: 'gate-ledger', recoveryId: 'rec-ledger' });

      read = readFailed();
      await tick();
      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling a stack after repeated recoveries failures', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      // The two surface reads succeed (that is what arms the watch); every poll
      // after them fails, as a node predating this route would.
      let reads = 0;
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => {
        reads += 1;
        return reads <= 2 ? recoveries([observing('api', 'rec-api')]) : readFailed();
      });
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });
      const afterSurface = vi.mocked(fetchStackRecoveries).mock.calls.length;

      // Four failed reads exhaust the strike budget, so a node that will never
      // answer this route stops being polled instead of retrying forever.
      await tick(); await tick(); await tick(); await tick();
      expect(vi.mocked(fetchStackRecoveries).mock.calls.length).toBe(afterSurface + 4);

      await tick();
      expect(vi.mocked(fetchStackRecoveries).mock.calls.length).toBe(afterSurface + 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the earlier service watched when the overlapping update fails and its read fails too', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      // The overlapping update both failed and could not read the stack, so
      // nothing discovers the earlier service this time. The gate it took over
      // is already backed by the stack watch, which is what must catch the
      // failure: a single blip at session start cannot cancel the offer.
      read = readFailed();
      await runSession(result, { serviceName: 'db' }, { ok: false, errorMessage: 'compose up failed' });

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the earlier service watched on the silent path when the read fails too', async () => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      // Same as the enabled path: the gate that takes the primary slot hands the
      // one it replaces to the stack watch, so a failed read costs nothing.
      read = readFailed();
      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a snapshot at most once per session, whichever path finds it', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      // An earlier session leaves the api service on the stack watch.
      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });
      // The next session reads the same service as already failed and offers it,
      // while the watch armed for it is still polling.
      read = recoveries([failed('api', 'rec-api'), observing('db', 'rec-db')]);
      await runSession(result, { serviceName: 'ledger' }, { ok: true, healthGateId: 'gate-ledger', recoveryId: 'rec-ledger' });
      expect(restoreToasts().filter(([msg]) => msg.includes('"api"'))).toHaveLength(1);

      await tick();
      expect(restoreToasts().filter(([msg]) => msg.includes('"api"'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a stack watch once a stack-scoped deploy replaces the images', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });

      // A full deploy replaces what the watched snapshot would roll back to, so
      // the watch it already armed has to go, not just the re-surfacing.
      await runSession(result, { action: 'deploy', serviceName: undefined }, { ok: true, healthGateId: 'gate-stack' });
      const afterDeploy = vi.mocked(fetchStackRecoveries).mock.calls.length;

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expect(toast.error).not.toHaveBeenCalled();
      expect(vi.mocked(fetchStackRecoveries).mock.calls.length).toBe(afterDeploy);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stack watch when a stack-scoped run fails', async () => {
    vi.useFakeTimers();
    try {
      mockGates();
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([observing('api', 'rec-api')]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await runSession(result, { serviceName: 'db' }, { ok: true, healthGateId: 'gate-db', recoveryId: 'rec-db' });
      // The deploy changed nothing, so the snapshots still describe the running
      // images and their offers stand.
      await runSession(result, { action: 'deploy', serviceName: undefined }, { ok: false, errorMessage: 'compose up failed' });

      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the current service watched when a sibling Restore is clicked', async () => {
    vi.useFakeTimers();
    try {
      mockGates({ 'gate-restore': 'observing' });
      let read: ReturnType<typeof recoveries> | ReturnType<typeof readFailed> = recoveries([
        observing('api', 'rec-api'), failed('db', 'rec-db'),
      ]);
      vi.mocked(fetchStackRecoveries).mockImplementation(async () => read);
      vi.mocked(requestServiceRestore).mockResolvedValue({
        ok: true, mode: 'update', serviceName: 'db', healthGateId: 'gate-restore',
        observing: true, recoveryId: 'rec-restore', recoveryAvailable: true,
      });
      const { result } = renderSession();

      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      expectRestoreToast('db');

      await act(async () => { restoreActionFor('db')(); await vi.advanceTimersByTimeAsync(1); });
      // The restore took over the primary gate slot, so the api run's gate is
      // no longer polled; its Restore offer has to survive on the stack watch.
      read = recoveries([failed('api', 'rec-api')]);
      await tick();
      expectRestoreToast('api');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the surfaced snapshot when the toast action is clicked', async () => {
    vi.useFakeTimers();
    try {
      mockGates({ 'gate-restore': 'observing' });
      vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([failed('db', 'rec-db')]));
      vi.mocked(requestServiceRestore).mockResolvedValue({
        ok: true, mode: 'update', serviceName: 'db', healthGateId: 'gate-restore',
        observing: true, recoveryId: 'rec-restore', recoveryAvailable: true,
      });
      const { result } = renderSession();

      await runSession(result, { stackName: 'web', serviceName: 'api', nodeId: 4 }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await act(async () => { restoreActionFor('db')(); await vi.advanceTimersByTimeAsync(1); });

      expect(requestServiceRestore).toHaveBeenCalledWith({
        nodeId: 4, stackName: 'web', serviceName: 'db', recoveryId: 'rec-db',
      });
      expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('Verifying health'));
    } finally {
      vi.useRealTimers();
    }
  });

  describe('a restore that lands without a new gate', () => {
    /** Session whose own gate failed, with a second failed service alongside it. */
    async function failedGateSession() {
      mockGates({ 'gate-api': 'failed' });
      vi.mocked(fetchStackRecoveries).mockResolvedValue(recoveries([
        failed('api', 'rec-api'), failed('db', 'rec-db'),
      ]));
      vi.mocked(requestServiceRestore).mockResolvedValue({
        ok: true, mode: 'update', serviceName: 'x', healthGateId: null,
        observing: false, recoveryId: null, recoveryAvailable: false,
      });
      const { result } = renderSession();
      await runSession(result, { serviceName: 'api' }, { ok: true, healthGateId: 'gate-api', recoveryId: 'rec-api' });
      await tick();
      // Dismissing the panel keeps the failed service gate (and its Restore)
      // alive, and is what puts it on screen.
      act(() => { result.current.onPanelClose(); });
      expect(result.current.healthGate).toMatchObject({ gateId: 'gate-api', status: 'failed' });
      expectRestoreToast('db');
      expectRestoreToast('api');
      return result;
    }

    it('leaves another service\'s gate record in place', async () => {
      vi.useFakeTimers();
      try {
        const result = await failedGateSession();
        await act(async () => { restoreActionFor('db')(); await vi.advanceTimersByTimeAsync(1); });

        expect(result.current.healthGate).toMatchObject({
          gateId: 'gate-api', serviceName: 'api', status: 'failed',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the gate record it restored from', async () => {
      vi.useFakeTimers();
      try {
        const result = await failedGateSession();
        await act(async () => { restoreActionFor('api')(); await vi.advanceTimersByTimeAsync(1); });

        expect(result.current.healthGate).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});


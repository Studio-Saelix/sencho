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
  return { ...actual, fetchStackRecoveries: vi.fn() };
});
import { fetchStackRecoveries, type StackRecoveryEntry } from '@/lib/serviceUpdate';

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));
import { toast } from '@/components/ui/toast-store';

function wrapper({ children }: { children: ReactNode }) {
  return <DeployFeedbackProvider>{children}</DeployFeedbackProvider>;
}

describe('DeployFeedbackContext', () => {
  beforeEach(() => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'true');
    vi.mocked(apiFetch).mockReset();
    vi.mocked(fetchStackRecoveries).mockReset();
    vi.mocked(fetchStackRecoveries).mockResolvedValue([]);
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
    vi.mocked(fetchStackRecoveries).mockImplementation(async () => initialRecoveries);
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
    const siblingRecovery = { serviceName: 'sibling', recoveryId: 'rec-sibling', healthGateId: 'gate-sibling', healthGateStatus: 'failed' as const, healthGateReason: 'timeout', healthGateFailureSource: 'primary' as const, expiresAt: Date.now() + 60_000 };
    await runServiceUpdate(null, 'web', 'api', [siblingRecovery]);

    expect(toast.error).toHaveBeenCalled();
    const [msg, opts] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain('sibling');
    expect(opts).toMatchObject({ duration: 120_000, action: { label: 'Restore' } });
  });

  it('excludes the current service row from the sibling-check set', async () => {
    const currentOnly = [
      { serviceName: 'api', recoveryId: 'rec-api', healthGateId: 'gate-api', healthGateStatus: 'failed' as const, healthGateReason: 'timeout', healthGateFailureSource: 'primary' as const, expiresAt: Date.now() + 60_000 },
    ];
    await runServiceUpdate(null, 'web', 'api', currentOnly);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('re-surfaces a failed sibling on a later silent session after watched state clears', async () => {
    const sibling = { serviceName: 'sibling', recoveryId: 'rec-sibling', healthGateId: 'gate-sibling', healthGateStatus: 'failed' as const, healthGateReason: 'timeout', healthGateFailureSource: 'primary' as const, expiresAt: Date.now() + 60_000 };
    await runServiceUpdate(null, 'web', 'api', [sibling]);
    const firstToastCount = (toast.error as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(firstToastCount).toBeGreaterThan(0);

    await runServiceUpdate(null, 'web', 'api', [sibling]);
    const secondToastCount = (toast.error as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(secondToastCount).toBeGreaterThan(firstToastCount);
  });

  it('continues polling an observing sibling and surfaces it when it transitions to failed', async () => {
    const observingEntry = { serviceName: 'sibling', recoveryId: 'rec-sibling', healthGateId: 'gate-sibling', healthGateStatus: 'observing' as const, healthGateReason: null, healthGateFailureSource: null, expiresAt: Date.now() + 60_000 };
    const failedEntry = { serviceName: 'sibling', recoveryId: 'rec-sibling', healthGateId: 'gate-sibling', healthGateStatus: 'failed' as const, healthGateReason: 'timeout', healthGateFailureSource: 'primary' as const, expiresAt: Date.now() + 60_000 };

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
      vi.mocked(fetchStackRecoveries).mockResolvedValue([observingEntry]);

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

      vi.mocked(fetchStackRecoveries).mockResolvedValue([failedEntry]);
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

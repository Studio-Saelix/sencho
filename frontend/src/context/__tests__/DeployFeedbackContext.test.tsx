import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DeployFeedbackProvider, useDeployFeedback } from '../DeployFeedbackContext';
import { DEPLOY_FEEDBACK_KEY } from '@/hooks/use-deploy-feedback-enabled';

function wrapper({ children }: { children: ReactNode }) {
  return <DeployFeedbackProvider>{children}</DeployFeedbackProvider>;
}

describe('DeployFeedbackContext', () => {
  beforeEach(() => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'true');
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('releases the deploy when the progress stream fails before connecting', async () => {
    const { result } = renderHook(() => useDeployFeedback(), { wrapper });

    let deployRan = false;
    let outer: Promise<unknown> | undefined;
    await act(async () => {
      outer = result.current.runWithLog({ stackName: 'web', action: 'deploy' }, async (started) => {
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
      outer = result.current.runWithLog({ stackName: 'web', action: 'deploy' }, async (started) => {
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
        outer = result.current.runWithLog({ stackName: 'web', action: 'deploy' }, async (started) => {
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
      await result.current.runWithLog({ stackName: 'web', action: 'deploy' }, async (started) => {
        await started;
        deployRan = true;
        return { ok: true };
      });
    });

    expect(deployRan).toBe(true);
    expect(result.current.panelState.isOpen).toBe(false);
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
});

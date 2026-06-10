import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DeployFeedbackProvider, useDeployFeedback } from '@/context/DeployFeedbackContext';
import { DeployFeedbackModal } from '../DeployFeedbackModal';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

// Lets a test simulate a mid-stream drop (onReady then onError) so the panel
// reaches 'streaming' with progressUnavailable set.
const ctl = vi.hoisted(() => ({ drop: false }));

// The real Terminal mounts xterm + a WebSocket; mock it to a no-op that signals
// the stream connected on mount so the panel reaches the 'streaming' state.
vi.mock('@/components/Terminal', () => {
  const MockTerminal = ({ onReady, onError }: { onReady?: () => void; onError?: () => void }) => {
    React.useEffect(() => {
      onReady?.();
      if (ctl.drop) onError?.();
    }, [onReady, onError]);
    return null;
  };
  return { default: MockTerminal };
});

// Resolver for the in-flight operation, assigned inside the run callback (async,
// after render) so the test can leave it pending or settle it on demand.
let resolveRun: ((r: { ok: boolean; errorMessage?: string; healthGateId?: string | null }) => void) | null = null;
// The runWithLog promise itself, so a test can await full result propagation.
let runOuter: Promise<unknown> | null = null;

function Driver() {
  const { runWithLog } = useDeployFeedback();
  React.useEffect(() => {
    runOuter = runWithLog({ stackName: 'web', action: 'update' }, async (started) => {
      await started;
      return new Promise<{ ok: boolean; errorMessage?: string; healthGateId?: string | null }>((res) => { resolveRun = res; });
    });
  }, [runWithLog]);
  return null;
}

async function renderStreaming() {
  await act(async () => {
    render(
      <DeployFeedbackProvider>
        <Driver />
        <DeployFeedbackModal isMinimized={false} onMinimize={() => {}} />
      </DeployFeedbackProvider>,
    );
    // The mocked Terminal calls onReady on mount; flush the 50ms handshake.
    await vi.advanceTimersByTimeAsync(60);
  });
}

type GateStatus = 'observing' | 'passed' | 'failed' | 'unknown';

function routeGateApi(responses: Array<{ id: string; status: GateStatus; reason?: string | null }>) {
  let call = 0;
  vi.mocked(apiFetch).mockImplementation((url: string) => {
    if (!String(url).includes('/health-gate')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve(new Response(JSON.stringify({
      stack: 'web', id: r.id, status: r.status, trigger: 'update',
      reason: r.reason ?? null, windowSeconds: 90, startedAt: Date.now(), endedAt: null, containers: [],
    }), { status: 200 }));
  });
}

describe('DeployFeedbackModal health gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resolveRun = null;
    ctl.drop = false;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 200 }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function succeedWithGate(gateId: string | null) {
    await renderStreaming();
    // The Terminal onReady effect flushes at the end of renderStreaming's act,
    // scheduling the 50ms handshake timer after that act's advance already
    // ran; fire it here so the run reaches its resolver.
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(resolveRun).not.toBeNull();
    await act(async () => {
      resolveRun?.({ ok: true, healthGateId: gateId });
      await runOuter;
    });
  }

  it('shows the observing banner and suspends auto-close while the gate observes', async () => {
    routeGateApi([{ id: 'gate-1', status: 'observing' }]);
    await succeedWithGate('gate-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByTestId('health-gate-banner')).toHaveAttribute('data-status', 'observing');
    expect(screen.queryByText(/closes in/)).toBeNull();
    // Far past the normal 4s auto-close: the modal must still be open.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByTestId('deploy-feedback-modal')).toBeInTheDocument();
  });

  it('resumes the auto-close countdown once the gate passes', async () => {
    routeGateApi([{ id: 'gate-1', status: 'observing' }, { id: 'gate-1', status: 'passed' }]);
    await succeedWithGate('gate-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByTestId('health-gate-banner')).toHaveAttribute('data-status', 'observing');
    // The next 4s poll returns passed; the countdown then runs to auto-close.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(screen.getByTestId('health-gate-banner')).toHaveAttribute('data-status', 'passed');
    expect(screen.getByText(/closes in/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    // onPanelClose resets the panel (Radix may keep the dialog DOM mounted
    // briefly under fake timers, so assert on the reset, not the unmount).
    expect(screen.queryByText('Succeeded')).toBeNull();
    expect(screen.queryByTestId('health-gate-banner')).toBeNull();
  });

  it('keeps the modal open and shows the reason when the gate fails', async () => {
    routeGateApi([{ id: 'gate-1', status: 'failed', reason: 'container web-app-1 exited during observation' }]);
    await succeedWithGate('gate-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByTestId('health-gate-banner')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByText(/exited during observation/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByTestId('deploy-feedback-modal')).toBeInTheDocument();
  });

  it('gives up with an unknown verdict after repeated poll failures', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (String(url).includes('/health-gate')) {
        return Promise.resolve(new Response('{"error":"boom"}', { status: 500 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    await succeedWithGate('gate-1');
    // Four strikes at the 4s poll cadence flip the gate to a client-side
    // unknown and stop the interval (gateHoldsOpen keeps the modal up).
    await act(async () => { await vi.advanceTimersByTimeAsync(17_000); });
    expect(screen.getByTestId('health-gate-banner')).toHaveAttribute('data-status', 'unknown');
    expect(screen.getByText(/could not be retrieved/)).toBeInTheDocument();
    const callsAfterGiveUp = vi.mocked(apiFetch).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(callsAfterGiveUp);
  });

  it('ignores a report for a different gate id', async () => {
    routeGateApi([{ id: 'some-other-gate', status: 'failed', reason: 'stale' }]);
    await succeedWithGate('gate-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    // The mismatched report never replaces the optimistic observing state.
    expect(screen.getByTestId('health-gate-banner')).toHaveAttribute('data-status', 'observing');
  });

  it('renders no gate banner and auto-closes normally without a healthGateId', async () => {
    await succeedWithGate(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText(/closes in/)).toBeInTheDocument();
    expect(screen.queryByTestId('health-gate-banner')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    // onPanelClose resets the panel (Radix may keep the dialog DOM mounted
    // briefly under fake timers, so assert on the reset, not the unmount).
    expect(screen.queryByText('Succeeded')).toBeNull();
  });
});

describe('DeployFeedbackModal stalled-output warning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resolveRun = null;
    ctl.drop = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns after the stall threshold when streaming produces no output', async () => {
    await renderStreaming();

    // Well under the threshold: no warning yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByTestId('deploy-feedback-stalled')).toBeNull();

    // Past the threshold with zero output: the warning appears.
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(screen.getByTestId('deploy-feedback-stalled')).toBeInTheDocument();
    expect(screen.getByText(/No output received yet/)).toBeInTheDocument();
  });

  it('clears the stall warning once the operation fails', async () => {
    await renderStreaming();
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(screen.getByTestId('deploy-feedback-stalled')).toBeInTheDocument();

    // The operation finishes as a failure; status leaves 'streaming' so the
    // stall warning must clear rather than sit next to the failed state.
    await act(async () => {
      resolveRun?.({ ok: false, errorMessage: 'boom' });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('deploy-feedback-stalled')).toBeNull();
  });

  it('suppresses the stall warning when the progress stream is unavailable', async () => {
    ctl.drop = true; // the stream connects then immediately drops mid-operation
    await renderStreaming();
    // Past the threshold, but with the stream gone the warning would be noise.
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(screen.queryByTestId('deploy-feedback-stalled')).toBeNull();
  });
});

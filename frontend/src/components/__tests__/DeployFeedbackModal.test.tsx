import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DeployFeedbackProvider, useDeployFeedback } from '@/context/DeployFeedbackContext';
import { DeployFeedbackModal } from '../DeployFeedbackModal';

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
let resolveRun: ((r: { ok: boolean; errorMessage?: string }) => void) | null = null;

function Driver() {
  const { runWithLog } = useDeployFeedback();
  React.useEffect(() => {
    void runWithLog({ stackName: 'web', action: 'update' }, async (started) => {
      await started;
      return new Promise<{ ok: boolean; errorMessage?: string }>((res) => { resolveRun = res; });
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

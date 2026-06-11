import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePanelSessionStartedAt } from '../usePanelSessionStartedAt';
import type { DeployPanelState } from '@/context/DeployFeedbackContext';

function panel(over: Partial<DeployPanelState> = {}): DeployPanelState {
  return {
    isOpen: false,
    stackName: '',
    nodeId: null,
    action: 'deploy',
    status: 'preparing',
    progressUnavailable: false,
    deploySessionId: '',
    sessionId: 0,
    ...over,
  };
}

describe('usePanelSessionStartedAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null while the panel is closed', () => {
    const { result } = renderHook((p: DeployPanelState) => usePanelSessionStartedAt(p), {
      initialProps: panel(),
    });
    expect(result.current).toBeNull();
  });

  it('captures Date.now() when the panel opens', () => {
    const { result, rerender } = renderHook((p: DeployPanelState) => usePanelSessionStartedAt(p), {
      initialProps: panel(),
    });
    expect(result.current).toBeNull();
    const opened = Date.now();
    rerender(panel({ isOpen: true, stackName: 'web', sessionId: 1 }));
    expect(result.current).toBe(opened);
  });

  it('resets the timestamp when sessionId changes even if isOpen stays true (same stack rerun)', () => {
    const { result, rerender } = renderHook((p: DeployPanelState) => usePanelSessionStartedAt(p), {
      initialProps: panel({ isOpen: true, stackName: 'web', sessionId: 1 }),
    });
    const first = result.current;
    expect(first).not.toBeNull();

    // Status flows to succeeded but the panel stays visible.
    rerender(panel({ isOpen: true, stackName: 'web', status: 'succeeded', sessionId: 1 }));
    expect(result.current).toBe(first);

    // Advance the clock and trigger a same-stack rerun under a new sessionId.
    vi.advanceTimersByTime(5_000);
    rerender(panel({ isOpen: true, stackName: 'web', status: 'preparing', sessionId: 2 }));

    expect(result.current).not.toBe(first);
    expect(result.current).toBe((first ?? 0) + 5_000);
  });

  it('does not flap when the same panel session re-renders with no changes', () => {
    const { result, rerender } = renderHook((p: DeployPanelState) => usePanelSessionStartedAt(p), {
      initialProps: panel({ isOpen: true, stackName: 'web', sessionId: 1 }),
    });
    const captured = result.current;

    vi.advanceTimersByTime(10_000);
    rerender(panel({ isOpen: true, stackName: 'web', sessionId: 1, status: 'streaming' }));
    expect(result.current).toBe(captured);
  });

  it('clears the timestamp when the panel closes', () => {
    const { result, rerender } = renderHook((p: DeployPanelState) => usePanelSessionStartedAt(p), {
      initialProps: panel({ isOpen: true, stackName: 'web', sessionId: 1 }),
    });
    expect(result.current).not.toBeNull();
    rerender(panel({ isOpen: false, sessionId: 1 }));
    expect(result.current).toBeNull();
  });
});

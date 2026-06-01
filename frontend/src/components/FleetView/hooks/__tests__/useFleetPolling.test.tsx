import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useFleetPolling } from '../useFleetPolling';
import type { NodeUpdateStatus } from '../../types';

function updating(status: NodeUpdateStatus['updateStatus']): NodeUpdateStatus[] {
  return [{ nodeId: 1, name: 'n', type: 'remote', version: '1', latestVersion: '1', updateAvailable: false, updateStatus: status }];
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('useFleetPolling', () => {
  it('fetches both endpoints once on mount', () => {
    const fetchOverview = vi.fn();
    const fetchUpdateStatus = vi.fn();
    renderHook(() => useFleetPolling({ fetchOverview, fetchUpdateStatus, updateStatuses: [] }));
    expect(fetchOverview).toHaveBeenCalledTimes(1);
    expect(fetchUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it('polls overview every 30s and update-status every 2m at baseline', () => {
    const fetchOverview = vi.fn();
    const fetchUpdateStatus = vi.fn();
    renderHook(() => useFleetPolling({ fetchOverview, fetchUpdateStatus, updateStatuses: [] }));
    fetchOverview.mockClear();
    fetchUpdateStatus.mockClear();

    // 90s -> overview fires 3 times, update-status 0 times (120s interval, no fast poll since not updating).
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(fetchOverview).toHaveBeenCalledTimes(3);
    expect(fetchUpdateStatus).toHaveBeenCalledTimes(0);

    // Reaching 120s total fires the update-status baseline.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(fetchUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it('fast-polls both endpoints every 5s while a node is updating', () => {
    const fetchOverview = vi.fn();
    const fetchUpdateStatus = vi.fn();
    const { rerender } = renderHook(
      ({ statuses }) => useFleetPolling({ fetchOverview, fetchUpdateStatus, updateStatuses: statuses }),
      { initialProps: { statuses: updating(null) } },
    );

    // No fast poll while nothing is updating.
    act(() => { vi.advanceTimersByTime(5_000); });

    // Flip a node to 'updating' -> the 5s tick now drives both fetchers.
    rerender({ statuses: updating('updating') });
    fetchOverview.mockClear();
    fetchUpdateStatus.mockClear();
    act(() => { vi.advanceTimersByTime(5_000); });

    expect(fetchOverview).toHaveBeenCalled();
    expect(fetchUpdateStatus).toHaveBeenCalled();
  });

  it('clears all intervals on unmount', () => {
    const fetchOverview = vi.fn();
    const fetchUpdateStatus = vi.fn();
    const { unmount } = renderHook(() => useFleetPolling({ fetchOverview, fetchUpdateStatus, updateStatuses: updating('updating') }));
    fetchOverview.mockClear();
    fetchUpdateStatus.mockClear();
    unmount();
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(fetchOverview).not.toHaveBeenCalled();
    expect(fetchUpdateStatus).not.toHaveBeenCalled();
  });
});

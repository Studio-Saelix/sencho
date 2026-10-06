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

  describe('visibility', () => {
    let hidden = false;
    let spy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      hidden = false;
      spy = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    });
    afterEach(() => spy.mockRestore());

    function mount() {
      const fetchOverview = vi.fn();
      const fetchUpdateStatus = vi.fn();
      const hook = renderHook(() => useFleetPolling({ fetchOverview, fetchUpdateStatus, updateStatuses: [] }));
      fetchOverview.mockClear();
      fetchUpdateStatus.mockClear();
      return { fetchOverview, fetchUpdateStatus, ...hook };
    }
    const show = () => act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });

    it('skips poll ticks while hidden and catches up both fetchers when it returns after a long hide', () => {
      const { fetchOverview, fetchUpdateStatus } = mount();
      hidden = true;
      act(() => { vi.advanceTimersByTime(120_000); });
      expect(fetchOverview).not.toHaveBeenCalled();
      expect(fetchUpdateStatus).not.toHaveBeenCalled();

      show();
      expect(fetchOverview).toHaveBeenCalledTimes(1);
      expect(fetchUpdateStatus).toHaveBeenCalledTimes(1);
    });

    it('refreshes only the overview after a hide that outlasted its period but not the update period', () => {
      const { fetchOverview, fetchUpdateStatus } = mount();
      hidden = true;
      act(() => { vi.advanceTimersByTime(60_000); });
      show();
      expect(fetchOverview).toHaveBeenCalledTimes(1);
      expect(fetchUpdateStatus).not.toHaveBeenCalled();
    });

    it('does not refetch on a short hide and return', () => {
      const { fetchOverview, fetchUpdateStatus } = mount();
      act(() => { vi.advanceTimersByTime(20_000); });
      hidden = true;
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      show();
      expect(fetchOverview).not.toHaveBeenCalled();
      expect(fetchUpdateStatus).not.toHaveBeenCalled();
    });

    it('treats a return just short of the period as fresh and lets the next tick fetch', () => {
      const { fetchOverview } = mount();
      hidden = true;
      act(() => { vi.advanceTimersByTime(29_000); });
      // Returning at 29s is not yet stale, so nothing is fetched on return.
      show();
      expect(fetchOverview).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(fetchOverview).toHaveBeenCalledTimes(1);

      // Hide until the period has passed, return (fetch), and let the next tick land 1s later.
      hidden = true;
      act(() => { vi.advanceTimersByTime(29_000); });
      show();
      expect(fetchOverview).toHaveBeenCalledTimes(1);
    });

    it('skips the fast poll while hidden', () => {
      const fetchOverview = vi.fn();
      const fetchUpdateStatus = vi.fn();
      renderHook(() => useFleetPolling({ fetchOverview, fetchUpdateStatus, updateStatuses: updating('updating') }));
      fetchOverview.mockClear();
      fetchUpdateStatus.mockClear();
      hidden = true;
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(fetchOverview).not.toHaveBeenCalled();
      expect(fetchUpdateStatus).not.toHaveBeenCalled();
    });

    it('removes its visibility listener on unmount', () => {
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      const { unmount } = mount();
      unmount();
      expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      removeSpy.mockRestore();
    });
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { DURATION_BASE_MS, useVisualBusy } from '../useVisualBusy';

describe('useVisualBusy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not show busy while not pending', () => {
    const { result } = renderHook(() => useVisualBusy(false));
    expect(result.current.locked).toBe(false);
    expect(result.current.showBusy).toBe(false);
  });

  it('never shows busy if pending ends before the delay', () => {
    const { result, rerender } = renderHook(
      ({ pending }) => useVisualBusy(pending),
      { initialProps: { pending: true } },
    );
    expect(result.current.locked).toBe(true);
    expect(result.current.showBusy).toBe(false);

    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS - 1);
    });
    expect(result.current.showBusy).toBe(false);

    rerender({ pending: false });
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    expect(result.current.locked).toBe(false);
    expect(result.current.showBusy).toBe(false);
  });

  it('shows busy after continuous pending through the delay', () => {
    const { result } = renderHook(() => useVisualBusy(true));
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    expect(result.current.locked).toBe(true);
    expect(result.current.showBusy).toBe(true);
  });

  it('clears showBusy when pending becomes false', () => {
    const { result, rerender } = renderHook(
      ({ pending }) => useVisualBusy(pending),
      { initialProps: { pending: true } },
    );
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    expect(result.current.showBusy).toBe(true);

    rerender({ pending: false });
    expect(result.current.showBusy).toBe(false);
  });

  it('does not update state after unmount mid-delay', () => {
    const { unmount } = renderHook(() => useVisualBusy(true));
    unmount();
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(DURATION_BASE_MS);
      });
    }).not.toThrow();
  });

  it('restarts the delay on rapid pending toggles', () => {
    const { result, rerender } = renderHook(
      ({ pending }) => useVisualBusy(pending),
      { initialProps: { pending: true } },
    );

    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS - 50);
    });
    expect(result.current.showBusy).toBe(false);

    rerender({ pending: false });
    rerender({ pending: true });

    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS - 50);
    });
    expect(result.current.showBusy).toBe(false);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.showBusy).toBe(true);
  });
});

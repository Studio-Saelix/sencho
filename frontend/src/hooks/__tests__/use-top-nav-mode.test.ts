import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTopNavMode, TOP_NAV_MODE_KEY, parseTopNavMode } from '../use-top-nav-mode';

describe('useTopNavMode', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to compact when no value is stored', () => {
    const { result } = renderHook(() => useTopNavMode());
    expect(result.current[0]).toBe('compact');
  });

  it('falls back to compact for invalid storage', () => {
    expect(parseTopNavMode('nope')).toBe('compact');
    localStorage.setItem(TOP_NAV_MODE_KEY, 'nope');
    const { result } = renderHook(() => useTopNavMode());
    expect(result.current[0]).toBe('compact');
  });

  it('migrates a legacy classic value to compact', () => {
    expect(parseTopNavMode('classic')).toBe('compact');
    localStorage.setItem(TOP_NAV_MODE_KEY, 'classic');
    const { result } = renderHook(() => useTopNavMode());
    expect(result.current[0]).toBe('compact');
  });

  it('reads each valid stored mode', () => {
    for (const mode of ['smart', 'compact'] as const) {
      localStorage.setItem(TOP_NAV_MODE_KEY, mode);
      const { result, unmount } = renderHook(() => useTopNavMode());
      expect(result.current[0]).toBe(mode);
      unmount();
    }
  });

  it('resolves to compact when localStorage access throws', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    try {
      const { result } = renderHook(() => useTopNavMode());
      expect(result.current[0]).toBe('compact');
    } finally {
      spy.mockRestore();
    }
  });

  it('persists mode changes and syncs same-tab listeners', () => {
    const a = renderHook(() => useTopNavMode());
    const b = renderHook(() => useTopNavMode());
    act(() => a.result.current[1]('smart'));
    expect(a.result.current[0]).toBe('smart');
    expect(b.result.current[0]).toBe('smart');
    expect(localStorage.getItem(TOP_NAV_MODE_KEY)).toBe('smart');
  });
});

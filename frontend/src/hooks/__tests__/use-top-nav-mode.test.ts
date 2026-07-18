import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTopNavMode, TOP_NAV_MODE_KEY, parseTopNavMode } from '../use-top-nav-mode';

describe('useTopNavMode', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to smart when no value is stored', () => {
    const { result } = renderHook(() => useTopNavMode());
    expect(result.current[0]).toBe('smart');
  });

  it('falls back to smart for invalid storage', () => {
    expect(parseTopNavMode('nope')).toBe('smart');
    localStorage.setItem(TOP_NAV_MODE_KEY, 'nope');
    const { result } = renderHook(() => useTopNavMode());
    expect(result.current[0]).toBe('smart');
  });

  it('reads each valid stored mode', () => {
    for (const mode of ['classic', 'smart', 'compact'] as const) {
      localStorage.setItem(TOP_NAV_MODE_KEY, mode);
      const { result, unmount } = renderHook(() => useTopNavMode());
      expect(result.current[0]).toBe(mode);
      unmount();
    }
  });

  it('persists mode changes and syncs same-tab listeners', () => {
    const a = renderHook(() => useTopNavMode());
    const b = renderHook(() => useTopNavMode());
    act(() => a.result.current[1]('compact'));
    expect(a.result.current[0]).toBe('compact');
    expect(b.result.current[0]).toBe('compact');
    expect(localStorage.getItem(TOP_NAV_MODE_KEY)).toBe('compact');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTopNavAlign, TOP_NAV_ALIGN_KEY } from '../use-top-nav-align';

describe('useTopNavAlign (left default)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to left when no value is stored', () => {
    const { result } = renderHook(() => useTopNavAlign());
    expect(result.current[0]).toBe('left');
  });

  it('reads center only when explicitly set to center', () => {
    localStorage.setItem(TOP_NAV_ALIGN_KEY, 'center');
    const { result } = renderHook(() => useTopNavAlign());
    expect(result.current[0]).toBe('center');
  });

  it('treats any unknown value as left', () => {
    localStorage.setItem(TOP_NAV_ALIGN_KEY, 'something-else');
    const { result } = renderHook(() => useTopNavAlign());
    expect(result.current[0]).toBe('left');
  });

  it('setAlign persists and switches', () => {
    const { result } = renderHook(() => useTopNavAlign());
    act(() => result.current[1]('center'));
    expect(result.current[0]).toBe('center');
    expect(localStorage.getItem(TOP_NAV_ALIGN_KEY)).toBe('center');
    act(() => result.current[1]('left'));
    expect(result.current[0]).toBe('left');
  });

  it('reacts to a storage event from another tab', () => {
    const { result } = renderHook(() => useTopNavAlign());
    expect(result.current[0]).toBe('left');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: TOP_NAV_ALIGN_KEY, newValue: 'center' }));
    });
    expect(result.current[0]).toBe('center');
  });

  it('syncs a second hook in the same tab via the settings-changed event', () => {
    const a = renderHook(() => useTopNavAlign());
    const b = renderHook(() => useTopNavAlign());
    act(() => a.result.current[1]('center'));
    expect(b.result.current[0]).toBe('center');
  });
});

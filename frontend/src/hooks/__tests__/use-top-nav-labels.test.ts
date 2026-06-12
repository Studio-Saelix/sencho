import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTopNavLabels, TOP_NAV_LABELS_KEY } from '../use-top-nav-labels';

describe('useTopNavLabels (opt-out default)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to showing labels when no value is stored', () => {
    const { result } = renderHook(() => useTopNavLabels());
    expect(result.current[0]).toBe(true);
  });

  it('hides labels only when explicitly set to false', () => {
    localStorage.setItem(TOP_NAV_LABELS_KEY, 'false');
    const { result } = renderHook(() => useTopNavLabels());
    expect(result.current[0]).toBe(false);
  });

  it('treats any non-false value as labels-on', () => {
    localStorage.setItem(TOP_NAV_LABELS_KEY, 'true');
    const { result } = renderHook(() => useTopNavLabels());
    expect(result.current[0]).toBe(true);
  });

  it('restores labels when a storage event clears the key (newValue null)', () => {
    localStorage.setItem(TOP_NAV_LABELS_KEY, 'false');
    const { result } = renderHook(() => useTopNavLabels());
    expect(result.current[0]).toBe(false);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: TOP_NAV_LABELS_KEY, newValue: null }));
    });
    expect(result.current[0]).toBe(true);
  });

  it('setShowLabels(false) persists false and hides labels', () => {
    const { result } = renderHook(() => useTopNavLabels());
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(TOP_NAV_LABELS_KEY)).toBe('false');
  });

  it('syncs a second hook in the same tab via the settings-changed event', () => {
    const a = renderHook(() => useTopNavLabels());
    const b = renderHook(() => useTopNavLabels());
    act(() => a.result.current[1](false));
    expect(b.result.current[0]).toBe(false);
  });
});

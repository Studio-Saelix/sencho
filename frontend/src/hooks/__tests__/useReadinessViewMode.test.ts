import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReadinessViewMode } from '../useReadinessViewMode';

const KEY = 'sencho-readiness-view';

describe('useReadinessViewMode', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults to the table view', () => {
    const { result } = renderHook(() => useReadinessViewMode());
    expect(result.current.mode).toBe('table');
  });

  it('restores a stored cards preference', () => {
    localStorage.setItem(KEY, 'cards');
    const { result } = renderHook(() => useReadinessViewMode());
    expect(result.current.mode).toBe('cards');
  });

  it('persists a change and keeps it across remounts', () => {
    const first = renderHook(() => useReadinessViewMode());
    act(() => first.result.current.setMode('cards'));
    expect(first.result.current.mode).toBe('cards');
    expect(localStorage.getItem(KEY)).toBe('cards');
    first.unmount();

    const second = renderHook(() => useReadinessViewMode());
    expect(second.result.current.mode).toBe('cards');
  });

  it('falls back to the table view for an unrecognised stored value', () => {
    localStorage.setItem(KEY, 'grid');
    const { result } = renderHook(() => useReadinessViewMode());
    expect(result.current.mode).toBe('table');
  });

  it('still switches the view when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => useReadinessViewMode());
    expect(result.current.mode).toBe('table');
    act(() => result.current.setMode('cards'));
    expect(result.current.mode).toBe('cards');
  });
});

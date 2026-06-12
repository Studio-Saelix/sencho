import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useFleetPreferences } from '../useFleetPreferences';

const PREFS_KEY = 'sencho-fleet-preferences';

beforeEach(() => localStorage.clear());
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('useFleetPreferences', () => {
  it('starts from defaults when nothing is stored', () => {
    const { result } = renderHook(() => useFleetPreferences());
    expect(result.current.prefs).toEqual({
      sortBy: 'name', sortDir: 'asc', filterStatus: 'all', filterType: 'all', filterCritical: false, filterNetworking: 'all',
    });
  });

  it('persists updates to localStorage', () => {
    const { result } = renderHook(() => useFleetPreferences());
    act(() => result.current.updatePrefs({ sortBy: 'cpu', sortDir: 'desc' }));

    expect(result.current.prefs.sortBy).toBe('cpu');
    expect(result.current.prefs.sortDir).toBe('desc');
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    expect(stored.sortBy).toBe('cpu');
    expect(stored.sortDir).toBe('desc');
  });

  it('merges stored prefs over defaults on mount', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ filterStatus: 'online' }));
    const { result } = renderHook(() => useFleetPreferences());
    expect(result.current.prefs.filterStatus).toBe('online');
    // Unspecified fields fall back to defaults.
    expect(result.current.prefs.sortBy).toBe('name');
  });

  it('falls back to defaults when stored JSON is corrupt', () => {
    localStorage.setItem(PREFS_KEY, '{ not json');
    const { result } = renderHook(() => useFleetPreferences());
    expect(result.current.prefs.sortBy).toBe('name');
  });
});

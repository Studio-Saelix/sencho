import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  RECENT_ALERTS_SCOPE_KEY,
  parseRecentAlertsScopePreference,
  useRecentAlertsScopePreference,
} from '../useRecentAlertsScopePreference';

describe('parseRecentAlertsScopePreference', () => {
  it('accepts this-node and all-nodes', () => {
    expect(parseRecentAlertsScopePreference('this-node')).toBe('this-node');
    expect(parseRecentAlertsScopePreference('all-nodes')).toBe('all-nodes');
  });

  it('falls back to this-node for missing or invalid values', () => {
    expect(parseRecentAlertsScopePreference(null)).toBe('this-node');
    expect(parseRecentAlertsScopePreference('fleet')).toBe('this-node');
  });
});

describe('useRecentAlertsScopePreference', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to this-node when nothing is stored', () => {
    const { result } = renderHook(() => useRecentAlertsScopePreference());
    expect(result.current[0]).toBe('this-node');
  });

  it('restores all-nodes from storage after a remount under another active node', () => {
    // The scope is a stored preference with no tie to the active node: the hook
    // takes no node argument and reads storage once on mount, so remounting
    // under a different active node still restores what was chosen.
    const first = renderHook(() => useRecentAlertsScopePreference());
    act(() => first.result.current[1]('all-nodes'));
    expect(window.localStorage.getItem(RECENT_ALERTS_SCOPE_KEY)).toBe('all-nodes');
    first.unmount();

    const second = renderHook(() => useRecentAlertsScopePreference());
    expect(second.result.current[0]).toBe('all-nodes');
  });

  it('survives an unavailable localStorage on read', () => {
    const getItem = window.localStorage.getItem;
    const setItem = window.localStorage.setItem;
    window.localStorage.getItem = () => { throw new Error('denied'); };
    window.localStorage.setItem = () => { throw new Error('denied'); };
    try {
      const { result } = renderHook(() => useRecentAlertsScopePreference());
      expect(result.current[0]).toBe('this-node');
      expect(() => act(() => result.current[1]('all-nodes'))).not.toThrow();
      expect(result.current[0]).toBe('all-nodes');
    } finally {
      window.localStorage.getItem = getItem;
      window.localStorage.setItem = setItem;
    }
  });
});

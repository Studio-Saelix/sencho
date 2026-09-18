import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  STACK_HEALTH_SCOPE_KEY,
  parseStackHealthScopePreference,
  useStackHealthScopePreference,
} from '../useStackHealthScopePreference';

describe('parseStackHealthScopePreference', () => {
  it('accepts this-node and all-nodes', () => {
    expect(parseStackHealthScopePreference('this-node')).toBe('this-node');
    expect(parseStackHealthScopePreference('all-nodes')).toBe('all-nodes');
  });

  it('falls back to this-node for missing or invalid values', () => {
    expect(parseStackHealthScopePreference(null)).toBe('this-node');
    expect(parseStackHealthScopePreference('fleet')).toBe('this-node');
  });
});

describe('useStackHealthScopePreference', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to this-node when nothing is stored', () => {
    const { result } = renderHook(() => useStackHealthScopePreference());
    expect(result.current[0]).toBe('this-node');
  });

  it('restores all-nodes from storage after a remount', () => {
    const first = renderHook(() => useStackHealthScopePreference());
    act(() => first.result.current[1]('all-nodes'));
    expect(window.localStorage.getItem(STACK_HEALTH_SCOPE_KEY)).toBe('all-nodes');
    first.unmount();

    const second = renderHook(() => useStackHealthScopePreference());
    expect(second.result.current[0]).toBe('all-nodes');
  });

  it('persists a return to this-node after all-nodes', () => {
    const first = renderHook(() => useStackHealthScopePreference());
    act(() => first.result.current[1]('all-nodes'));
    act(() => first.result.current[1]('this-node'));
    expect(window.localStorage.getItem(STACK_HEALTH_SCOPE_KEY)).toBe('this-node');
    first.unmount();

    const second = renderHook(() => useStackHealthScopePreference());
    expect(second.result.current[0]).toBe('this-node');
  });
});

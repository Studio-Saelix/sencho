import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { openGitOpsApplication } from '../portfolio/portfolioNavigation';
import { useGitOpsApplicationSelection } from './useGitOpsApplicationSelection';

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('useGitOpsApplicationSelection', () => {
  it('reads the open application from the URL on mount', () => {
    window.history.replaceState({}, '', '/nodes/local/gitops?application=bp%3A3');
    const { result } = renderHook(() => useGitOpsApplicationSelection());
    expect(result.current).toBe('bp:3');
  });

  it('follows an open without a popstate', () => {
    window.history.replaceState({}, '', '/nodes/local/gitops');
    const { result } = renderHook(() => useGitOpsApplicationSelection());
    act(() => openGitOpsApplication('1:x'));
    expect(result.current).toBe('1:x');
  });

  it('follows Back, which only fires popstate', () => {
    window.history.replaceState({}, '', '/nodes/local/gitops?application=1%3Ax');
    const { result } = renderHook(() => useGitOpsApplicationSelection());
    act(() => {
      window.history.replaceState(window.history.state, '', '/nodes/local/gitops?attention=1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeployFeedbackStyle, DEPLOY_FEEDBACK_STYLE_KEY } from '../use-deploy-feedback-style';

describe('useDeployFeedbackStyle (modal default)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to modal when no value is stored', () => {
    const { result } = renderHook(() => useDeployFeedbackStyle());
    expect(result.current[0]).toBe('modal');
  });

  it('reads inline only when explicitly set to inline', () => {
    localStorage.setItem(DEPLOY_FEEDBACK_STYLE_KEY, 'inline');
    const { result } = renderHook(() => useDeployFeedbackStyle());
    expect(result.current[0]).toBe('inline');
  });

  it('treats any unknown value as modal', () => {
    localStorage.setItem(DEPLOY_FEEDBACK_STYLE_KEY, 'something-else');
    const { result } = renderHook(() => useDeployFeedbackStyle());
    expect(result.current[0]).toBe('modal');
  });

  it('setStyle persists and switches', () => {
    const { result } = renderHook(() => useDeployFeedbackStyle());
    act(() => result.current[1]('inline'));
    expect(result.current[0]).toBe('inline');
    expect(localStorage.getItem(DEPLOY_FEEDBACK_STYLE_KEY)).toBe('inline');
    act(() => result.current[1]('modal'));
    expect(result.current[0]).toBe('modal');
  });

  it('reacts to a storage event from another tab', () => {
    const { result } = renderHook(() => useDeployFeedbackStyle());
    expect(result.current[0]).toBe('modal');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DEPLOY_FEEDBACK_STYLE_KEY, newValue: 'inline' }));
    });
    expect(result.current[0]).toBe('inline');
  });
});

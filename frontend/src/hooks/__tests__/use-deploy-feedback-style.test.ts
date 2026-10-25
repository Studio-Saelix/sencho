import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeployFeedbackStyle, DEPLOY_FEEDBACK_STYLE_KEY } from '../use-deploy-feedback-style';

describe('useDeployFeedbackStyle (inline default)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to inline when no value is stored', () => {
    const { result } = renderHook(() => useDeployFeedbackStyle());
    expect(result.current[0]).toBe('inline');
  });

  it('reads modal only when explicitly set to modal', () => {
    localStorage.setItem(DEPLOY_FEEDBACK_STYLE_KEY, 'modal');
    const { result } = renderHook(() => useDeployFeedbackStyle());
    expect(result.current[0]).toBe('modal');
  });

  it('treats any unknown value as inline', () => {
    localStorage.setItem(DEPLOY_FEEDBACK_STYLE_KEY, 'something-else');
    const { result } = renderHook(() => useDeployFeedbackStyle());
    expect(result.current[0]).toBe('inline');
  });

  it('setStyle persists and switches', () => {
    const { result } = renderHook(() => useDeployFeedbackStyle());
    act(() => result.current[1]('modal'));
    expect(result.current[0]).toBe('modal');
    expect(localStorage.getItem(DEPLOY_FEEDBACK_STYLE_KEY)).toBe('modal');
    act(() => result.current[1]('inline'));
    expect(result.current[0]).toBe('inline');
  });

  it('reacts to a storage event from another tab', () => {
    const { result } = renderHook(() => useDeployFeedbackStyle());
    expect(result.current[0]).toBe('inline');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DEPLOY_FEEDBACK_STYLE_KEY, newValue: 'modal' }));
    });
    expect(result.current[0]).toBe('modal');
  });
});

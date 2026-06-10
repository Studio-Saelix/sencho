import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeployFeedbackEnabled, DEPLOY_FEEDBACK_KEY } from '../use-deploy-feedback-enabled';

describe('useDeployFeedbackEnabled (opt-out default)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to enabled when no value is stored', () => {
    const { result } = renderHook(() => useDeployFeedbackEnabled());
    expect(result.current[0]).toBe(true);
  });

  it('is disabled only when explicitly set to false', () => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
    const { result } = renderHook(() => useDeployFeedbackEnabled());
    expect(result.current[0]).toBe(false);
  });

  it('treats any non-false value as enabled', () => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'true');
    const { result } = renderHook(() => useDeployFeedbackEnabled());
    expect(result.current[0]).toBe(true);
  });

  it('re-enables when a storage event clears the key (newValue null)', () => {
    localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
    const { result } = renderHook(() => useDeployFeedbackEnabled());
    expect(result.current[0]).toBe(false);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DEPLOY_FEEDBACK_KEY, newValue: null }));
    });
    expect(result.current[0]).toBe(true);
  });

  it('setEnabled(false) persists false and disables', () => {
    const { result } = renderHook(() => useDeployFeedbackEnabled());
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(DEPLOY_FEEDBACK_KEY)).toBe('false');
  });
});

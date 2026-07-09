import { describe, it, expect } from 'vitest';
import { shouldClearPendingDetailStack } from './mobile-pending-detail';

describe('shouldClearPendingDetailStack', () => {
  const base = {
    pendingDetailStack: 'radarr',
    detailReady: false,
    isFileLoading: false,
    stacksLoadStatus: 'success' as const,
    urlHydratingStack: null,
    routeDetailError: null,
  };

  it('returns false when there is no pending stack', () => {
    expect(shouldClearPendingDetailStack({ ...base, pendingDetailStack: null })).toBe(false);
  });

  it('does not clear while stacks are loading during URL hydration', () => {
    expect(shouldClearPendingDetailStack({
      ...base,
      stacksLoadStatus: 'loading',
      urlHydratingStack: 'radarr',
    })).toBe(false);
  });

  it('does not clear while a route detail error is shown', () => {
    expect(shouldClearPendingDetailStack({
      ...base,
      routeDetailError: 'Could not open stack',
    })).toBe(false);
  });

  it('clears when the detail surface is ready', () => {
    expect(shouldClearPendingDetailStack({ ...base, detailReady: true })).toBe(true);
  });

  it('does not clear while compose is still loading', () => {
    expect(shouldClearPendingDetailStack({ ...base, isFileLoading: true })).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { resolveCanSaveAndReapply } from '../resolveCanSaveAndReapply';

describe('resolveCanSaveAndReapply', () => {
  it('is true only when admin, node-eligible, and self-stack', () => {
    expect(resolveCanSaveAndReapply(true, true, true)).toBe(true);
  });

  it('is false for ordinary stacks even when admin and node-eligible', () => {
    expect(resolveCanSaveAndReapply(true, true, false)).toBe(false);
  });

  it('is false when not admin or not node-eligible', () => {
    expect(resolveCanSaveAndReapply(false, true, true)).toBe(false);
    expect(resolveCanSaveAndReapply(true, false, true)).toBe(false);
  });
});

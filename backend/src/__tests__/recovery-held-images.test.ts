/**
 * Unit tests for the unified held-image predicate's fail-closed composition:
 * a lookup failure on either underlying service must protect every image,
 * not just the ones the other service happens to hold.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildUnifiedHeldImagePredicate } from '../services/recoveryHeldImages';
import { StackUpdateRecoveryService } from '../services/StackUpdateRecoveryService';
import { ServiceUpdateRecoveryService } from '../services/ServiceUpdateRecoveryService';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildUnifiedHeldImagePredicate', () => {
  it('holds an image present in either service\'s held set', () => {
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set(['sha256:stack-held']));
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set(['sha256:service-held']));

    const predicate = buildUnifiedHeldImagePredicate(1);

    expect(predicate('sha256:stack-held')).toBe(true);
    expect(predicate('sha256:service-held')).toBe(true);
    expect(predicate('sha256:unrelated')).toBe(false);
  });

  it('fails closed (protects every image) when StackUpdateRecoveryService.getHeldImageIds returns null', () => {
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(null);
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());

    const predicate = buildUnifiedHeldImagePredicate(1);

    expect(predicate('sha256:anything')).toBe(true);
  });

  it('fails closed (protects every image) when ServiceUpdateRecoveryService.getHeldImageIds returns null', () => {
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(null);

    const predicate = buildUnifiedHeldImagePredicate(1);

    expect(predicate('sha256:anything')).toBe(true);
  });
});

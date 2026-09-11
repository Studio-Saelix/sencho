/**
 * Unit tests for the unified held-image predicate's fail-closed composition:
 * a lookup failure on either underlying service must protect every image,
 * not just the ones the other service happens to hold.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildUnifiedHeldImagePredicate, readHeldImageLookup } from '../services/recoveryHeldImages';
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

describe('readHeldImageLookup', () => {
  it('is known when both services return held sets', () => {
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set(['sha256:held']));

    const held = readHeldImageLookup(1);
    expect(held.unknown).toBe(false);
    if (!held.unknown) {
      expect(held.isHeld('sha256:held')).toBe(true);
      expect(held.isHeld('sha256:other')).toBe(false);
    }
  });

  it('is unknown when StackUpdateRecoveryService.getHeldImageIds returns null', () => {
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(null);
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());

    expect(readHeldImageLookup(1).unknown).toBe(true);
  });

  it('is unknown when ServiceUpdateRecoveryService.getHeldImageIds returns null', () => {
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(null);

    expect(readHeldImageLookup(1).unknown).toBe(true);
  });
});

/**
 * The prune routes (/system/prune/plan, /system/prune/system) build their
 * predicate via ServiceUpdateRecoveryService.buildHeldImagePredicate, not the
 * module function directly. That method delegates to the shared module, so a
 * full-stack rollback hold must gate prune too, not just service-scoped holds.
 */
describe('ServiceUpdateRecoveryService.buildHeldImagePredicate (the prune-path entry point)', () => {
  it('protects a full-stack rollback hold, not just service-scoped holds', () => {
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set(['sha256:stack-held']));
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());

    const predicate = ServiceUpdateRecoveryService.getInstance().buildHeldImagePredicate(1);

    expect(predicate('sha256:stack-held')).toBe(true);
    expect(predicate('sha256:unrelated')).toBe(false);
  });

  it('re-reads the held set on every call so a hold taken after plan time still gates the delete', () => {
    const stackSpy = vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());

    const predicate = ServiceUpdateRecoveryService.getInstance().buildHeldImagePredicate(1);
    expect(predicate('sha256:late-hold')).toBe(false);

    // A generation is captured between plan and delete.
    stackSpy.mockReturnValue(new Set(['sha256:late-hold']));
    expect(predicate('sha256:late-hold')).toBe(true);
  });

  it('fails closed on the prune path when a held lookup fails', () => {
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(null);
    vi.spyOn(ServiceUpdateRecoveryService.getInstance(), 'getHeldImageIds').mockReturnValue(new Set());

    const predicate = ServiceUpdateRecoveryService.getInstance().buildHeldImagePredicate(1);

    expect(predicate('sha256:anything')).toBe(true);
  });
});

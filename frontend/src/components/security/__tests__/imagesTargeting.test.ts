import { describe, it, expect } from 'vitest';
import {
  targetingFromTargets,
  primaryExposureIntentEvidence,
} from '../imagesTargeting';
import type { PostureTarget } from '@/types/security';

describe('targetingFromTargets', () => {
  it('derives unique imageRefs while keeping full targets', () => {
    const targets: PostureTarget[] = [
      { imageRef: 'a:1', stackName: 's1', serviceName: 'api', intentStatus: 'set', exposureIntent: 'public' },
      { imageRef: 'a:1', stackName: 's2', serviceName: 'api', intentStatus: 'unset' },
      { imageRef: 'b:1', intentStatus: 'set', exposureIntent: 'lan' },
    ];
    const input = targetingFromTargets('public_exposure', 'Network-exposed affected images', targets);
    expect(input?.imageRefs).toEqual(['a:1', 'b:1']);
    expect(input?.targets).toHaveLength(3);
  });

  it('returns undefined for empty targets', () => {
    expect(targetingFromTargets('public_exposure', 'x', [])).toBeUndefined();
    expect(targetingFromTargets('public_exposure', 'x', undefined)).toBeUndefined();
  });
});

describe('primaryExposureIntentEvidence', () => {
  it('formats public intent', () => {
    expect(primaryExposureIntentEvidence(
      [{ imageRef: 'a:1', intentStatus: 'set', exposureIntent: 'public' }],
      'a:1',
    )).toBe('Intent: public');
  });

  it('prefers mismatch over intentional', () => {
    expect(primaryExposureIntentEvidence(
      [
        { imageRef: 'a:1', intentStatus: 'set', exposureIntent: 'public' },
        { imageRef: 'a:1', intentStatus: 'set', exposureIntent: 'internal', intentConflict: true },
      ],
      'a:1',
    )).toBe('Intent mismatch: internal (+1)');
  });

  it('formats unset classification', () => {
    expect(primaryExposureIntentEvidence(
      [{ imageRef: 'a:1', intentStatus: 'unset' }],
      'a:1',
    )).toBe('Intent: not classified');
  });

  it('omits intent line when unavailable only', () => {
    expect(primaryExposureIntentEvidence(
      [{ imageRef: 'a:1', intentStatus: 'unavailable' }],
      'a:1',
    )).toBeNull();
  });

  it('handles legacy imageRef-only targets safely', () => {
    expect(primaryExposureIntentEvidence([{ imageRef: 'a:1' }], 'a:1')).toBeNull();
    expect(targetingFromTargets('fixable_cve', 'Newer image available', [{ imageRef: 'a:1' }])?.imageRefs)
      .toEqual(['a:1']);
  });

  it('does not flatten multi-intent same image to a single false intent', () => {
    const line = primaryExposureIntentEvidence(
      [
        { imageRef: 'a:1', intentStatus: 'set', exposureIntent: 'public' },
        { imageRef: 'a:1', intentStatus: 'unset' },
      ],
      'a:1',
    );
    expect(line).toBe('Intent: not classified (+1)');
    expect(line).not.toBe('Intent: public');
  });
});

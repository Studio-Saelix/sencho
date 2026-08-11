import { describe, it, expect } from 'vitest';
import {
  targetingFromTargets,
  primaryExposureIntentEvidence,
  standingIntentEvidence,
  intentionalBannerKind,
} from '../imagesTargeting';
import type { ImageExposureContext, PostureTarget, ScanSummary } from '@/types/security';

function summary(o: Partial<ScanSummary> & { image_ref?: string } = {}): ScanSummary {
  return {
    image_ref: 'nginx:1',
    highest_severity: null,
    scanned_at: 1,
    scan_id: 1,
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    fixable: 0,
    secret_count: 0,
    misconfig_count: 0,
    ...o,
  };
}

function ctx(partial: Partial<ImageExposureContext> & Pick<ImageExposureContext, 'stackName' | 'serviceName' | 'intentStatus'>): ImageExposureContext {
  return {
    exposureReason: 'published-port',
    ...partial,
  };
}

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

  it('accepts standing ImageExposureContext rows without imageRef', () => {
    expect(primaryExposureIntentEvidence([
      ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'set', exposureIntent: 'lan' }),
    ])).toBe('Intent: LAN');
  });
});

describe('standingIntentEvidence', () => {
  it('returns null for mixed-version publicly_exposed without contexts', () => {
    expect(standingIntentEvidence(summary({ publicly_exposed: true }))).toBeNull();
  });

  it('formats standing intent from contexts and summary flags', () => {
    expect(standingIntentEvidence(summary({
      publicly_exposed: true,
      exposure_contexts: [
        ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'set', exposureIntent: 'public' }),
      ],
      exposure_context_count: 1,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: false,
        hasUnavailable: false,
        allKnownIntentional: true,
      },
    }))).toBe('Intent: public');
  });

  it('prefers summary conflict over intentional display context', () => {
    expect(standingIntentEvidence(summary({
      publicly_exposed: true,
      exposure_contexts: [
        ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'set', exposureIntent: 'public' }),
      ],
      exposure_context_count: 2,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: true,
        hasUnclassified: false,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    }))).toBe('Intent mismatch: internal (+1)');
  });

  it('includes truncated remainder in +N', () => {
    expect(standingIntentEvidence(summary({
      publicly_exposed: true,
      exposure_contexts: [
        ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'unset' }),
      ],
      exposure_context_count: 5,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    }))).toBe('Intent: not classified (+4)');
  });
});

describe('intentionalBannerKind', () => {
  it('marks absolute intentional targets', () => {
    expect(intentionalBannerKind([
      { imageRef: 'a:1', intentStatus: 'set', exposureIntent: 'public' },
      { imageRef: 'a:1', intentStatus: 'set', exposureIntent: 'lan' },
    ])).toEqual({ kind: 'absolute', unavailableCount: 0 });
  });

  it('marks partial when unavailable remains among intentional contexts', () => {
    expect(intentionalBannerKind([
      { imageRef: 'a:1', intentStatus: 'set', exposureIntent: 'public' },
      { imageRef: 'a:1', intentStatus: 'unavailable' },
    ])).toEqual({ kind: 'partial', unavailableCount: 1 });
  });

  it('returns none for mixed-version summary without contexts', () => {
    expect(intentionalBannerKind(summary({ publicly_exposed: true }))).toEqual({
      kind: 'none',
      unavailableCount: 0,
    });
  });

  it('blocks absolute when truncated even if display contexts look intentional', () => {
    expect(intentionalBannerKind(summary({
      publicly_exposed: true,
      exposure_contexts: [
        ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'set', exposureIntent: 'public' }),
      ],
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: false,
        hasUnavailable: false,
        allKnownIntentional: true,
      },
    }))).toEqual({ kind: 'none', unavailableCount: 0 });
  });

  it('blocks absolute when posture targeting attach was truncated', () => {
    expect(intentionalBannerKind(
      [{ imageRef: 'a:1', intentStatus: 'set', exposureIntent: 'public' }],
      { truncated: true },
    )).toEqual({ kind: 'none', unavailableCount: 0 });
  });

  it('uses summary flags for partial standing intentional', () => {
    expect(intentionalBannerKind(summary({
      publicly_exposed: true,
      exposure_contexts: [
        ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'set', exposureIntent: 'public' }),
        ctx({ stackName: 'web', serviceName: 'worker', intentStatus: 'unavailable' }),
      ],
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: false,
        hasUnavailable: true,
        allKnownIntentional: true,
      },
    }))).toEqual({ kind: 'partial', unavailableCount: 1 });
  });
});

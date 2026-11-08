import { describe, it, expect } from 'vitest';
import {
  targetingFromTargets,
  primaryExposureIntentEvidence,
  standingIntentEvidence,
  intentionalBannerKind,
  afterIntentSaved,
  applySavedIntents,
  type ImagesTargetingState,
} from '../imagesTargeting';
import type { ServiceTunnelExposure } from '@/types/networking';
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

function unsetContext(stackName: string, serviceName: string): ImageExposureContext {
  return ctx({ stackName, serviceName, intentStatus: 'unset' });
}

function exposedSummary(
  imageRef: string,
  contexts: ImageExposureContext[],
  extra: Partial<ScanSummary> = {},
): ScanSummary {
  return summary({
    image_ref: imageRef,
    publicly_exposed: true,
    exposure_contexts: contexts,
    exposure_context_count: contexts.length,
    exposure_context_summary: {
      hasConflict: false,
      hasUnclassified: false,
      hasUnavailable: false,
      allKnownIntentional: false,
    },
    ...extra,
  });
}

describe('targetingFromTargets', () => {
  it('derives unique imageRefs while keeping full targets', () => {
    const targets: PostureTarget[] = [
      { imageRef: 'a:1', stackName: 's1', serviceName: 'api', intentStatus: 'set', exposureIntent: 'public' },
      { imageRef: 'a:1', stackName: 's2', serviceName: 'api', intentStatus: 'unset' },
      { imageRef: 'b:1', intentStatus: 'set', exposureIntent: 'lan' },
    ];
    const input = targetingFromTargets(
      'public_exposure',
      'Network-exposed images not yet classified',
      targets,
    );
    expect(input?.imageRefs).toEqual(['a:1', 'b:1']);
    expect(input?.targets).toHaveLength(3);
    expect(input?.drivers).toBeUndefined();
  });

  it('copies drivers when present', () => {
    const drivers = [
      { vulnerabilityId: 'CVE-2024-1', imageRef: 'web:1' },
      { vulnerabilityId: 'CVE-2024-1', imageRef: 'web:1' },
      { vulnerabilityId: 'CVE-2024-2', imageRef: 'web:1' },
    ];
    const input = targetingFromTargets(
      'elevated_exploit_risk',
      'Elevated exploit risk on network-exposed workload',
      [{ imageRef: 'web:1', intentStatus: 'set', exposureIntent: 'public' }],
      drivers,
    );
    expect(input?.drivers).toEqual(drivers);
  });

  it('copies driverCount and driversTruncated when provided', () => {
    const input = targetingFromTargets(
      'waiting_upstream',
      'Waiting for upstream image',
      [{ imageRef: 'app:1' }],
      [{ vulnerabilityId: 'CVE-1', imageRef: 'app:1' }],
      { driverCount: 12, driversTruncated: true },
    );
    expect(input?.driverCount).toBe(12);
    expect(input?.driversTruncated).toBe(true);
  });

  it('omits drivers when empty or absent', () => {
    const noDrivers = targetingFromTargets(
      'public_exposure',
      'Exposure conflicts with declared intent',
      [{ imageRef: 'a:1', intentConflict: true, intentStatus: 'set', exposureIntent: 'internal' }],
    );
    expect(noDrivers?.drivers).toBeUndefined();
    expect(
      targetingFromTargets('elevated_exploit_risk', 'x', [{ imageRef: 'a:1' }], [])
        ?.drivers,
    ).toBeUndefined();
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

  it('reports a hidden warning when a save settled every displayed context', () => {
    expect(standingIntentEvidence(summary({
      publicly_exposed: true,
      exposure_contexts: [],
      exposure_context_count: 21,
      exposure_context_summary: {
        hasConflict: true,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    }))).toBe('Intent mismatch: internal (+20)');
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

describe('afterIntentSaved', () => {
  const targeting = (kind: ImagesTargetingState['kind']): ImagesTargetingState => ({
    kind,
    label: 'reason',
    imageRefs: ['a:1', 'b:1'],
    targets: [
      { imageRef: 'a:1', stackName: 'web', serviceName: 'api', intentStatus: 'set', exposureIntent: 'internal', intentConflict: true },
      { imageRef: 'b:1', stackName: 'db', serviceName: 'pg', intentStatus: 'unset' },
    ],
    drivers: [{ vulnerabilityId: 'CVE-1', imageRef: 'a:1' }],
    driverCount: 1,
    token: 4,
  });

  it('keeps the exposure reason\'s images but sheds its snapshot and its conflict label', () => {
    const next = afterIntentSaved(targeting('public_exposure'));
    expect(next).toMatchObject({ kind: 'public_exposure', imageRefs: ['a:1', 'b:1'], label: 'Network exposed images', token: 4 });
    expect(next?.targets).toEqual([{ imageRef: 'a:1' }, { imageRef: 'b:1' }]);
  });

  it('keeps another reason with its label and drivers and sheds the per-service intent', () => {
    const next = afterIntentSaved(targeting('elevated_exploit_risk'));
    expect(next).toMatchObject({ kind: 'elevated_exploit_risk', label: 'reason', imageRefs: ['a:1', 'b:1'], driverCount: 1, token: 4 });
    expect(next?.drivers).toHaveLength(1);
    expect(next?.targets).toEqual([{ imageRef: 'a:1' }, { imageRef: 'b:1' }]);
  });

  it('leaves no targeting as none', () => {
    expect(afterIntentSaved(null)).toBeNull();
  });
});

describe('applySavedIntents', () => {
  it('adopts a saved service intent and clears the unclassified aggregate', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [unsetContext('web', 'api')], {
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: true,
          hasUnavailable: false,
          allKnownIntentional: false,
        },
      }),
    };

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'public' }]);

    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({
      intentStatus: 'set',
      exposureIntent: 'public',
    });
    expect(after['exp:1']?.exposure_context_summary).toEqual({
      hasConflict: false,
      hasUnclassified: false,
      hasUnavailable: false,
      allKnownIntentional: true,
    });
    expect(standingIntentEvidence(after['exp:1']!)).toBe('Intent: public');
  });

  it('carries a stack intent to another service and image that inherit it', () => {
    const before = {
      'web:1': exposedSummary('web:1', [unsetContext('web', 'api')]),
      'worker:1': exposedSummary('worker:1', [unsetContext('web', 'worker')]),
      'db:1': exposedSummary('db:1', [unsetContext('db', 'postgres')]),
    };

    const after = applySavedIntents(before, 'web', [{ service: '', intent: 'lan' }]);

    expect(after['web:1']?.exposure_contexts?.[0]).toMatchObject({ intentStatus: 'set', exposureIntent: 'lan' });
    expect(after['worker:1']?.exposure_contexts?.[0]).toMatchObject({ intentStatus: 'set', exposureIntent: 'lan' });
    expect(after['db:1']).toBe(before['db:1']);
    expect(standingIntentEvidence(after['worker:1']!)).toBe('Intent: LAN');
  });

  it('keeps a service override when the stack intent changes', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [unsetContext('web', 'api'), unsetContext('web', 'worker')]),
    };

    const after = applySavedIntents(before, 'web', [
      { service: '', intent: 'lan' },
      { service: 'api', intent: 'public' },
    ]);

    expect(after['exp:1']?.exposure_contexts).toEqual([
      expect.objectContaining({ serviceName: 'api', exposureIntent: 'public' }),
      expect.objectContaining({ serviceName: 'worker', exposureIntent: 'lan' }),
    ]);
  });

  it('returns a cleared service to the stack intent', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [
        ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'set', exposureIntent: 'public' }),
        ctx({ stackName: 'web', serviceName: 'worker', intentStatus: 'set', exposureIntent: 'internal', intentConflict: true }),
      ]),
    };

    // The response no longer carries a service row for api: it inherits the stack intent.
    const after = applySavedIntents(before, 'web', [{ service: '', intent: 'lan' }]);

    expect(after['exp:1']?.exposure_contexts).toEqual([
      expect.objectContaining({ serviceName: 'api', exposureIntent: 'lan', intentStatus: 'set' }),
      expect.objectContaining({ serviceName: 'worker', exposureIntent: 'lan', intentStatus: 'set' }),
    ]);
  });

  it('clears the stack to unclassified when its intent rows are gone', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [
        ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'set', exposureIntent: 'public' }),
        ctx({ stackName: 'web', serviceName: 'worker', intentStatus: 'unset' }),
      ]),
    };

    const cleared = applySavedIntents(before, 'web', []);

    expect(cleared['exp:1']?.exposure_contexts).toEqual([
      expect.objectContaining({ serviceName: 'api', intentStatus: 'unset' }),
      expect.objectContaining({ serviceName: 'worker', intentStatus: 'unset' }),
    ]);
    expect(standingIntentEvidence(cleared['exp:1']!)).toBe('Intent: not classified (+1)');
  });

  it('treats an unknown intent as unset', () => {
    const before = { 'exp:1': exposedSummary('exp:1', [unsetContext('web', 'api')]) };

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'unknown' }]);

    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({ intentStatus: 'unset' });
  });

  it('marks a conflicting intent and its aggregate', () => {
    const before = { 'exp:1': exposedSummary('exp:1', [unsetContext('web', 'api')]) };

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'internal' }]);

    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({
      intentStatus: 'set',
      exposureIntent: 'internal',
      intentConflict: true,
    });
    expect(after['exp:1']?.exposure_context_summary?.hasConflict).toBe(true);
    expect(standingIntentEvidence(after['exp:1']!)).toBe('Intent mismatch: internal');
  });

  it('leaves stacks the save did not touch alone', () => {
    const before = { 'exp:1': exposedSummary('exp:1', [unsetContext('db', 'postgres')]) };

    expect(applySavedIntents(before, 'web', [{ service: 'api', intent: 'public' }])).toBe(before);
  });

  it('keeps a warning a capped list cannot disprove', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [unsetContext('web', 'api')], {
        exposure_context_count: 3,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: true,
          hasUnavailable: false,
          allKnownIntentional: false,
        },
      }),
    };

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'public' }]);

    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({ intentStatus: 'set', exposureIntent: 'public' });
    // Hidden contexts may still be unclassified, so the aggregate stays truthful to them.
    expect(after['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
  });
});

function tunnelContext(
  provider: ServiceTunnelExposure['provider'],
  path: ServiceTunnelExposure['path'],
  serviceName = 'api',
): ImageExposureContext {
  return ctx({
    stackName: 'web',
    serviceName,
    exposureReason: 'tunnel',
    tunnel: {
      connector: 'edge',
      provider,
      scope: provider === 'cloudflared' ? 'public-edge' : 'private-overlay',
      path,
    },
    intentStatus: 'unset',
  });
}

function certainTunnelPath(provider: ServiceTunnelExposure['provider'], path: ServiceTunnelExposure['path']): boolean {
  return path === 'shared-namespace' && (provider === 'tailscale' || provider === 'wireguard');
}

describe('applySavedIntents tunnel settlement', () => {
  const PROVIDERS: ServiceTunnelExposure['provider'][] = ['cloudflared', 'tailscale', 'wireguard'];
  const PATHS: ServiceTunnelExposure['path'][] = ['shared-namespace', 'shared-network', 'host-network'];
  const INTENTS = ['internal', 'same-node'] as const;

  for (const provider of PROVIDERS) {
    for (const path of PATHS) {
      for (const intent of INTENTS) {
        const certain = certainTunnelPath(provider, path);
        it(`${certain ? 'keeps' : 'settles'} ${provider} ${path} under ${intent}`, () => {
          const before = {
            'exp:1': exposedSummary('exp:1', [tunnelContext(provider, path)], {
              exposure_context_summary: {
                hasConflict: false,
                hasUnclassified: true,
                hasUnavailable: false,
                allKnownIntentional: false,
              },
            }),
          };

          const after = applySavedIntents(before, 'web', [{ service: 'api', intent }]);
          const patched = after['exp:1']!;

          if (certain) {
            expect(patched.publicly_exposed).toBe(true);
            expect(patched.exposure_contexts).toHaveLength(1);
            expect(patched.exposure_contexts?.[0]).toMatchObject({
              exposureIntent: intent,
              intentStatus: 'set',
              intentConflict: true,
            });
            expect(standingIntentEvidence(patched)).toBe(`Intent mismatch: ${intent}`);
          } else {
            // The server takes an unverified tunnel reach at the operator's word:
            // the service stops counting as exposed instead of conflicting.
            expect(patched.publicly_exposed).toBe(false);
            expect(patched.exposure_contexts).toEqual([]);
            expect(patched.exposure_context_count).toBe(0);
            expect(standingIntentEvidence(patched)).toBeNull();
          }
        });
      }
    }
  }

  it('settles an unverified tunnel reach that inherits a stack intent', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [
        tunnelContext('cloudflared', 'shared-network', 'api'),
        tunnelContext('cloudflared', 'shared-network', 'worker'),
      ]),
    };

    const after = applySavedIntents(before, 'web', [{ service: '', intent: 'internal' }]);

    expect(after['exp:1']?.publicly_exposed).toBe(false);
    expect(after['exp:1']?.exposure_contexts).toEqual([]);
  });

  it('settles a service that clears its override back to a conflicting stack intent', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [
        ctx({
          stackName: 'web',
          serviceName: 'api',
          exposureReason: 'tunnel',
          tunnel: {
            connector: 'edge',
            provider: 'cloudflared',
            scope: 'public-edge',
            path: 'shared-namespace',
          },
          intentStatus: 'set',
          exposureIntent: 'public',
        }),
      ]),
    };

    // The save response has no service row: the service inherits the stack intent.
    const after = applySavedIntents(before, 'web', [{ service: '', intent: 'same-node' }]);

    expect(after['exp:1']?.publicly_exposed).toBe(false);
    expect(after['exp:1']?.exposure_contexts).toEqual([]);
  });

  it('settles only unverified reaches and keeps a certain tunnel path conflicting', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [
        tunnelContext('cloudflared', 'shared-network', 'api'),
        tunnelContext('tailscale', 'shared-namespace', 'worker'),
      ]),
    };

    const after = applySavedIntents(before, 'web', [{ service: '', intent: 'internal' }]);

    expect(after['exp:1']?.publicly_exposed).toBe(true);
    expect(after['exp:1']?.exposure_contexts).toHaveLength(1);
    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({
      serviceName: 'worker',
      exposureIntent: 'internal',
      intentConflict: true,
    });
  });

  it('keeps an explicit service override when the stack intent is restrictive', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [
        tunnelContext('cloudflared', 'shared-network', 'api'),
        tunnelContext('cloudflared', 'shared-network', 'worker'),
      ]),
    };

    const after = applySavedIntents(before, 'web', [
      { service: '', intent: 'internal' },
      { service: 'api', intent: 'public' },
    ]);

    expect(after['exp:1']?.publicly_exposed).toBe(true);
    expect(after['exp:1']?.exposure_contexts).toEqual([
      expect.objectContaining({ serviceName: 'api', exposureIntent: 'public' }),
    ]);
  });

  it('keeps an unverified tunnel reach exposed when the save leaves it unclassified', () => {
    const before = { 'exp:1': exposedSummary('exp:1', [tunnelContext('cloudflared', 'shared-network')]) };

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'unknown' }]);

    expect(after['exp:1']?.publicly_exposed).toBe(true);
    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({ intentStatus: 'unset' });
  });

  it('keeps a published port exposed and conflicting with a restrictive intent', () => {
    for (const intent of INTENTS) {
      const before = { 'exp:1': exposedSummary('exp:1', [unsetContext('web', 'api')]) };

      const after = applySavedIntents(before, 'web', [{ service: 'api', intent }]);

      expect(after['exp:1']?.publicly_exposed).toBe(true);
      expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({
        exposureIntent: intent,
        intentConflict: true,
      });
    }
  });

  it('keeps host-network exposure exposed and conflicting with a restrictive intent', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [
        ctx({ stackName: 'web', serviceName: 'api', exposureReason: 'host-network', intentStatus: 'unset' }),
      ]),
    };

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'internal' }]);

    expect(after['exp:1']?.publicly_exposed).toBe(true);
    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({ intentConflict: true });
  });

  it('keeps a capped row exposed when settled contexts leave a hidden remainder', () => {
    const visible = Array.from({ length: 20 }, (_, index) =>
      tunnelContext('cloudflared', 'shared-network', `svc${index}`));
    const before = {
      'exp:1': exposedSummary('exp:1', visible, {
        exposure_context_count: 21,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: true,
          hasUnavailable: false,
          allKnownIntentional: false,
        },
      }),
    };

    const after = applySavedIntents(before, 'web', [{ service: '', intent: 'internal' }]);
    const patched = after['exp:1']!;

    expect(patched.publicly_exposed).toBe(true);
    expect(patched.exposure_contexts).toEqual([]);
    expect(patched.exposure_context_count).toBe(1);
    expect(patched.exposure_contexts_truncated).toBe(true);
    expect(standingIntentEvidence(patched)).toBe('Intent: not classified');
  });
});

describe('applySavedIntents capped remainder across repeated saves', () => {
  function capped(
    contexts: ImageExposureContext[],
    extra: Partial<ScanSummary>,
  ): Record<string, ScanSummary> {
    return { 'exp:1': exposedSummary('exp:1', contexts, extra) };
  }

  it('keeps a hidden unclassified warning through twenty consecutive saves', () => {
    const visible = Array.from({ length: 20 }, (_, index) => unsetContext('web', `svc${index}`));
    let summaries = capped(visible, {
      exposure_context_count: 21,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    for (let index = 0; index < visible.length; index += 1) {
      summaries = applySavedIntents(summaries, 'web', [{ service: `svc${index}`, intent: 'public' }]);
    }

    expect(summaries['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(standingIntentEvidence(summaries['exp:1']!)).toBe('Intent: not classified (+20)');
  });

  it('keeps a hidden conflict warning through twenty consecutive saves', () => {
    const visible = Array.from({ length: 20 }, (_, index) =>
      ctx({
        stackName: 'web',
        serviceName: `svc${index}`,
        intentStatus: 'set',
        exposureIntent: 'internal',
        intentConflict: true,
      }));
    let summaries = capped(visible, {
      exposure_context_count: 21,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: true,
        hasUnclassified: false,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    for (let index = 0; index < visible.length; index += 1) {
      summaries = applySavedIntents(summaries, 'web', [{ service: `svc${index}`, intent: 'public' }]);
    }

    expect(summaries['exp:1']?.exposure_context_summary?.hasConflict).toBe(true);
    expect(standingIntentEvidence(summaries['exp:1']!)).toBe('Intent mismatch: internal (+20)');
  });

  it('keeps a hidden warning while saves span two visible stacks', () => {
    const visible = [
      ...Array.from({ length: 19 }, (_, index) => unsetContext('web', `svc${index}`)),
      ctx({
        stackName: 'db',
        serviceName: 'postgres',
        intentStatus: 'set',
        exposureIntent: 'internal',
        intentConflict: true,
      }),
    ];
    let summaries = capped(visible, {
      exposure_context_count: 21,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: true,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    for (let index = 0; index < 19; index += 1) {
      summaries = applySavedIntents(summaries, 'web', [{ service: `svc${index}`, intent: 'public' }]);
    }
    summaries = applySavedIntents(summaries, 'db', [{ service: 'postgres', intent: 'public' }]);

    // The visible conflict is resolved; the hidden unclassified context is not.
    expect(summaries['exp:1']?.exposure_context_summary?.hasConflict).toBe(false);
    expect(summaries['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(standingIntentEvidence(summaries['exp:1']!)).toBe('Intent: not classified (+20)');
  });

  it('treats a count beyond the attached list as truncation without the flag', () => {
    const before = capped([unsetContext('web', 'api')], {
      exposure_context_count: 2,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'public' }]);

    expect(after['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
  });

  it('treats the truncation flag as truncation without a count', () => {
    const before = capped([unsetContext('web', 'api')], {
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'public' }]);

    expect(after['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
  });

  it('drops a visible unavailable state once the visible ranks rule out a hidden one', () => {
    const before = capped([
      ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'unavailable' }),
      ctx({ stackName: 'web', serviceName: 'worker', intentStatus: 'set', exposureIntent: 'public' }),
    ], {
      exposure_context_count: 3,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: false,
        hasUnavailable: true,
        allKnownIntentional: true,
      },
    });

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'public' }]);

    // The last visible context ranks as set, so no hidden context can be unavailable.
    expect(after['exp:1']?.exposure_context_summary?.hasUnavailable).toBe(false);
  });
});

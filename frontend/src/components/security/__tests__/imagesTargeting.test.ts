import { describe, it, expect } from 'vitest';
import {
  targetingFromTargets,
  primaryExposureIntentEvidence,
  standingIntentEvidence,
  standingExposureContexts,
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

const CERTAIN_TUNNEL_PATHS = new Set([
  'tailscale:shared-namespace',
  'wireguard:shared-namespace',
]);

function certainTunnelPath(provider: ServiceTunnelExposure['provider'], path: ServiceTunnelExposure['path']): boolean {
  return CERTAIN_TUNNEL_PATHS.has(`${provider}:${path}`);
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

  it('keeps host-network exposure exposed and conflicting with either restrictive intent', () => {
    for (const intent of INTENTS) {
      const before = {
        'exp:1': exposedSummary('exp:1', [
          ctx({ stackName: 'web', serviceName: 'api', exposureReason: 'host-network', intentStatus: 'unset' }),
        ]),
      };

      const after = applySavedIntents(before, 'web', [{ service: 'api', intent }]);
      const patched = after['exp:1']!;

      expect(patched.publicly_exposed).toBe(true);
      expect(patched.exposure_contexts?.[0]).toMatchObject({
        exposureIntent: intent,
        intentStatus: 'set',
        intentConflict: true,
      });
      expect(standingIntentEvidence(patched)).toBe(`Intent mismatch: ${intent}`);
    }
  });

  it('keeps a tunnel-labelled context without path detail exposed and conflicting', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [
        ctx({ stackName: 'web', serviceName: 'api', exposureReason: 'tunnel', intentStatus: 'unset' }),
      ]),
    };

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'internal' }]);

    expect(after['exp:1']?.publicly_exposed).toBe(true);
    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({ intentConflict: true });
  });

  it('keeps an unverified tunnel reach exposed when the save leaves no intent', () => {
    const before = { 'exp:1': exposedSummary('exp:1', [tunnelContext('cloudflared', 'shared-network')]) };

    const after = applySavedIntents(before, 'web', []);

    expect(after['exp:1']?.publicly_exposed).toBe(true);
    expect(after['exp:1']?.exposure_contexts?.[0]).toMatchObject({ intentStatus: 'unset' });
  });

  it('adds the conflict a save proves about a context beyond the display slice', () => {
    const visible = Array.from({ length: 20 }, (_, index) => unsetContext('web', `svc${index}`));
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

    const after = applySavedIntents(before, 'web', [{ service: 'hidden', intent: 'internal' }], {
      imageRef: 'exp:1',
      context: {
        stackName: 'web',
        serviceName: 'hidden',
        exposureReason: 'published-port',
        intentStatus: 'unset',
      },
    });

    expect(after['exp:1']?.exposure_context_summary?.hasConflict).toBe(true);
    expect(standingIntentEvidence(after['exp:1']!)).toBe('Intent mismatch: internal (+20)');
  });

  it('clears the intentional aggregate when a hidden save adds a conflict', () => {
    const visible = Array.from({ length: 20 }, (_, index) =>
      ctx({ stackName: 'web', serviceName: `svc${index}`, intentStatus: 'set', exposureIntent: 'public' }));
    const before = {
      'exp:1': exposedSummary('exp:1', visible, {
        exposure_context_count: 21,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: false,
          hasUnavailable: false,
          allKnownIntentional: true,
        },
      }),
    };

    const after = applySavedIntents(before, 'web', [{ service: 'hidden', intent: 'internal' }], {
      imageRef: 'exp:1',
      context: {
        stackName: 'web',
        serviceName: 'hidden',
        exposureReason: 'published-port',
        intentStatus: 'set',
        exposureIntent: 'public',
      },
    });

    expect(after['exp:1']?.exposure_context_summary?.hasConflict).toBe(true);
    expect(after['exp:1']?.exposure_context_summary?.allKnownIntentional).toBe(false);
  });

  it('adds the unclassified state a save proves about a context beyond the display slice', () => {
    const visible = Array.from({ length: 20 }, (_, index) =>
      ctx({ stackName: 'web', serviceName: `svc${index}`, intentStatus: 'set', exposureIntent: 'public' }));
    const before = {
      'exp:1': exposedSummary('exp:1', visible, {
        exposure_context_count: 21,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: false,
          hasUnavailable: false,
          allKnownIntentional: true,
        },
      }),
    };

    const after = applySavedIntents(before, 'web', visible.map((_, index) => ({
      service: `svc${index}`,
      intent: 'public' as const,
    })), {
      imageRef: 'exp:1',
      context: {
        stackName: 'web',
        serviceName: 'hidden',
        exposureReason: 'published-port',
        intentStatus: 'set',
        exposureIntent: 'public',
      },
    });

    expect(after['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(standingIntentEvidence(after['exp:1']!)).toBe('Intent: not classified (+20)');
  });

  it('does not invent a conflict for a hidden unverified tunnel save', () => {
    const visible = Array.from({ length: 20 }, (_, index) => unsetContext('web', `svc${index}`));
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

    const after = applySavedIntents(before, 'web', [{ service: 'hidden', intent: 'internal' }], {
      imageRef: 'exp:1',
      context: {
        stackName: 'web',
        serviceName: 'hidden',
        exposureReason: 'tunnel',
        tunnel: {
          connector: 'edge',
          provider: 'cloudflared',
          scope: 'public-edge',
          path: 'shared-network',
        },
        intentStatus: 'unset',
      },
    });

    expect(after['exp:1']?.exposure_context_summary?.hasConflict).toBe(false);
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
  // The captured flags are may-hold: with 20 visible contexts and a 21st beyond
  // the cap, the server's ordering cannot name the hidden state, only the states
  // it may still hold. These cases assert that the may-hold evidence survives;
  // the test names describe the warning kept, not a pinned hidden state.
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

    // The PUT replies with the stack's complete intent set, so each save
    // accumulates rather than returning the other services to unset.
    const saved: Array<{ service: string; intent: 'public' }> = [];
    for (let index = 0; index < visible.length; index += 1) {
      saved.push({ service: `svc${index}`, intent: 'public' });
      summaries = applySavedIntents(summaries, 'web', saved);
    }

    expect(summaries['exp:1']?.exposure_contexts?.every((c) => c.intentStatus === 'set')).toBe(true);
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

    const saved: Array<{ service: string; intent: 'public' }> = [];
    for (let index = 0; index < visible.length; index += 1) {
      saved.push({ service: `svc${index}`, intent: 'public' });
      summaries = applySavedIntents(summaries, 'web', saved);
    }

    expect(summaries['exp:1']?.exposure_contexts?.every((c) => c.intentStatus === 'set')).toBe(true);
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

    const saved: Array<{ service: string; intent: 'public' }> = [];
    for (let index = 0; index < 19; index += 1) {
      saved.push({ service: `svc${index}`, intent: 'public' });
      summaries = applySavedIntents(summaries, 'web', saved);
    }
    summaries = applySavedIntents(summaries, 'db', [{ service: 'postgres', intent: 'public' }]);

    // The visible conflict is resolved; the hidden unclassified context may remain.
    expect(summaries['exp:1']?.exposure_contexts?.every((c) => c.intentStatus === 'set')).toBe(true);
    expect(summaries['exp:1']?.exposure_context_summary?.hasConflict).toBe(false);
    expect(summaries['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(standingIntentEvidence(summaries['exp:1']!)).toBe('Intent: not classified (+20)');
  });

  it('keeps a hidden warning when truncation comes only from the count', () => {
    let summaries = capped([unsetContext('web', 'api')], {
      exposure_context_count: 2,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    // A second save must keep the captured remainder, not re-derive it.
    summaries = applySavedIntents(summaries, 'web', [{ service: 'api', intent: 'public' }]);
    summaries = applySavedIntents(summaries, 'web', [{ service: 'api', intent: 'lan' }]);

    expect(summaries['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(summaries['exp:1']?.exposure_context_hidden?.unclassified).toBe(true);
    // The count-based cap signal is recorded so the two signals agree.
    expect(summaries['exp:1']?.exposure_contexts_truncated).toBe(true);
  });

  it('keeps a hidden warning when truncation comes only from the flag', () => {
    let summaries = capped([unsetContext('web', 'api')], {
      exposure_context_count: undefined,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    summaries = applySavedIntents(summaries, 'web', [{ service: 'api', intent: 'public' }]);
    summaries = applySavedIntents(summaries, 'web', [{ service: 'api', intent: 'lan' }]);

    expect(summaries['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(summaries['exp:1']?.exposure_context_hidden?.unclassified).toBe(true);
  });

  it('keeps a hidden warning when the only displayed context settles and truncation comes from the count', () => {
    const before = capped([tunnelContext('cloudflared', 'shared-network')], {
      exposure_context_count: 2,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'internal' }]);
    const patched = after['exp:1']!;

    expect(patched.publicly_exposed).toBe(true);
    expect(patched.exposure_contexts).toEqual([]);
    expect(patched.exposure_context_count).toBe(1);
    expect(standingIntentEvidence(patched)).toBe('Intent: not classified');
  });

  it('keeps a hidden warning when the only displayed context settles and truncation comes only from the flag', () => {
    const before = capped([tunnelContext('cloudflared', 'shared-network')], {
      exposure_context_count: undefined,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: true,
        hasUnavailable: false,
        allKnownIntentional: false,
      },
    });

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'internal' }]);
    const patched = after['exp:1']!;

    expect(patched.publicly_exposed).toBe(true);
    expect(patched.exposure_contexts).toEqual([]);
    expect(patched.exposure_contexts_truncated).toBe(true);
    // The total is unknown without a count, so the projection does not invent one.
    expect(patched.exposure_context_count).toBeUndefined();
    expect(standingIntentEvidence(patched)).toBe('Intent: not classified');
  });

  it('keeps a hidden unavailable warning across saves', () => {
    // With every visible context unavailable, the sorted slice can hide more of
    // the same rank; a visible set context would prove the remainder is set too.
    const visible = Array.from({ length: 20 }, (_, index) =>
      ctx({ stackName: 'web', serviceName: `svc${index}`, intentStatus: 'unavailable' }));
    let summaries = capped(visible, {
      exposure_context_count: 21,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: false,
        hasUnavailable: true,
        allKnownIntentional: true,
      },
    });

    const saved: Array<{ service: string; intent: 'public' }> = [];
    for (let index = 0; index < visible.length; index += 1) {
      saved.push({ service: `svc${index}`, intent: 'public' });
      summaries = applySavedIntents(summaries, 'web', saved);
    }

    expect(summaries['exp:1']?.exposure_context_summary?.hasUnavailable).toBe(true);
    expect(summaries['exp:1']?.exposure_context_hidden?.unavailable).toBe(true);
  });

  it('keeps a visible unavailable state when the visible ranks allow a hidden one', () => {
    const before = capped([
      ctx({ stackName: 'web', serviceName: 'api', intentStatus: 'unavailable' }),
      ctx({ stackName: 'web', serviceName: 'worker', intentStatus: 'unavailable' }),
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

    // The last visible context is still unavailable, so the hidden remainder may
    // hold one too.
    expect(after['exp:1']?.exposure_context_summary?.hasUnavailable).toBe(true);
  });
});

describe('applySavedIntents hidden context saves', () => {
  const hiddenTunnel: ImageExposureContext = {
    stackName: 'web',
    serviceName: 'hidden',
    exposureReason: 'tunnel',
    tunnel: {
      connector: 'edge',
      provider: 'cloudflared',
      scope: 'public-edge',
      path: 'shared-network',
    },
    intentStatus: 'unset',
  };
  const hiddenPort: ImageExposureContext = {
    stackName: 'web',
    serviceName: 'hidden',
    exposureReason: 'published-port',
    intentStatus: 'unset',
  };

  function allPublicContexts(count: number): ImageExposureContext[] {
    return Array.from({ length: count }, (_, index) =>
      ctx({ stackName: 'web', serviceName: `svc${index}`, intentStatus: 'set', exposureIntent: 'public' }));
  }

  function publicIntents(count: number): Array<{ service: string; intent: 'public' }> {
    return Array.from({ length: count }, (_, index) => ({ service: `svc${index}`, intent: 'public' }));
  }

  it('settles a hidden tunnel reach and drops it from the count', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', allPublicContexts(20), {
        exposure_context_count: 21,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: false,
          hasUnavailable: false,
          allKnownIntentional: true,
        },
      }),
    };

    const after = applySavedIntents(
      before,
      'web',
      [...publicIntents(20), { service: 'hidden', intent: 'internal' }],
      { imageRef: 'exp:1', context: hiddenTunnel },
    );
    const patched = after['exp:1']!;

    expect(patched.exposure_context_count).toBe(20);
    expect(patched.exposure_contexts_truncated).toBe(false);
    expect(patched.exposure_context_hidden).toBeUndefined();
    expect(standingIntentEvidence(patched)).toBe('Intent: public (+19)');
  });

  it('settles the last hidden context when no displayed context remains', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [], {
        exposure_context_count: 1,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: true,
          hasUnavailable: false,
          allKnownIntentional: false,
        },
        exposure_context_hidden: { conflict: false, unclassified: true, unavailable: false },
      }),
    };

    const after = applySavedIntents(
      before,
      'web',
      [{ service: 'hidden', intent: 'internal' }],
      { imageRef: 'exp:1', context: hiddenTunnel },
    );
    const patched = after['exp:1']!;

    expect(patched.publicly_exposed).toBe(false);
    expect(patched.exposure_contexts).toEqual([]);
    expect(patched.exposure_context_count).toBe(0);
    expect(patched.exposure_contexts_truncated).toBe(false);
    expect(patched.exposure_context_hidden).toBeUndefined();
  });

  it('adds the conflict a hidden save proves when no displayed context remains', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [], {
        exposure_context_count: 1,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: true,
          hasUnavailable: false,
          allKnownIntentional: false,
        },
        exposure_context_hidden: { conflict: false, unclassified: true, unavailable: false },
      }),
    };

    const after = applySavedIntents(
      before,
      'web',
      [{ service: 'hidden', intent: 'internal' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );
    const patched = after['exp:1']!;

    expect(patched.publicly_exposed).toBe(true);
    expect(patched.exposure_context_summary?.hasConflict).toBe(true);
    expect(patched.exposure_contexts).toEqual([
      { ...hiddenPort, intentStatus: 'set', exposureIntent: 'internal', intentConflict: true },
    ]);
    expect(patched.exposure_contexts_truncated).toBe(false);
    expect(standingIntentEvidence(patched)).toBe('Intent mismatch: internal');
  });

  it('clears a hidden unclassified warning when the last hidden context is classified', () => {
    const visible = Array.from({ length: 20 }, (_, index) => unsetContext('web', `svc${index}`));
    let summaries: Record<string, ScanSummary> = {
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

    // The hidden service is saved first; the PUT reply carries the whole set.
    summaries = applySavedIntents(
      summaries,
      'web',
      [{ service: 'hidden', intent: 'public' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );
    const saved = [{ service: 'hidden', intent: 'public' as const }];
    for (let index = 0; index < visible.length; index += 1) {
      saved.push({ service: `svc${index}`, intent: 'public' });
      summaries = applySavedIntents(summaries, 'web', saved);
    }

    expect(summaries['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(false);
    expect(summaries['exp:1']?.exposure_context_hidden).toBeUndefined();
    expect(summaries['exp:1']?.exposure_contexts_truncated).toBe(false);
    expect(standingIntentEvidence(summaries['exp:1']!)).toBe('Intent: public (+20)');
  });

  it('names a hidden conflict with the intent the save proved', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', allPublicContexts(20), {
        exposure_context_count: 21,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: false,
          hasUnavailable: false,
          allKnownIntentional: true,
        },
      }),
    };

    const after = applySavedIntents(
      before,
      'web',
      [...publicIntents(20), { service: 'hidden', intent: 'same-node' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );

    expect(standingIntentEvidence(after['exp:1']!)).toBe('Intent mismatch: same-node (+20)');
  });

  it('does not project a hidden save into a sibling image or stack', () => {
    const capped = (imageRef: string) => exposedSummary(imageRef, allPublicContexts(20), {
      exposure_context_count: 21,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false,
        hasUnclassified: false,
        hasUnavailable: false,
        allKnownIntentional: true,
      },
    });
    const before = { 'exp:1': capped('exp:1'), 'exp:2': capped('exp:2') };

    const sibling = applySavedIntents(
      before,
      'web',
      [...publicIntents(20), { service: 'hidden', intent: 'internal' }],
      { imageRef: 'exp:2', context: hiddenPort },
    );
    expect(sibling['exp:1']).toBe(before['exp:1']);
    expect(sibling['exp:2']?.exposure_context_summary?.hasConflict).toBe(true);

    const otherStack = applySavedIntents(
      before,
      'db',
      [...publicIntents(20), { service: 'hidden', intent: 'internal' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );
    expect(otherStack).toBe(before);
  });

  it('keeps the may-hold warning when another hidden context remains', () => {
    const visible = Array.from({ length: 20 }, (_, index) => unsetContext('web', `svc${index}`));
    const before = {
      'exp:1': exposedSummary('exp:1', visible, {
        exposure_context_count: 22,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: true,
          hasUnavailable: false,
          allKnownIntentional: false,
        },
      }),
    };

    // Two contexts are hidden, so classifying one leaves the other unknown.
    const after = applySavedIntents(
      before,
      'web',
      [{ service: 'hidden', intent: 'public' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );

    expect(after['exp:1']?.exposure_context_hidden?.unclassified).toBe(true);
    expect(standingIntentEvidence(after['exp:1']!)).toBe('Intent: not classified (+21)');
  });

  it('does not resurrect a settled hidden remainder on the next save', () => {
    const visible = Array.from({ length: 20 }, (_, index) => unsetContext('web', `svc${index}`));
    let summaries: Record<string, ScanSummary> = {
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

    // Resolving the displayed contexts first pins the may-hold hidden warning.
    summaries = applySavedIntents(summaries, 'web', publicIntents(20));
    expect(summaries['exp:1']?.exposure_context_hidden?.unclassified).toBe(true);

    const settled = applySavedIntents(
      summaries,
      'web',
      [...publicIntents(20), { service: 'hidden', intent: 'internal' }],
      { imageRef: 'exp:1', context: hiddenTunnel },
    );
    expect(settled['exp:1']?.exposure_contexts_truncated).toBe(false);
    expect(settled['exp:1']?.exposure_context_hidden).toBeUndefined();

    const next = applySavedIntents(settled, 'web', [
      ...publicIntents(20).map((entry, index) => (index === 0 ? { ...entry, intent: 'lan' as const } : entry)),
      { service: 'hidden', intent: 'internal' as const },
    ]);

    expect(next['exp:1']?.exposure_contexts_truncated).toBe(false);
    expect(next['exp:1']?.exposure_context_hidden).toBeUndefined();
    expect(standingIntentEvidence(next['exp:1']!)).toBe('Intent: LAN (+19)');
    expect(summaries['exp:1']?.exposure_contexts_truncated).toBe(true);
  });

  it('keeps the truncation flag when a hidden remainder remains without a summary', () => {
    const before = {
      'exp:1': summary({
        image_ref: 'exp:1',
        publicly_exposed: true,
        exposure_contexts: [unsetContext('web', 'api')],
        exposure_context_count: 2,
      }),
    };

    const after = applySavedIntents(before, 'web', [{ service: 'api', intent: 'public' }]);

    // The count says a context stays hidden, so the flag must not be cleared.
    expect(after['exp:1']?.exposure_contexts_truncated).toBe(true);
    expect(after['exp:1']?.exposure_context_count).toBe(2);
  });

  it('clears a hidden unavailable state when the last hidden context is classified', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', allPublicContexts(20), {
        exposure_context_count: 21,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: false,
          hasUnavailable: true,
          allKnownIntentional: true,
        },
        exposure_context_hidden: { conflict: false, unclassified: false, unavailable: true },
      }),
    };

    const after = applySavedIntents(
      before,
      'web',
      [...publicIntents(20), { service: 'hidden', intent: 'public' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );

    expect(after['exp:1']?.exposure_context_summary?.hasUnavailable).toBe(false);
    expect(after['exp:1']?.exposure_context_hidden).toBeUndefined();
  });

  it('keeps the states another hidden context may hold and names the conflict a saved one proves', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', allPublicContexts(20), {
        exposure_context_count: 22,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: true,
          hasUnclassified: false,
          hasUnavailable: true,
          allKnownIntentional: false,
        },
        exposure_context_hidden: { conflict: true, unclassified: false, unavailable: true },
      }),
    };

    // Two contexts are hidden, so classifying one leaves the other unknown: the
    // flags stay, and the saved context joins the list with what it proved.
    const unclassified = applySavedIntents(
      before,
      'web',
      [...publicIntents(20), { service: 'hidden', intent: 'unknown' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );
    expect(unclassified['exp:1']?.exposure_context_hidden).toEqual({
      conflict: true,
      unclassified: false,
      unavailable: true,
    });
    expect(unclassified['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(unclassified['exp:1']?.exposure_context_count).toBe(22);
    expect(unclassified['exp:1']?.exposure_contexts).toHaveLength(21);

    // The service is listed now, so a later save of it patches that row and
    // names its conflicting intent.
    const conflicted = applySavedIntents(
      unclassified,
      'web',
      [...publicIntents(20), { service: 'hidden', intent: 'same-node' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );
    expect(conflicted['exp:1']?.exposure_contexts).toHaveLength(21);
    expect(standingIntentEvidence(conflicted['exp:1']!)).toBe('Intent mismatch: same-node (+21)');
  });

  it('names the intent a hidden save proved when no displayed context remains', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [], {
        exposure_context_count: 1,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: true,
          hasUnavailable: false,
          allKnownIntentional: false,
        },
        exposure_context_hidden: { conflict: false, unclassified: true, unavailable: false },
      }),
    };

    const after = applySavedIntents(
      before,
      'web',
      [{ service: 'hidden', intent: 'same-node' }],
      { imageRef: 'exp:1', context: hiddenPort },
    );

    expect(standingIntentEvidence(after['exp:1']!)).toBe('Intent mismatch: same-node');
  });
});

describe('applySavedIntents hidden contexts kept on the row', () => {
  const hidden = (serviceName: string, stackName = 'web'): ImageExposureContext => ({
    stackName,
    serviceName,
    exposureReason: 'published-port',
    intentStatus: 'unset',
  });
  const cappedSummary = (): Record<string, ScanSummary> => ({
    'exp:1': exposedSummary(
      'exp:1',
      Array.from({ length: 20 }, (_, index) => ctx({
        stackName: 'web', serviceName: `svc${index}`, intentStatus: 'set', exposureIntent: 'public',
      })),
      {
        exposure_context_count: 21,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false, hasUnclassified: false, hasUnavailable: false, allKnownIntentional: true,
        },
      },
    ),
  });
  const visibleIntents = Array.from({ length: 20 }, (_, index) => ({ service: `svc${index}`, intent: 'public' as const }));

  it('lists a saved hidden service with its confirmed intent so its action stays', () => {
    const after = applySavedIntents(
      cappedSummary(),
      'web',
      [...visibleIntents, { service: 'late', intent: 'public' }],
      { imageRef: 'exp:1', context: hidden('late') },
    )['exp:1']!;

    const listed = standingExposureContexts(after).find((context) => context.serviceName === 'late');
    expect(listed).toMatchObject({ stackName: 'web', intentStatus: 'set', exposureIntent: 'public' });
    // The count is the server's total, and nothing is left beyond the list.
    expect(after.exposure_context_count).toBe(21);
    expect(after.exposure_contexts).toHaveLength(21);
    expect(after.exposure_contexts_truncated).toBe(false);
  });

  it('keeps a saved hidden service exposed and listed under a restrictive intent when exposure is certain', () => {
    for (const intent of ['internal', 'same-node'] as const) {
      const after = applySavedIntents(
        cappedSummary(),
        'web',
        [...visibleIntents, { service: 'late', intent }],
        { imageRef: 'exp:1', context: hidden('late') },
      )['exp:1']!;
      expect(standingExposureContexts(after).find((c) => c.serviceName === 'late'))
        .toMatchObject({ intentStatus: 'set', exposureIntent: intent, intentConflict: true });
      expect(after.exposure_context_summary?.hasConflict).toBe(true);
    }
  });

  it('returns a cleared hidden service to the stack intent, or to unclassified', () => {
    const inherited = applySavedIntents(
      cappedSummary(),
      'web',
      [...visibleIntents, { service: '', intent: 'lan' }],
      { imageRef: 'exp:1', context: hidden('late') },
    )['exp:1']!;
    expect(standingExposureContexts(inherited).find((c) => c.serviceName === 'late'))
      .toMatchObject({ intentStatus: 'set', exposureIntent: 'lan' });

    const cleared = applySavedIntents(
      cappedSummary(),
      'web',
      visibleIntents,
      { imageRef: 'exp:1', context: hidden('late') },
    )['exp:1']!;
    expect(standingExposureContexts(cleared).find((c) => c.serviceName === 'late'))
      .toMatchObject({ intentStatus: 'unset' });
    expect(standingIntentEvidence(cleared)).toBe('Intent: not classified (+20)');
  });

  it('does not list a hidden service a restrictive intent settles away', () => {
    const tunnel: ImageExposureContext = {
      ...hidden('late'),
      exposureReason: 'tunnel',
      tunnel: { connector: 'edge', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' },
    };
    const after = applySavedIntents(
      cappedSummary(),
      'web',
      [...visibleIntents, { service: 'late', intent: 'internal' }],
      { imageRef: 'exp:1', context: tunnel },
    )['exp:1']!;
    expect(standingExposureContexts(after).some((c) => c.serviceName === 'late')).toBe(false);
    expect(after.exposure_context_count).toBe(20);
  });
});

describe('applySavedIntents contexts settled away and saved again', () => {
  const tunnel = (serviceName: string): ImageExposureContext => ({
    stackName: 'web',
    serviceName,
    exposureReason: 'tunnel',
    tunnel: { connector: 'edge', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' },
    intentStatus: 'unset',
  });
  /** One listed unverified tunnel context and one the cap hides. */
  const start = (): Record<string, ScanSummary> => ({
    'exp:1': exposedSummary('exp:1', [tunnel('edge-api')], {
      exposure_context_count: 2,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false, hasUnclassified: true, hasUnavailable: false, allKnownIntentional: false,
      },
    }),
  });

  it('restores the count a settled context took instead of consuming the hidden remainder', () => {
    const settled = applySavedIntents(start(), 'web', [{ service: 'edge-api', intent: 'internal' }]);
    expect(settled['exp:1']?.exposure_context_count).toBe(1);
    expect(settled['exp:1']?.exposure_contexts).toHaveLength(0);

    // A second save of the same service, still in flight, no longer settles it.
    const again = applySavedIntents(
      settled,
      'web',
      [{ service: 'edge-api', intent: 'public' }],
      { imageRef: 'exp:1', context: tunnel('edge-api') },
    )['exp:1']!;
    expect(again.exposure_context_count).toBe(2);
    expect(again.exposure_contexts).toHaveLength(1);
    // One context is still hidden, so what it may hold is still reported.
    expect(again.exposure_contexts_truncated).toBe(true);
    expect(again.exposure_context_hidden?.unclassified).toBe(true);
    expect(again.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(again.exposure_context_settled).toBeUndefined();
  });

  it('does nothing when a settled context settles again', () => {
    const settled = applySavedIntents(start(), 'web', [{ service: 'edge-api', intent: 'internal' }]);
    const again = applySavedIntents(
      settled,
      'web',
      [{ service: 'edge-api', intent: 'same-node' }],
      { imageRef: 'exp:1', context: tunnel('edge-api') },
    );
    expect(again).toBe(settled);
  });

  it('exposes the image again when its only settled context is saved with another intent', () => {
    const only: Record<string, ScanSummary> = { 'exp:1': exposedSummary('exp:1', [tunnel('edge-api')]) };
    const settled = applySavedIntents(only, 'web', [{ service: 'edge-api', intent: 'internal' }]);
    expect(settled['exp:1']?.publicly_exposed).toBe(false);

    const again = applySavedIntents(
      settled,
      'web',
      [{ service: 'edge-api', intent: 'public' }],
      { imageRef: 'exp:1', context: tunnel('edge-api') },
    )['exp:1']!;
    expect(again.publicly_exposed).toBe(true);
    expect(again.exposure_context_count).toBe(1);
    expect(standingExposureContexts(again)).toMatchObject([{ serviceName: 'edge-api', exposureIntent: 'public' }]);
  });
});

describe('applySavedIntents hidden saves it must not invent', () => {
  it('adds no context for a save the image does not hide', () => {
    const before = {
      'exp:1': exposedSummary('exp:1', [unsetContext('web', 'api')], { exposure_context_count: 1 }),
    };
    const after = applySavedIntents(
      before,
      'web',
      [{ service: 'api', intent: 'public' }, { service: 'other', intent: 'public' }],
      { imageRef: 'exp:1', context: unsetContext('web', 'other') },
    )['exp:1']!;
    expect(after.exposure_contexts).toHaveLength(1);
    expect(after.exposure_context_count).toBe(1);
  });

  it('keeps two hidden services conflicting under restrictive intents and clears the remainder', () => {
    const visible = Array.from({ length: 20 }, (_, index) => ctx({
      stackName: 'web', serviceName: `svc${index}`, intentStatus: 'set', exposureIntent: 'public',
    }));
    const base = {
      'exp:1': exposedSummary('exp:1', visible, {
        exposure_context_count: 22,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false, hasUnclassified: true, hasUnavailable: false, allKnownIntentional: false,
        },
      }),
    };
    const rows = Array.from({ length: 20 }, (_, index) => ({ service: `svc${index}`, intent: 'public' as const }));
    const hiddenCtx = (name: string): ImageExposureContext => ({
      stackName: 'web', serviceName: name, exposureReason: 'published-port', intentStatus: 'unset',
    });
    let summaries = applySavedIntents(base, 'web', [...rows, { service: 'h1', intent: 'internal' }], {
      imageRef: 'exp:1', context: hiddenCtx('h1'),
    });
    summaries = applySavedIntents(summaries, 'web', [...rows, { service: 'h1', intent: 'internal' }, { service: 'h2', intent: 'same-node' }], {
      imageRef: 'exp:1', context: hiddenCtx('h2'),
    });
    const after = summaries['exp:1']!;
    expect(after.exposure_contexts_truncated).toBe(false);
    expect(after.exposure_context_hidden).toBeUndefined();
    // Certain exposure under a restrictive intent is a real mismatch, not a leftover warning.
    expect(after.exposure_context_summary).toMatchObject({ hasConflict: true, hasUnclassified: false });
    expect(standingExposureContexts(after).filter((c) => c.intentConflict)).toHaveLength(2);
  });
});

describe('applySavedIntents resolves a warning once every hidden context is saved', () => {
  type Warning = 'conflict' | 'unclassified' | 'unavailable';
  const visibleContext = (warning: Warning, index: number): ImageExposureContext => ({
    stackName: 'web',
    serviceName: `svc${index}`,
    exposureReason: 'published-port',
    ...(warning === 'conflict'
      ? { intentStatus: 'set' as const, exposureIntent: 'internal' as const, intentConflict: true }
      : { intentStatus: warning === 'unclassified' ? 'unset' as const : 'unavailable' as const }),
  });
  const flags = (warning: Warning) => ({
    hasConflict: warning === 'conflict',
    hasUnclassified: warning === 'unclassified',
    hasUnavailable: warning === 'unavailable',
    allKnownIntentional: false,
  });
  /** Twenty displayed contexts carrying the warning and two the cap hides. */
  const start = (warning: Warning, truncation: 'count' | 'flag'): Record<string, ScanSummary> => ({
    'exp:1': exposedSummary(
      'exp:1',
      Array.from({ length: 20 }, (_, index) => visibleContext(warning, index)),
      {
        exposure_context_count: 22,
        ...(truncation === 'flag' ? { exposure_contexts_truncated: true } : {}),
        exposure_context_summary: flags(warning),
      },
    ),
  });
  const hiddenContext = (stackName: string, serviceName: string): ImageExposureContext => ({
    stackName, serviceName, exposureReason: 'published-port', intentStatus: 'unset',
  });
  const warns = (summary: ScanSummary) => (
    summary.exposure_context_summary?.hasConflict === true
    || summary.exposure_context_summary?.hasUnclassified === true
    || summary.exposure_context_summary?.hasUnavailable === true
  );

  /** Classify the twenty displayed services, then the two hidden ones in turn. */
  function runSaves(
    warning: Warning,
    truncation: 'count' | 'flag',
    intent: 'public' | 'lan' | 'reverse-proxy' | 'temporary',
    hiddenStacks: [string, string],
  ) {
    let summaries = start(warning, truncation);
    const web = [] as Array<{ service: string; intent: typeof intent }>;
    for (let index = 0; index < 20; index += 1) {
      web.push({ service: `svc${index}`, intent });
      summaries = applySavedIntents(summaries, 'web', web);
    }
    const afterVisible = summaries['exp:1']!;
    const rows: Record<string, Array<{ service: string; intent: typeof intent }>> = { web };
    const saveHidden = (stackName: string, service: string) => {
      rows[stackName] = [...(rows[stackName] ?? []), { service, intent }];
      summaries = applySavedIntents(summaries, stackName, rows[stackName]!, {
        imageRef: 'exp:1',
        context: hiddenContext(stackName, service),
      });
      return summaries['exp:1']!;
    };
    const afterFirst = saveHidden(hiddenStacks[0], 'hidden1');
    const afterSecond = saveHidden(hiddenStacks[1], 'hidden2');
    return { afterVisible, afterFirst, afterSecond };
  }

  const cases: Array<[Warning, 'count' | 'flag', 'public' | 'lan' | 'reverse-proxy' | 'temporary', [string, string]]> = [];
  for (const warning of ['conflict', 'unclassified', 'unavailable'] as const) {
    for (const truncation of ['count', 'flag'] as const) {
      for (const intent of ['public', 'lan', 'reverse-proxy', 'temporary'] as const) {
        for (const stacks of [['web', 'web'], ['web', 'jobs']] as Array<[string, string]>) {
          cases.push([warning, truncation, intent, stacks]);
        }
      }
    }
  }

  it.each(cases)('%s warning, truncation by %s, intent %s, hidden stacks %j', (warning, truncation, intent, stacks) => {
    const { afterVisible, afterFirst, afterSecond } = runSaves(warning, truncation, intent, stacks);

    // Two services beyond the list were never classified, so the warning stays.
    expect(warns(afterVisible)).toBe(true);
    // One of the two is classified; the other may still hold it.
    expect(warns(afterFirst)).toBe(true);
    expect(afterFirst.exposure_contexts_truncated).toBe(true);
    // Every service is now known, and none of them warns.
    expect(warns(afterSecond)).toBe(false);
    expect(afterSecond.exposure_context_hidden).toBeUndefined();
    expect(afterSecond.exposure_contexts_truncated).toBe(false);
    expect(afterSecond.exposure_contexts).toHaveLength(22);
    expect(afterSecond.exposure_context_summary?.allKnownIntentional).toBe(true);
    expect(standingIntentEvidence(afterSecond)).not.toMatch(/mismatch|not classified/);
  });

  it('does not count a repeated save of one hidden service as the other', () => {
    let summaries = start('unclassified', 'count');
    const web = Array.from({ length: 20 }, (_, index) => ({ service: `svc${index}`, intent: 'public' as const }));
    summaries = applySavedIntents(summaries, 'web', web);
    const save = (intent: 'public' | 'lan') => {
      summaries = applySavedIntents(summaries, 'web', [...web, { service: 'hidden1', intent }], {
        imageRef: 'exp:1',
        context: hiddenContext('web', 'hidden1'),
      });
      return summaries['exp:1']!;
    };
    save('public');
    const again = save('lan');
    expect(again.exposure_contexts).toHaveLength(21);
    expect(again.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(standingIntentEvidence(again)).toBe('Intent: not classified (+21)');
  });

  it('resolves the warning when one hidden service settles and the other is classified, in either order', () => {
    const tunnel: ImageExposureContext = {
      ...hiddenContext('web', 'hidden1'),
      exposureReason: 'tunnel',
      tunnel: { connector: 'edge', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' },
    };
    const web = Array.from({ length: 20 }, (_, index) => ({ service: `svc${index}`, intent: 'public' as const }));
    const rows = [...web, { service: 'hidden1', intent: 'internal' as const }, { service: 'hidden2', intent: 'public' as const }];
    const settle = (summaries: Record<string, ScanSummary>) => applySavedIntents(summaries, 'web', rows, {
      imageRef: 'exp:1', context: tunnel,
    });
    const classify = (summaries: Record<string, ScanSummary>) => applySavedIntents(summaries, 'web', rows, {
      imageRef: 'exp:1', context: hiddenContext('web', 'hidden2'),
    });

    const base = applySavedIntents(start('unclassified', 'count'), 'web', web);
    for (const final of [classify(settle(base)), settle(classify(base))]) {
      const done = final['exp:1']!;
      expect(warns(done)).toBe(false);
      expect(done.exposure_context_count).toBe(21);
      expect(done.exposure_contexts).toHaveLength(21);
      expect(done.exposure_contexts_truncated).toBe(false);
    }
  });

  it('keeps the warning when the cap flag has no count to follow', () => {
    const base = start('unclassified', 'flag')['exp:1']!;
    const noCount: Record<string, ScanSummary> = { 'exp:1': { ...base, exposure_context_count: undefined } };
    const web = Array.from({ length: 20 }, (_, index) => ({ service: `svc${index}`, intent: 'public' as const }));
    let summaries = applySavedIntents(noCount, 'web', web);
    summaries = applySavedIntents(summaries, 'web', [...web, { service: 'hidden1', intent: 'public' }], {
      imageRef: 'exp:1', context: hiddenContext('web', 'hidden1'),
    });
    summaries = applySavedIntents(summaries, 'web', [...web, { service: 'hidden1', intent: 'public' }, { service: 'hidden2', intent: 'public' }], {
      imageRef: 'exp:1', context: hiddenContext('web', 'hidden2'),
    });
    // How many contexts are hidden is unknown, so nothing proves them all saved.
    expect(summaries['exp:1']?.exposure_context_summary?.hasUnclassified).toBe(true);
    expect(summaries['exp:1']?.exposure_contexts_truncated).toBe(true);
  });
});

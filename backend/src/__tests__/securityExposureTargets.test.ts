
import { describe, it, expect, vi } from 'vitest';
import {
  buildSecurityExposureTargets,
  buildImageExposureContextRows,
  packageImageExposureContexts,
  allTargetsIntentionallyClassified,
  allContextsAbsolutelyIntentional,
  partialIntentionalWithUnavailable,
  summarizeExposureContexts,
  IMAGE_EXPOSURE_CONTEXT_CAP,
  type ImageExposureContext,
} from '../services/securityExposureTargets';
import type { StackExposure } from '../services/preflight/exposure';
import type { ExposureContext } from '../services/network/exposureContext';
import type { PostureTarget } from '../services/securityPosture';

function exposure(stack: string, services: StackExposure['services']): StackExposure {
  return { stack, services, computedAt: 1 };
}

function svc(
  name: string,
  image: string,
  publiclyExposed = true,
  reason: 'published-port' | 'host-network' | null = 'published-port',
): StackExposure['services'][number] {
  return { service: name, image, publiclyExposed, reason, bindings: publiclyExposed ? ['0.0.0.0:80/tcp'] : [] };
}

describe('buildSecurityExposureTargets', () => {
  it('emits public intent when stack intent is public', () => {
    const getContext = vi.fn((): ExposureContext => ({
      available: true,
      stackIntent: 'public',
      serviceIntents: {},
      accessUrlPorts: new Set(),
      hasAccessUrls: false,
    }));
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'nginx:1')])],
      qualifyingImageRefs: new Set(['nginx:1']),
      getContext,
    });
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(targets).toEqual([{
      imageRef: 'nginx:1',
      stackName: 'web',
      serviceName: 'api',
      exposureReason: 'published-port',
      intentStatus: 'set',
      exposureIntent: 'public',
    }]);
  });

  it('flags internal conflict when published beyond loopback', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'app:1')])],
      qualifyingImageRefs: new Set(['app:1']),
      getContext: () => ({
        available: true,
        stackIntent: 'internal',
        serviceIntents: {},
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      }),
    });
    expect(targets[0]).toMatchObject({
      exposureIntent: 'internal',
      intentStatus: 'set',
      intentConflict: true,
    });
  });

  it('treats null intent as unset', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'app:1')])],
      qualifyingImageRefs: new Set(['app:1']),
      getContext: () => ({
        available: true,
        stackIntent: null,
        serviceIntents: {},
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      }),
    });
    expect(targets[0].intentStatus).toBe('unset');
  });

  it('marks unavailable when context is unavailable', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'app:1')])],
      qualifyingImageRefs: new Set(['app:1']),
      getContext: () => ({ available: false }),
    });
    expect(targets[0].intentStatus).toBe('unavailable');
  });

  it('prefers service override over stack intent', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'app:1'), svc('worker', 'app:1')])],
      qualifyingImageRefs: new Set(['app:1']),
      getContext: () => ({
        available: true,
        stackIntent: 'public',
        serviceIntents: { worker: 'internal' },
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      }),
    });
    expect(targets.find((t) => t.serviceName === 'api')?.exposureIntent).toBe('public');
    expect(targets.find((t) => t.serviceName === 'worker')?.intentConflict).toBe(true);
  });
});

describe('intentional helpers and packaging', () => {
  it('absolute intentional requires every context complete', () => {
    const intentional: ImageExposureContext[] = [
      { stackName: 'a', serviceName: 's', exposureReason: 'published-port', intentStatus: 'set', exposureIntent: 'public' },
    ];
    expect(allContextsAbsolutelyIntentional(intentional)).toBe(true);

    const withUnavailable: ImageExposureContext[] = [
      ...intentional,
      { stackName: 'b', serviceName: 's', exposureReason: 'published-port', intentStatus: 'unavailable' },
    ];
    expect(allContextsAbsolutelyIntentional(withUnavailable)).toBe(false);
    expect(partialIntentionalWithUnavailable(withUnavailable)).toEqual({
      partial: true,
      unavailableCount: 1,
    });
  });

  it('allTargetsIntentionallyClassified is false when any unavailable', () => {
    const targets: PostureTarget[] = [
      { imageRef: 'a', stackName: 's', serviceName: 'a', intentStatus: 'set', exposureIntent: 'public' },
      { imageRef: 'a', stackName: 's', serviceName: 'b', intentStatus: 'unavailable' },
    ];
    expect(allTargetsIntentionallyClassified(targets)).toBe(false);
  });

  it('allTargetsIntentionallyClassified is true for a complete public posture target', () => {
    expect(allTargetsIntentionallyClassified([{
      imageRef: 'a:1',
      stackName: 'web',
      serviceName: 'api',
      intentStatus: 'set',
      exposureIntent: 'public',
    }])).toBe(true);
  });

  it('packageImageExposureContexts aggregates before cap and prefers conflict in display', () => {
    const contexts: ImageExposureContext[] = [];
    for (let i = 0; i < IMAGE_EXPOSURE_CONTEXT_CAP; i += 1) {
      contexts.push({
        stackName: `s${i}`,
        serviceName: 'svc',
        exposureReason: 'published-port',
        intentStatus: 'set',
        exposureIntent: 'public',
      });
    }
    contexts.push({
      stackName: 'hidden',
      serviceName: 'svc',
      exposureReason: 'published-port',
      intentStatus: 'set',
      exposureIntent: 'internal',
      intentConflict: true,
    });
    const packaged = packageImageExposureContexts(contexts);
    expect(packaged.exposure_contexts_truncated).toBe(true);
    expect(packaged.exposure_context_count).toBe(IMAGE_EXPOSURE_CONTEXT_CAP + 1);
    expect(packaged.exposure_context_summary.hasConflict).toBe(true);
    expect(packaged.exposure_context_summary.allKnownIntentional).toBe(false);
    expect(packaged.exposure_contexts[0].intentConflict).toBe(true);
    expect(allContextsAbsolutelyIntentional(contexts, packaged.exposure_contexts_truncated)).toBe(false);
  });

  it('summarizeExposureContexts sets allKnownIntentional when only intentional set contexts exist among available', () => {
    const summary = summarizeExposureContexts([
      { stackName: 'a', serviceName: 's', exposureReason: null, intentStatus: 'set', exposureIntent: 'lan' },
      { stackName: 'b', serviceName: 's', exposureReason: null, intentStatus: 'unavailable' },
    ]);
    expect(summary).toMatchObject({
      hasUnavailable: true,
      allKnownIntentional: true,
      hasConflict: false,
      hasUnclassified: false,
    });
  });
});

describe('buildImageExposureContextRows', () => {
  it('batches getContext once per stack', () => {
    const getContext = vi.fn((): ExposureContext => ({
      available: true,
      stackIntent: 'public',
      serviceIntents: {},
      accessUrlPorts: new Set(),
      hasAccessUrls: false,
    }));
    buildImageExposureContextRows({
      nodeId: 1,
      exposures: [exposure('web', [svc('a', 'i:1'), svc('b', 'i:2')])],
      qualifyingImageRefs: new Set(['i:1', 'i:2']),
      getContext,
    });
    expect(getContext).toHaveBeenCalledTimes(1);
  });
});

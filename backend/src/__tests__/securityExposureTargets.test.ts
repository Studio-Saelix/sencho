import { describe, it, expect, vi } from 'vitest';
import {
  buildSecurityExposureTargets,
  allTargetsIntentionallyClassified,
  anyTargetIntentConflict,
  anyTargetIntentUnset,
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

  it('marks lan as intentional set without conflict', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'app:1')])],
      qualifyingImageRefs: new Set(['app:1']),
      getContext: () => ({
        available: true,
        stackIntent: 'lan',
        serviceIntents: {},
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      }),
    });
    expect(targets[0]).toMatchObject({
      exposureIntent: 'lan',
      intentStatus: 'set',
    });
    expect(targets[0].intentConflict).toBeUndefined();
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

  it('flags same-node conflict', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'app:1')])],
      qualifyingImageRefs: new Set(['app:1']),
      getContext: () => ({
        available: true,
        stackIntent: 'same-node',
        serviceIntents: {},
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      }),
    });
    expect(targets[0].intentConflict).toBe(true);
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
    expect(targets[0]).toEqual({
      imageRef: 'app:1',
      stackName: 'web',
      serviceName: 'api',
      exposureReason: 'published-port',
      intentStatus: 'unset',
    });
  });

  it('treats unknown intent as unset', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'app:1')])],
      qualifyingImageRefs: new Set(['app:1']),
      getContext: () => ({
        available: true,
        stackIntent: 'unknown',
        serviceIntents: {},
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      }),
    });
    expect(targets[0].intentStatus).toBe('unset');
    expect(targets[0].exposureIntent).toBeUndefined();
  });

  it('marks unavailable when context is unavailable (not unset)', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('api', 'app:1')])],
      qualifyingImageRefs: new Set(['app:1']),
      getContext: () => ({ available: false }),
    });
    expect(targets[0]).toEqual({
      imageRef: 'app:1',
      stackName: 'web',
      serviceName: 'api',
      exposureReason: 'published-port',
      intentStatus: 'unavailable',
    });
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
    const api = targets.find((t) => t.serviceName === 'api');
    const worker = targets.find((t) => t.serviceName === 'worker');
    expect(api?.exposureIntent).toBe('public');
    expect(worker?.exposureIntent).toBe('internal');
    expect(worker?.intentConflict).toBe(true);
  });

  it('emits two rows for the same image with different intents', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [
        exposure('a', [svc('svc', 'shared:1')]),
        exposure('b', [svc('svc', 'shared:1')]),
      ],
      qualifyingImageRefs: new Set(['shared:1']),
      getContext: (_nodeId, stack) => ({
        available: true,
        stackIntent: stack === 'a' ? 'public' : 'internal',
        serviceIntents: {},
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      }),
    });
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.exposureIntent).sort()).toEqual(['internal', 'public']);
  });

  it('skips non-qualifying and non-exposed services', () => {
    const targets = buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [
        svc('api', 'keep:1'),
        svc('skip', 'other:1'),
        svc('loop', 'keep:1', false, null),
      ])],
      qualifyingImageRefs: new Set(['keep:1']),
      getContext: () => ({
        available: true,
        stackIntent: 'public',
        serviceIntents: {},
        accessUrlPorts: new Set(),
        hasAccessUrls: false,
      }),
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].serviceName).toBe('api');
  });

  it('batches getContext once per stack', () => {
    const getContext = vi.fn((): ExposureContext => ({
      available: true,
      stackIntent: 'public',
      serviceIntents: {},
      accessUrlPorts: new Set(),
      hasAccessUrls: false,
    }));
    buildSecurityExposureTargets({
      nodeId: 1,
      exposures: [exposure('web', [svc('a', 'i:1'), svc('b', 'i:2')])],
      qualifyingImageRefs: new Set(['i:1', 'i:2']),
      getContext,
    });
    expect(getContext).toHaveBeenCalledTimes(1);
  });
});

describe('intent aggregate helpers', () => {
  it('detects intentional classification, conflict, and unset', () => {
    const intentional: PostureTarget[] = [
      { imageRef: 'a', intentStatus: 'set', exposureIntent: 'public' },
      { imageRef: 'b', intentStatus: 'set', exposureIntent: 'lan' },
    ];
    expect(allTargetsIntentionallyClassified(intentional)).toBe(true);
    expect(anyTargetIntentConflict(intentional)).toBe(false);
    expect(anyTargetIntentUnset(intentional)).toBe(false);

    const conflict: PostureTarget[] = [
      { imageRef: 'a', intentStatus: 'set', exposureIntent: 'internal', intentConflict: true },
    ];
    expect(allTargetsIntentionallyClassified(conflict)).toBe(false);
    expect(anyTargetIntentConflict(conflict)).toBe(true);

    const unset: PostureTarget[] = [{ imageRef: 'a', intentStatus: 'unset' }];
    expect(anyTargetIntentUnset(unset)).toBe(true);
    expect(allTargetsIntentionallyClassified(unset)).toBe(false);

    const unavailableOnly: PostureTarget[] = [{ imageRef: 'a', intentStatus: 'unavailable' }];
    expect(allTargetsIntentionallyClassified(unavailableOnly)).toBe(false);
    expect(anyTargetIntentUnset(unavailableOnly)).toBe(false);
  });
});

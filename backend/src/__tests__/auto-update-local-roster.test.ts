import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageCheckResult } from '../services/ImageUpdateService';
import type { SenchoServiceLabels } from '../helpers/senchoLabels';

const mocks = vi.hoisted(() => ({ facts: vi.fn() }));

vi.mock('../services/effectiveServiceModel', () => ({
    readEffectiveStackFacts: mocks.facts,
}));

import {
    localTriggerRoster,
    revalidateLocalAutoUpdateTrigger,
} from '../helpers/autoUpdateDigestGate';

function labelsFor(services: Record<string, Partial<SenchoServiceLabels>>) {
    const out: Record<string, SenchoServiceLabels> = {};
    for (const [name, overrides] of Object.entries(services)) {
        out[name] = {
            links: [], order: null, hidden: false, update: null, notifyRoute: null,
            updateCheck: true, updateIgnore: [], updateChangelog: null, ...overrides,
        };
    }
    return { renderable: true as const, services: out, entries: [] };
}

function spec(name: string, declaredImage: string | null, hasBuild = false) {
    return { name, declaredImage, hasBuild, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false };
}

const container = (service: string, image: string) => ({
    Image: image, Service: service,
});

const digestUpdate = (): ImageCheckResult => ({
    hasUpdate: true, digestUpdate: true, tagUpdate: false, checkStatus: 'ok',
});
const upToDate = (): ImageCheckResult => ({
    hasUpdate: false, digestUpdate: false, tagUpdate: false, checkStatus: 'ok',
});
const failed = (): ImageCheckResult => ({
    hasUpdate: false, checkStatus: 'failed', error: 'inspect failed',
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.facts.mockResolvedValue({
        model: {
            renderable: true,
            services: [spec('web', 'nginx:1.27'), spec('worker', 'redis:7'), spec('builder', 'builder:latest', true)],
        },
        labels: labelsFor({}),
    });
});

describe('localTriggerRoster', () => {
    it('includes a declared service with no container and excludes build-backed registry images', async () => {
        const roster = await localTriggerRoster(1, 'site', [
            container('worker', 'redis:7'),
            container('builder', 'builder:latest'),
        ]);
        expect(roster.images).toEqual([
            { ref: 'redis:7', owners: ['worker'] },
            { ref: 'nginx:1.27', owners: ['web'] },
        ]);
        expect(roster.buildServices).toEqual(['builder']);
    });

    it('keeps an ownerless container image, which the pre-flight cannot attribute', async () => {
        const roster = await localTriggerRoster(1, 'site', [{ Image: 'legacy:latest' }]);
        expect(roster.images).toContainEqual({ ref: 'legacy:latest', owners: [] });
    });
});

describe('revalidateLocalAutoUpdateTrigger', () => {
    it('fails the run when a declared-only sibling cannot be verified', async () => {
        const message = await revalidateLocalAutoUpdateTrigger(
            1, 'site', async () => [container('worker', 'redis:7')],
            async ref => (ref === 'redis:7' ? digestUpdate() : failed()),
        );
        expect(message).toContain('1 image check(s) failed');
        expect(message).toContain('inspect failed');
    });

    it('allows the run when the declared-only sibling checks out', async () => {
        const message = await revalidateLocalAutoUpdateTrigger(
            1, 'site', async () => [container('worker', 'redis:7')],
            async ref => (ref === 'redis:7' ? digestUpdate() : upToDate()),
        );
        expect(message).toBeNull();
    });

    it('re-reads the labels at the mutation boundary and refuses a now-suppressed trigger', async () => {
        mocks.facts.mockResolvedValue({
            model: { renderable: true, services: [spec('worker', 'redis:7')] },
            labels: labelsFor({ worker: { updateCheck: false } }),
        });
        const message = await revalidateLocalAutoUpdateTrigger(
            1, 'site', async () => [container('worker', 'redis:7')],
            async () => digestUpdate(),
        );
        expect(message).toContain('update checks off');
        expect(message).toContain('no update applied');
    });
});

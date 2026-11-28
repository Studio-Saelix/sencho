/**
 * The live update preview under the update detection labels: per-service
 * skips on a shared image, checks-off services shown as not checked (and never
 * probed), the candidate digest a skip entry names, and the changelog link on
 * a pending update only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SenchoServiceLabels } from '../helpers/senchoLabels';

const DIGEST_LOCAL = `sha256:${'1'.repeat(64)}`;
const DIGEST_REMOTE = `sha256:${'a'.repeat(64)}`;

const mocks = vi.hoisted(() => ({
    images: vi.fn(),
    legacyImages: vi.fn(),
    builds: vi.fn(),
    labels: vi.fn(),
    compare: vi.fn(),
    inspect: vi.fn(),
}));

vi.mock('../services/NodeRegistry', () => ({
    NodeRegistry: { getInstance: () => ({ getNode: () => ({ id: 1, type: 'local' }) }) },
}));
vi.mock('../services/ImageUpdateService', () => ({
    loadEffectiveServiceImages: mocks.legacyImages,
    loadStackBuildServices: vi.fn().mockResolvedValue([]),
    loadDotEnv: vi.fn(),
    extractServiceImagesFromCompose: vi.fn(),
}));
vi.mock('../services/effectiveServiceModel', () => ({
    // One effective render supplies the image roster, the build services and
    // the labels, exactly as the production preview reads them.
    readEffectiveStackFacts: async () => {
        const images = (await mocks.images()) as Array<{ service: string; image: string }>;
        const builds = (await mocks.builds()) as string[];
        return {
            model: {
                renderable: true,
                services: images.map(({ service, image }) => ({
                    name: service, declaredImage: image, hasBuild: builds.includes(service),
                    expectedReplicas: 1, dependsOn: [], hasHealthcheck: false,
                })),
            },
            labels: await mocks.labels(),
        };
    },
}));
vi.mock('../services/RegistryService', () => ({
    RegistryService: { getInstance: () => ({ getAuthForRegistry: vi.fn().mockResolvedValue(null) }) },
}));
vi.mock('../services/FileSystemService', () => ({ FileSystemService: { getInstance: () => ({}) } }));
vi.mock('../services/DockerController', () => ({
    default: { getInstance: () => ({ getDocker: () => ({ getImage: (ref: string) => ({ inspect: () => mocks.inspect(ref) }) }) }) },
}));
vi.mock('../services/registry-api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/registry-api')>();
    return {
        ...actual,
        compareLocalToRemoteTagDetailed: mocks.compare,
        listRegistryTagsResult: vi.fn().mockResolvedValue({ ok: true, tags: [] }),
        selectLocalRepoDigests: () => [DIGEST_LOCAL],
        configIdForLocalBuild: () => null,
    };
});

import { isAuthoritativeNegativePreview, UpdatePreviewService } from '../services/UpdatePreviewService';

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

beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspect.mockResolvedValue({ RepoDigests: [`shared@${DIGEST_LOCAL}`], Os: 'linux', Architecture: 'amd64' });
    mocks.compare.mockResolvedValue({ kind: 'update', primaryDigest: DIGEST_REMOTE });
    mocks.images.mockResolvedValue([
        { service: 'web', image: 'shared:latest' },
        { service: 'worker', image: 'shared:latest' },
    ]);
    // A root-file fallback roster that disagrees with the effective model, so a
    // test can prove the preview reads the model rather than the old loader.
    mocks.legacyImages.mockResolvedValue([]);
    mocks.builds.mockResolvedValue([]);
    mocks.labels.mockResolvedValue(null);
});

describe('UpdatePreviewService.getPreview with detection labels', () => {
    it('reports the candidate digest of a rebuild and stays as before without labels', async () => {
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        expect(preview.images.map(i => [i.service, i.has_update, i.candidate_digest, i.detection, i.changelog_url]))
            .toEqual([['web', true, DIGEST_REMOTE, undefined, undefined], ['worker', true, DIGEST_REMOTE, undefined, undefined]]);
        expect(mocks.compare).toHaveBeenCalledTimes(1);
    });

    it('applies each service directive to a shared image: one skips, the other reports with its changelog', async () => {
        mocks.labels.mockResolvedValue(labelsFor({
            web: { updateIgnore: [{ kind: 'digest', digest: DIGEST_REMOTE }], updateChangelog: 'https://example.com/web' },
            worker: { updateChangelog: 'https://example.com/worker' },
        }));
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        const web = preview.images.find(i => i.service === 'web')!;
        const worker = preview.images.find(i => i.service === 'worker')!;
        expect(web).toMatchObject({ has_update: false, digest_update: false, detection: 'ignored', check_status: 'ok' });
        expect(web.changelog_url).toBeUndefined();
        expect(worker).toMatchObject({
            has_update: true, candidate_digest: DIGEST_REMOTE, changelog_url: 'https://example.com/worker',
        });
        expect(preview.summary.has_update).toBe(true);
        expect(mocks.compare).toHaveBeenCalledTimes(1);
    });

    it('verifies an image only checks-off services use without reporting its update', async () => {
        mocks.labels.mockResolvedValue(labelsFor({ web: { updateCheck: false }, worker: { updateCheck: false } }));
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        // A whole-stack apply still pulls the image, so the pre-flight probes it.
        expect(mocks.compare).toHaveBeenCalledTimes(1);
        expect(mocks.inspect).toHaveBeenCalledTimes(1);
        for (const image of preview.images) {
            expect(image).toMatchObject({ has_update: false, check_status: 'ok', detection: 'off', current_tag: 'latest' });
        }
        expect(preview.summary.has_update).toBe(false);
        expect(isAuthoritativeNegativePreview(preview)).toBe(false);
    });

    it('keeps a checks-off service off when it shares an image with a service that checks', async () => {
        mocks.labels.mockResolvedValue(labelsFor({ web: {}, worker: { updateCheck: false } }));
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        expect(preview.images.find(i => i.service === 'web')).toMatchObject({ has_update: true });
        expect(preview.images.find(i => i.service === 'worker')).toMatchObject({ has_update: false, detection: 'off' });
        expect(mocks.compare).toHaveBeenCalledTimes(1);
    });

    it('carries the saved ignore entries so a copy can keep them', async () => {
        const saved = `sha256:${'f'.repeat(64)}`;
        mocks.labels.mockResolvedValue(labelsFor({ web: { updateIgnore: [{ kind: 'digest', digest: saved }] } }));
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        expect(preview.images[0]).toMatchObject({ has_update: true, ignore_entries: [saved] });
    });

    it('uses the effective model as one roster, including an included sidecar the root file omits', async () => {
        mocks.labels.mockResolvedValue(labelsFor({ sidecar: { updateCheck: false } }));
        mocks.images.mockResolvedValue([
            { service: 'web', image: 'web:latest' },
            { service: 'sidecar', image: 'sidecar:latest' },
        ]);
        // The old root-file loader sees only web; reading it would lose sidecar.
        mocks.legacyImages.mockResolvedValue([{ service: 'web', image: 'web:latest' }]);
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        expect(preview.images.map(i => i.service)).toEqual(['web', 'sidecar']);
        expect(preview.images.find(i => i.service === 'sidecar')).toMatchObject({
            has_update: false, detection: 'off', check_status: 'ok',
        });
        expect(mocks.compare).toHaveBeenCalledTimes(2);
    });

    it('keeps a build-backed service out of the registry preview but reports the rebuild', async () => {
        mocks.images.mockResolvedValue([
            { service: 'web', image: 'web:latest' },
            { service: 'builder', image: 'builder:latest' },
        ]);
        mocks.builds.mockResolvedValue(['builder']);
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        expect(preview.images.map(i => i.service)).toEqual(['web']);
        expect(preview.build_services).toEqual(['builder']);
        expect(preview.summary.rebuild_available).toBe(true);
        expect(mocks.compare).toHaveBeenCalledTimes(1);
    });

    it('keeps a checks-off sibling\'s failed digest lookup as raw pull evidence', async () => {
        mocks.labels.mockResolvedValue(labelsFor({ web: {}, cache: { updateCheck: false } }));
        mocks.images.mockResolvedValue([
            { service: 'web', image: 'web:latest' },
            { service: 'cache', image: 'cache:latest' },
        ]);
        mocks.inspect.mockImplementation(async (ref: string) => {
            if (ref === 'cache:latest') throw new Error('inspect failed');
            return { RepoDigests: [`web@${DIGEST_LOCAL}`], Os: 'linux', Architecture: 'amd64' };
        });
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        expect(preview.images.find(i => i.service === 'web')).toMatchObject({ has_update: true, check_status: 'ok' });
        expect(preview.images.find(i => i.service === 'cache')).toMatchObject({
            has_update: false, detection: 'off', check_status: 'failed', digest_error: 'Failed to inspect local image',
        });
        expect(preview.summary.check_status).toBe('partial');
    });

    it('never yields an authoritative negative while a checks-off image is present', async () => {
        mocks.compare.mockResolvedValue({ kind: 'match', primaryDigest: DIGEST_LOCAL });
        mocks.labels.mockResolvedValue(labelsFor({ web: {}, worker: { updateCheck: false } }));
        mocks.images.mockResolvedValue([
            { service: 'web', image: 'web:latest' },
            { service: 'worker', image: 'worker:latest' },
        ]);
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        expect(preview.summary.has_update).toBe(false);
        expect(isAuthoritativeNegativePreview(preview)).toBe(false);
    });
});

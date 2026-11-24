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
    labels: vi.fn(),
    compare: vi.fn(),
    inspect: vi.fn(),
}));

vi.mock('../services/NodeRegistry', () => ({
    NodeRegistry: { getInstance: () => ({ getNode: () => ({ id: 1, type: 'local' }) }) },
}));
vi.mock('../services/ImageUpdateService', () => ({
    loadEffectiveServiceImages: mocks.images,
    loadStackBuildServices: vi.fn().mockResolvedValue([]),
    loadDotEnv: vi.fn(),
    extractServiceImagesFromCompose: vi.fn(),
}));
vi.mock('../services/effectiveServiceModel', () => ({
    readEffectiveStackFacts: async () => ({ model: { renderable: true, services: [] }, labels: await mocks.labels() }),
}));
vi.mock('../services/RegistryService', () => ({
    RegistryService: { getInstance: () => ({ getAuthForRegistry: vi.fn().mockResolvedValue(null) }) },
}));
vi.mock('../services/FileSystemService', () => ({ FileSystemService: { getInstance: () => ({}) } }));
vi.mock('../services/DockerController', () => ({
    default: { getInstance: () => ({ getDocker: () => ({ getImage: () => ({ inspect: mocks.inspect }) }) }) },
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

    it('never probes an image only checks-off services use, and shows it as not checked', async () => {
        mocks.labels.mockResolvedValue(labelsFor({ web: { updateCheck: false }, worker: { updateCheck: false } }));
        const preview = await UpdatePreviewService.getInstance().getPreview(1, 'stack');
        expect(mocks.compare).not.toHaveBeenCalled();
        expect(mocks.inspect).not.toHaveBeenCalled();
        for (const image of preview.images) {
            expect(image).toMatchObject({ has_update: false, check_status: 'not_checkable', detection: 'off', current_tag: 'latest' });
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

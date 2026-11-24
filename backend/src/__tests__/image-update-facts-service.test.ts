import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEffectiveServiceModel } from '../services/effectiveServiceModel';
import { collectTargetImageAuthority } from '../services/imageUpdateTargetAuthority';

const docker = vi.hoisted(() => ({
    getAllContainers: vi.fn(),
    getDocker: vi.fn(),
}));
// The label resolution of the same render the model came from.
const labels = vi.hoisted(() => ({ read: vi.fn() }));
import { ImageUpdateFactsService } from '../services/ImageUpdateFactsService';

vi.mock('../services/NodeRegistry', () => ({
    NodeRegistry: { getInstance: () => ({ getNode: () => ({ id: 1, type: 'local' }) }) },
}));
vi.mock('../services/effectiveServiceModel', async () => {
    const build = vi.fn().mockResolvedValue({
        renderable: true,
        services: [{ name: 'web', declaredImage: 'nginx:1.27', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }],
    });
    return {
        buildEffectiveServiceModel: build,
        readEffectiveStackFacts: vi.fn(async (nodeId: number, stack: string) => ({
            model: await build(nodeId, stack),
            labels: await labels.read(nodeId, stack),
        })),
    };
});

/** A rendered label resolution with per-service overrides on the defaults. */
function labelsFor(services: Record<string, Partial<import('../helpers/senchoLabels').SenchoServiceLabels>>) {
    const out: Record<string, import('../helpers/senchoLabels').SenchoServiceLabels> = {};
    for (const [name, overrides] of Object.entries(services)) {
        out[name] = {
            links: [], order: null, hidden: false, update: null, notifyRoute: null,
            updateCheck: true, updateIgnore: [], updateChangelog: null, ...overrides,
        };
    }
    return { renderable: true as const, services: out, entries: [] };
}
vi.mock('../services/imageUpdateTargetAuthority', () => ({
    collectTargetImageAuthority: vi.fn(),
}));
vi.mock('../services/ImageUpdateObservationService', () => ({
    ImageUpdateObservationService: { getInstance: () => ({ issue: () => 'signed-observation' }) },
}));
vi.mock('../services/DockerController', () => ({
    default: { getInstance: () => docker },
}));

beforeEach(() => {
    vi.clearAllMocks();
    ImageUpdateFactsService.resetForTests();
    labels.read.mockResolvedValue(null);
    vi.mocked(collectTargetImageAuthority).mockResolvedValue({ source: 'unchecked', result: null, observedAt: 0 });
    vi.mocked(buildEffectiveServiceModel).mockResolvedValue({
        renderable: true,
        services: [{ name: 'web', declaredImage: 'nginx:1.27', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }],
    });
    docker.getAllContainers.mockResolvedValue([]);
});

it('reads local facts without collecting registry authority', async () => {
    docker.getAllContainers.mockResolvedValue([{
        Image: 'nginx:1.27',
        Labels: { 'com.docker.compose.project': 'site', 'com.docker.compose.service': 'web' },
    }]);
    const inspect = vi.fn().mockResolvedValue({
        RepoDigests: [`nginx@sha256:${'a'.repeat(64)}`], Os: 'linux', Architecture: 'amd64',
    });
    docker.getDocker.mockReturnValue({ getImage: () => ({ inspect }) });

    const facts = await ImageUpdateFactsService.getInstance().readLocal(1, 'site');

    expect(facts).toEqual({
        model: { renderable: true },
        services: [{ name: 'web', declaredImage: 'nginx:1.27', runtimeImages: ['nginx:1.27'], hasBuild: false }],
        images: [{
            ref: 'nginx:1.27', localDigests: [`sha256:${'a'.repeat(64)}`],
            platform: { os: 'linux', architecture: 'amd64' }, emptyReason: 'none',
        }],
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(collectTargetImageAuthority).not.toHaveBeenCalled();
});

it('returns render failure without Docker inspection or registry authority', async () => {
    vi.mocked(buildEffectiveServiceModel).mockResolvedValue({
        renderable: false, code: 'effective_model_render_failed', error: 'Render failed',
    });
    expect(await ImageUpdateFactsService.getInstance().readLocal(1, 'site')).toEqual({
        model: { renderable: false, code: 'effective_model_render_failed', error: 'Render failed' },
        services: [], images: [],
    });
    expect(docker.getAllContainers).not.toHaveBeenCalled();
    expect(docker.getDocker).not.toHaveBeenCalled();
    expect(collectTargetImageAuthority).not.toHaveBeenCalled();
});

it('keeps digest-pinned references immutable without inspecting a substituted tag', async () => {
    const ref = `nginx@sha256:${'b'.repeat(64)}`;
    vi.mocked(buildEffectiveServiceModel).mockResolvedValue({
        renderable: true, services: [{ name: 'web', declaredImage: ref, hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }],
    });
    const facts = await ImageUpdateFactsService.getInstance().readLocal(1, 'site');
    expect(facts.images).toEqual([{ ref, localDigests: [], platform: null, emptyReason: 'not_checkable' }]);
    expect(docker.getDocker).not.toHaveBeenCalled();
    expect(collectTargetImageAuthority).not.toHaveBeenCalled();
});

it('deduplicates shared declared and runtime references before applying the image cap', async () => {
    const services = Array.from({ length: 24 }, (_, i) => ({
        name: `service-${i}`, declaredImage: `nginx:tag-${i}`, hasBuild: false,
        expectedReplicas: 1, dependsOn: [], hasHealthcheck: false,
    }));
    vi.mocked(buildEffectiveServiceModel).mockResolvedValue({ renderable: true, services });
    docker.getAllContainers.mockResolvedValue(services.flatMap(service => [0, 1].map(() => ({
        Image: service.declaredImage,
        Labels: { 'com.docker.compose.project': 'site', 'com.docker.compose.service': service.name },
    }))));
    const inspect = vi.fn().mockResolvedValue({ RepoDigests: [] });
    docker.getDocker.mockReturnValue({ getImage: () => ({ inspect }) });
    const facts = await ImageUpdateFactsService.getInstance().readLocal(1, 'site');
    expect(facts.images).toHaveLength(24);
    expect(inspect).toHaveBeenCalledTimes(24);
});

it('counts distinct runtime references toward the cap before inspecting any image', async () => {
    const services = Array.from({ length: 24 }, (_, i) => ({
        name: `service-${i}`, declaredImage: `nginx:tag-${i}`, hasBuild: false,
        expectedReplicas: 1, dependsOn: [], hasHealthcheck: false,
    }));
    vi.mocked(buildEffectiveServiceModel).mockResolvedValue({ renderable: true, services });
    docker.getAllContainers.mockResolvedValue([{
        Image: 'nginx:previous',
        Labels: { 'com.docker.compose.project': 'site', 'com.docker.compose.service': 'service-0' },
    }]);
    await expect(ImageUpdateFactsService.getInstance().readLocal(1, 'site'))
        .rejects.toMatchObject({ status: 413, code: 'IMAGE_UPDATE_FACTS_IMAGE_LIMIT' });
    expect(docker.getDocker).not.toHaveBeenCalled();
});

it('does not accept digests belonging to a different repository', async () => {
    const inspect = vi.fn().mockResolvedValue({
        RepoDigests: [`redis@sha256:${'a'.repeat(64)}`], Os: 'linux', Architecture: 'amd64',
    });
    docker.getDocker.mockReturnValue({ getImage: () => ({ inspect }) });
    const facts = await ImageUpdateFactsService.getInstance().readLocal(1, 'site');
    expect(facts.images).toEqual([{
        ref: 'nginx:1.27', localDigests: [], platform: { os: 'linux', architecture: 'amd64' },
        emptyReason: 'inspect_failed',
    }]);
});

it('labels a local build self-referential digest as no registry digests, not an inspect failure', async () => {
    const configId = `sha256:${'b'.repeat(64)}`;
    const inspect = vi.fn().mockResolvedValue({
        Id: configId,
        Identity: { Build: [{ Ref: 'buildkit-ref' }] },
        RepoDigests: [`nginx@${configId}`], Os: 'linux', Architecture: 'amd64',
    });
    docker.getDocker.mockReturnValue({ getImage: () => ({ inspect }) });
    const facts = await ImageUpdateFactsService.getInstance().readLocal(1, 'site');
    expect(facts.images).toEqual([{
        ref: 'nginx:1.27', localDigests: [], platform: { os: 'linux', architecture: 'amd64' },
        emptyReason: 'no_repo_digests',
    }]);
});

it('preserves build-only services without inventing an image reference', async () => {
    vi.mocked(buildEffectiveServiceModel).mockResolvedValue({
        renderable: true, services: [{ name: 'builder', declaredImage: null, hasBuild: true, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }],
    });
    expect(await ImageUpdateFactsService.getInstance().readLocal(1, 'site')).toEqual({
        model: { renderable: true },
        services: [{ name: 'builder', declaredImage: null, runtimeImages: [], hasBuild: true }],
        images: [],
    });
    expect(docker.getDocker).not.toHaveBeenCalled();
});

it('carries the unattended decision when the request asks for it, and fails closed when the model cannot render', async () => {
    docker.getDocker.mockReturnValue({ getImage: () => ({ inspect: vi.fn().mockResolvedValue({ RepoDigests: [] }) }) });
    labels.read.mockResolvedValueOnce(labelsFor({ web: { update: 'manual' } }));
    const facts = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32), { includePolicy: true });
    // The decision comes from the render the facts came from: one render, not two.
    expect(labels.read).toHaveBeenCalledTimes(1);
    expect(facts.unattendedPolicy).toEqual({
        decision: 'skip', ineligible: [{ service: 'web', policy: 'manual' }],
    });

    // A model this observation could not render is a definite skip; it is not
    // re-rendered for the policy, so a racing fix cannot disagree with the facts.
    vi.mocked(buildEffectiveServiceModel).mockResolvedValueOnce({
        renderable: false, code: 'effective_model_render_failed', error: 'Render failed',
    });
    const failed = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32), { includePolicy: true });
    expect(failed.unattendedPolicy).toEqual({ decision: 'skip', ineligible: [] });
});

it('omits the unattended decision when the caller did not ask for one', async () => {
    docker.getDocker.mockReturnValue({ getImage: () => ({ inspect: vi.fn().mockResolvedValue({ RepoDigests: [] }) }) });
    const facts = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32));
    expect(facts.unattendedPolicy).toBeUndefined();
    expect(facts).not.toHaveProperty('directives');
});

describe('update detection labels in the facts', () => {
    const LOCAL = `sha256:${'a'.repeat(64)}`;
    const CANDIDATE = `sha256:${'c'.repeat(64)}`;
    const detected = {
        hasUpdate: true, digestUpdate: true, tagUpdate: false, nextTag: '1.27', digestError: null,
        tagEnumKind: 'skipped' as const, tagEnumReason: null, checkStatus: 'ok' as const, reason: null,
        semverBump: 'patch' as const, candidateDigest: CANDIDATE,
    };

    beforeEach(() => {
        vi.mocked(buildEffectiveServiceModel).mockResolvedValue({
            renderable: true,
            services: [
                { name: 'web', declaredImage: 'nginx:1.27', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
                { name: 'cache', declaredImage: 'redis:7', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
            ],
        });
        docker.getDocker.mockReturnValue({ getImage: () => ({
            inspect: vi.fn().mockResolvedValue({ RepoDigests: [`nginx@${LOCAL}`, `redis@${LOCAL}`], Os: 'linux', Architecture: 'amd64' }),
        }) });
        vi.mocked(collectTargetImageAuthority).mockResolvedValue({ source: 'anonymous', result: detected, observedAt: 1 });
        labels.read.mockResolvedValue(labelsFor({
            web: { updateIgnore: [{ kind: 'digest', digest: CANDIDATE }], updateChangelog: 'https://example.com/notes' },
            cache: { updateCheck: false },
        }));
    });

    it('reports non-default directives and keeps the candidate digest when the hub asks', async () => {
        const facts = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32), { detection: true });
        expect(facts.directives).toEqual([
            { service: 'cache', check: false, ignore: [], changelogUrl: null },
            { service: 'web', check: true, ignore: [CANDIDATE], changelogUrl: 'https://example.com/notes' },
        ]);
        const web = facts.images.find(image => image.ref === 'nginx:1.27')!;
        expect(web.authority).toEqual({ source: 'anonymous', result: detected, observedAt: 1 });
        // The image only the checks-off service uses is not sent to the registry.
        const cache = facts.images.find(image => image.ref === 'redis:7')!;
        expect(cache.authority).toEqual({ source: 'unchecked', result: null, observedAt: expect.any(Number) });
        expect(vi.mocked(collectTargetImageAuthority).mock.calls.map(call => call[0].ref)).toEqual(['nginx:1.27']);
    });

    it('probes every image with probeAll, for the pre-flight of an unattended update', async () => {
        const facts = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32), { detection: true, probeAll: true });
        expect(vi.mocked(collectTargetImageAuthority).mock.calls.map(call => call[0].ref).sort()).toEqual(['nginx:1.27', 'redis:7']);
        expect(facts.directives).toHaveLength(2);
    });

    it('answers an older hub with exactly the fields it knows', async () => {
        const facts = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32));
        expect(Object.keys(facts).sort()).toEqual(['images', 'model', 'name', 'observationRevision', 'observationToken', 'services']);
        for (const image of facts.images) {
            expect(image.authority.source).toBe('anonymous');
            expect(Object.keys(image.authority.result ?? {}).sort()).toEqual([
                'checkStatus', 'digestError', 'digestUpdate', 'hasUpdate', 'nextTag', 'reason',
                'semverBump', 'tagEnumKind', 'tagEnumReason', 'tagUpdate',
            ]);
        }
        // Labels never stop a probe the hub did not ask to skip.
        expect(collectTargetImageAuthority).toHaveBeenCalledTimes(2);
    });
});

import { beforeEach, expect, it, vi } from 'vitest';
import { buildEffectiveServiceModel } from '../services/effectiveServiceModel';
import { collectTargetImageAuthority } from '../services/imageUpdateTargetAuthority';

const docker = vi.hoisted(() => ({
    getAllContainers: vi.fn(),
    getDocker: vi.fn(),
}));
const policy = vi.hoisted(() => ({ resolveUpdatePolicyPair: vi.fn() }));
import { ImageUpdateFactsService } from '../services/ImageUpdateFactsService';

vi.mock('../services/NodeRegistry', () => ({
    NodeRegistry: { getInstance: () => ({ getNode: () => ({ id: 1, type: 'local' }) }) },
}));
vi.mock('../services/effectiveServiceModel', () => ({
    buildEffectiveServiceModel: vi.fn().mockResolvedValue({
        renderable: true,
        services: [{ name: 'web', declaredImage: 'nginx:1.27', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }],
    }),
}));
vi.mock('../services/imageUpdateTargetAuthority', () => ({
    collectTargetImageAuthority: vi.fn(),
}));
vi.mock('../services/ImageUpdateObservationService', () => ({
    ImageUpdateObservationService: { getInstance: () => ({ issue: () => 'signed-observation' }) },
}));
vi.mock('../services/updatePolicy', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/updatePolicy')>();
    return { ...actual, resolveUpdatePolicyPair: policy.resolveUpdatePolicyPair };
});
vi.mock('../services/DockerController', () => ({
    default: { getInstance: () => docker },
}));

beforeEach(() => {
    vi.clearAllMocks();
    ImageUpdateFactsService.resetForTests();
    policy.resolveUpdatePolicyPair.mockResolvedValue(null);
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
    policy.resolveUpdatePolicyPair.mockResolvedValueOnce({
        manual: { decision: 'block' },
        unattended: {
            evaluation: 'evaluated', decision: 'skip',
            services: [
                { service: 'web', policy: 'manual', eligible: false, reason: 'set to manual' },
            ],
        },
    });
    const facts = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32), true);
    expect(policy.resolveUpdatePolicyPair).toHaveBeenCalledWith(1, 'site', { scope: 'stack' });
    expect(facts.unattendedPolicy).toEqual({
        decision: 'skip', ineligible: [{ service: 'web', policy: 'manual' }],
    });

    // A model this observation could not render is a definite skip; it is not
    // re-rendered for the policy, so a racing fix cannot disagree with the facts.
    vi.mocked(buildEffectiveServiceModel).mockResolvedValueOnce({
        renderable: false, code: 'effective_model_render_failed', error: 'Render failed',
    });
    const failed = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32), true);
    expect(failed.unattendedPolicy).toEqual({ decision: 'skip', ineligible: [] });
    expect(policy.resolveUpdatePolicyPair).toHaveBeenCalledTimes(1);
});

it('omits the unattended decision when the caller did not ask for one', async () => {
    docker.getDocker.mockReturnValue({ getImage: () => ({ inspect: vi.fn().mockResolvedValue({ RepoDigests: [] }) }) });
    const facts = await ImageUpdateFactsService.getInstance().collect(1, 'site', 'a'.repeat(32));
    expect(facts.unattendedPolicy).toBeUndefined();
    expect(policy.resolveUpdatePolicyPair).not.toHaveBeenCalled();
});

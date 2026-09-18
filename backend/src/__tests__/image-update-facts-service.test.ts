import { beforeEach, expect, it, vi } from 'vitest';
import { buildEffectiveServiceModel } from '../services/effectiveServiceModel';
import { collectTargetImageAuthority } from '../services/imageUpdateTargetAuthority';

const docker = vi.hoisted(() => ({
    getAllContainers: vi.fn(),
    getDocker: vi.fn(),
}));
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
vi.mock('../services/DockerController', () => ({
    default: { getInstance: () => docker },
}));

beforeEach(() => {
    vi.clearAllMocks();
    ImageUpdateFactsService.resetForTests();
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

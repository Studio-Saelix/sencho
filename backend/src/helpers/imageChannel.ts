export type ImageChannel = 'community' | 'hardened' | 'unknown';

const COMMUNITY_REPOSITORIES = new Set([
    'saelix/sencho',
    'ghcr.io/studio-saelix/sencho',
    'ghcr.io/studio-saelix/sencho-dev',
]);

const HARDENED_REPOSITORY = 'ghcr.io/studio-saelix/sencho-hardened';

export function normalizeImageRepository(ref: string): string | null {
    const imageRef = ref.trim().toLowerCase();
    if (!imageRef || /\s/.test(imageRef)) return null;

    const withoutDigest = imageRef.split('@');
    if (withoutDigest.length > 2 || !withoutDigest[0]) return null;

    const repositoryWithTag = withoutDigest[0];
    const lastSlash = repositoryWithTag.lastIndexOf('/');
    const lastColon = repositoryWithTag.lastIndexOf(':');
    const repository = lastColon > lastSlash
        ? repositoryWithTag.slice(0, lastColon)
        : repositoryWithTag;

    if (!repository || repository.startsWith('/') || repository.endsWith('/')) return null;

    if (repository.startsWith('docker.io/')) {
        return repository.slice('docker.io/'.length) || null;
    }
    if (repository.startsWith('index.docker.io/')) {
        return repository.slice('index.docker.io/'.length) || null;
    }

    return repository;
}

export function classifyImageChannel(imageRef: string): ImageChannel {
    const repository = normalizeImageRepository(imageRef);
    if (!repository) return 'unknown';
    if (repository === HARDENED_REPOSITORY) return 'hardened';
    if (COMMUNITY_REPOSITORIES.has(repository)) return 'community';
    return 'unknown';
}

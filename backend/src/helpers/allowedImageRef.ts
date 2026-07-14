import type { RegistryRequirement } from '../services/hardenedEntitlementTypes';

export interface AllowedImageReference {
    registryHost: string;
    repository: string;
    tag?: string;
    digest?: string;
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/i;

export function parseAllowedImageRef(ref: string): AllowedImageReference | null {
    const imageRef = ref.trim();
    if (!imageRef || /\s/.test(imageRef)) return null;

    const [repositoryWithTag, digest, ...extraParts] = imageRef.split('@');
    if (extraParts.length > 0 || !repositoryWithTag) return null;
    if (digest !== undefined && !SHA256_DIGEST.test(digest)) return null;

    const segments = repositoryWithTag.split('/');
    if (segments.length < 2) return null;

    const registryHost = segments.shift();
    if (!registryHost || !isRegistryHost(registryHost)) return null;

    const lastSegment = segments.pop();
    if (!lastSegment) return null;

    const tagIndex = lastSegment.lastIndexOf(':');
    const repositoryLeaf = tagIndex === -1 ? lastSegment : lastSegment.slice(0, tagIndex);
    const tag = tagIndex === -1 ? undefined : lastSegment.slice(tagIndex + 1);
    if (!repositoryLeaf || (tagIndex !== -1 && !tag)) return null;
    if (tag && digest) return null;
    if (!tag && !digest) return null;

    const repository = [...segments, repositoryLeaf].join('/');
    if (!repository || repository.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        return null;
    }

    return { registryHost: registryHost.toLowerCase(), repository: repository.toLowerCase(), tag, digest };
}

export function validateAllowedImageRefAgainstRequirement(
    ref: string,
    requirement: RegistryRequirement,
): boolean {
    const parsed = parseAllowedImageRef(ref);
    if (!parsed) return false;
    return parsed.registryHost === requirement.registry_host.toLowerCase()
        && parsed.repository === requirement.package_scope.toLowerCase();
}

function isRegistryHost(value: string): boolean {
    return value === 'localhost' || value.includes('.') || value.includes(':');
}

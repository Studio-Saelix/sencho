import { RegistryService, type DockerConfigHostResolution } from './RegistryService';
import { parseImageRef } from './registry-api';
import { detectImageUpdate, type ImageUpdateDetectResult } from './imageUpdateDetect';
import type { ImageUpdateAuthority, ImageUpdateLocalFacts } from './imageUpdateFacts';
import { sanitizeForLog } from '../utils/safeLog';

interface TargetAuthorityDeps {
    resolveCredentials: (host: string) => Promise<DockerConfigHostResolution>;
    detect: typeof detectImageUpdate;
}

export function failedImageDetection(reason: string): ImageUpdateDetectResult {
    return {
        hasUpdate: false, digestUpdate: false, tagUpdate: false, nextTag: null,
        digestError: reason, tagEnumKind: 'error', tagEnumReason: reason,
        checkStatus: 'failed', reason, semverBump: 'none',
    };
}

export async function collectTargetImageAuthority(
    image: ImageUpdateLocalFacts,
    deps: TargetAuthorityDeps = {
        resolveCredentials: host => RegistryService.getInstance().resolveDockerConfigForHostDetailed(host),
        detect: detectImageUpdate,
    },
): Promise<ImageUpdateAuthority> {
    const observedAt = Date.now();
    const parsed = image.ref.includes('@') ? null : parseImageRef(image.ref);
    if (!parsed || image.emptyReason !== 'none' || !image.platform) {
        return { source: 'unchecked', result: null, observedAt };
    }
    const credentials = await deps.resolveCredentials(parsed.registry);
    const source = credentials.state === 'missing' ? 'anonymous' : 'target_credential';
    if (credentials.state === 'unavailable' || (credentials.state === 'available' && !credentials.auth)) {
        return { source, result: failedImageDetection('Target registry credentials are unavailable'), observedAt };
    }
    try {
        const result = await deps.detect({
            localDigests: image.localDigests, platform: image.platform,
            registry: parsed.registry, repo: parsed.repo, tag: parsed.tag,
            credentials: credentials.auth ?? null,
        });
        return { source, result, observedAt };
    } catch (error) {
        console.error('[ImageUpdateFacts] Target detection failed for %s:', sanitizeForLog(image.ref), error);
        return { source, result: failedImageDetection('Target image update check failed'), observedAt };
    }
}

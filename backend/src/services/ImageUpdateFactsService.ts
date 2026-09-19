/**
 * Target-side canonical facts for hub-orchestrated image update checks.
 *
 * `readLocal` is the authoritative no-probe snapshot: the effective model (fail
 * closed on render failure, no root-file fallback), the service/runtime
 * mapping from container labels, and one inspected fact entry per deduplicated
 * exact image reference. It backs both the facts endpoint body and the
 * under-lock observation revalidation, so it must never touch the registry.
 *
 * `collect` layers per-image target-credential authority onto `readLocal` and
 * mints the one-use observation token bound to the canonical facts hash.
 */
import DockerController from './DockerController';
import { buildEffectiveServiceModel } from './effectiveServiceModel';
import { collectTargetImageAuthority } from './imageUpdateTargetAuthority';
import {
    hashImageUpdateFacts,
    IMAGE_UPDATE_FACTS_IMAGE_LIMIT,
    type ImageUpdateBoundFacts,
    type ImageUpdateImageFacts,
    type ImageUpdateLocalFacts,
    type ImageUpdateStackFacts,
} from './imageUpdateFacts';
import { ImageUpdateObservationService } from './ImageUpdateObservationService';
import { parseImageRef, selectLocalRepoDigests } from './registry-api';
import { NodeRegistry } from './NodeRegistry';
import { withTimeout } from '../utils/withTimeout';
import { sanitizeForLog } from '../utils/safeLog';

export class ImageUpdateFactsError extends Error {
    constructor(
        readonly code: 'IMAGE_UPDATE_FACTS_IMAGE_LIMIT' | 'IMAGE_UPDATE_FACTS_STACK_LIMIT'
            | 'IMAGE_UPDATE_FACTS_NOT_FOUND' | 'IMAGE_UPDATE_FACTS_IO_FAILED',
        readonly status: 404 | 413 | 500,
        message: string,
    ) {
        super(message);
        this.name = 'ImageUpdateFactsError';
    }
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

export class ImageUpdateFactsService {
    private static instance: ImageUpdateFactsService | null = null;
    private revisionCounter = 0;

    static getInstance(): ImageUpdateFactsService {
        if (!this.instance) this.instance = new ImageUpdateFactsService();
        return this.instance;
    }

    static resetForTests(): void {
        this.instance = null;
    }

    /**
     * Monotonic per-process revision: restart resets it, so outstanding tokens
     * carry a session the target no longer recognizes and fail stale.
     */
    private nextRevision(): number {
        return ++this.revisionCounter;
    }

    /** No-probe canonical snapshot. Safe to call under the stack write lock. */
    async readLocal(nodeId: number, stackName: string): Promise<ImageUpdateBoundFacts> {
        const node = NodeRegistry.getInstance().getNode(nodeId);
        if (!node || node.type !== 'local') {
            throw new ImageUpdateFactsError('IMAGE_UPDATE_FACTS_NOT_FOUND', 404, 'Local node not found');
        }
        const model = await buildEffectiveServiceModel(nodeId, stackName);
        if (!model.renderable) {
            return { model: { renderable: false, code: model.code, error: model.error }, services: [], images: [] };
        }

        const docker = DockerController.getInstance(nodeId);
        let containers: Array<{ Image?: string; Labels?: Record<string, string> }>;
        try {
            containers = await withTimeout(docker.getAllContainers(), 10_000, 'Read image update containers');
        } catch (error) {
            console.error('[ImageUpdateFacts] Container read failed for %s:', sanitizeForLog(stackName), error);
            throw new ImageUpdateFactsError(
                'IMAGE_UPDATE_FACTS_IO_FAILED', 500, 'Failed to read running containers for the stack',
            );
        }

        const runtimeByService = this.runtimeImagesByService(stackName, containers);
        const services = model.services.map(spec => ({
            name: spec.name,
            declaredImage: spec.declaredImage,
            runtimeImages: runtimeByService.get(spec.name) ?? [],
            hasBuild: spec.hasBuild,
        }));

        const refs = new Set<string>();
        for (const spec of model.services) {
            if (spec.declaredImage) refs.add(spec.declaredImage);
            for (const ref of runtimeByService.get(spec.name) ?? []) refs.add(ref);
        }
        if (refs.size > IMAGE_UPDATE_FACTS_IMAGE_LIMIT) {
            throw new ImageUpdateFactsError(
                'IMAGE_UPDATE_FACTS_IMAGE_LIMIT', 413,
                'Stack exceeds the image update facts image reference limit',
            );
        }

        return { model: { renderable: true }, services, images: await this.inspectRefs(docker, [...refs]) };
    }

    async collect(nodeId: number, stackName: string, requestNonce: string): Promise<ImageUpdateStackFacts> {
        const bound = await this.readLocal(nodeId, stackName);
        const observationRevision = this.nextRevision();
        const factsHash = hashImageUpdateFacts(bound);
        const images = await this.probeAuthorities(bound);
        const observationToken = ImageUpdateObservationService.getInstance().issue({
            contractVersion: 1, requestNonce, stack: stackName,
            observationRevision, factsHash,
        });
        return { name: stackName, observationRevision, observationToken, ...bound, images };
    }

    private async probeAuthorities(bound: ImageUpdateBoundFacts): Promise<ImageUpdateImageFacts[]> {
        const probed: ImageUpdateImageFacts[] = [];
        for (const image of bound.images) {
            probed.push({
                ...image,
                authority: await collectTargetImageAuthority(image),
            });
        }
        return probed;
    }

    private runtimeImagesByService(
        stackName: string,
        containers: Array<{ Image?: string; Labels?: Record<string, string> }>,
    ): Map<string, string[]> {
        const out = new Map<string, string[]>();
        for (const c of containers) {
            if (c.Labels?.[COMPOSE_PROJECT_LABEL] !== stackName) continue;
            const service = c.Labels?.[COMPOSE_SERVICE_LABEL];
            const imageRef = c.Image ?? '';
            if (!service || !imageRef || imageRef.startsWith('sha256:')) continue;
            const list = out.get(service) ?? [];
            list.push(imageRef);
            out.set(service, list);
        }
        return out;
    }

    private async inspectRefs(
        docker: DockerController,
        refs: string[],
    ): Promise<ImageUpdateLocalFacts[]> {
        const out: ImageUpdateLocalFacts[] = [];
        for (const ref of refs) {
            // Digest-pinned references are immutable for update detection and
            // must never be probed against a substituted latest tag.
            if (ref.includes('@')) {
                out.push({ ref, localDigests: [], platform: null, emptyReason: 'not_checkable' });
                continue;
            }
            try {
                const inspect = await withTimeout(docker.getDocker().getImage(ref).inspect(), 10_000, 'Inspect image update facts');
                const repoDigests: string[] = inspect.RepoDigests ?? [];
                if (repoDigests.length === 0) {
                    out.push({ ref, localDigests: [], platform: null, emptyReason: 'no_repo_digests' });
                    continue;
                }
                const parsed = parseImageRef(ref);
                const platform = { os: inspect.Os, architecture: inspect.Architecture };
                const localDigests = parsed
                    ? selectLocalRepoDigests(repoDigests, parsed)
                    : repoDigests;
                out.push({
                    ref,
                    localDigests: [...new Set(localDigests)],
                    platform,
                    emptyReason: localDigests.length === 0 ? 'inspect_failed' : 'none',
                });
            } catch (error) {
                console.error('[ImageUpdateFacts] Inspect failed for %s:', ref, error);
                out.push({ ref, localDigests: [], platform: null, emptyReason: 'inspect_failed' });
            }
        }
        return out;
    }
}


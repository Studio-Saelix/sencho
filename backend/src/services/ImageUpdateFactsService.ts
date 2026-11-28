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
import { readEffectiveStackFacts } from './effectiveServiceModel';
import { collectTargetImageAuthority } from './imageUpdateTargetAuthority';
import {
    hashImageUpdateFacts,
    IMAGE_UPDATE_FACTS_IMAGE_LIMIT,
    type ImageUpdateBoundFacts,
    type ImageUpdateDetectWireResult,
    type ImageUpdateImageFacts,
    type ImageUpdateLocalFacts,
    type ImageUpdateStackFacts,
} from './imageUpdateFacts';
import { ImageUpdateObservationService } from './ImageUpdateObservationService';
import { evaluateUpdatePolicyPair, toUnattendedStatusPolicy } from './updatePolicy';
import {
    checkableRefsForStack,
    directivesFromResolution,
    directivesToFacts,
    NO_DETECTION_DIRECTIVES,
    uncheckedRefs,
    type DetectionDirectives,
} from './updateDetectionDirectives';
import type { SenchoLabelResolution } from '../helpers/senchoLabels';
import { configIdForLocalBuild, parseImageRef, selectLocalRepoDigests } from './registry-api';
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

/** What a hub asked the facts for, beyond the canonical evidence. */
export interface ImageUpdateFactsOptions {
    /** The unattended decision (`io.sencho.update`). */
    includePolicy?: boolean;
    /** The update detection labels, and the candidate digest on each result. */
    detection?: boolean;
    /**
     * Probe every image, including those only checks-off services use. Sent for
     * the pre-flight of an unattended update, which verifies every image it
     * would pull. Meaningful only with `detection`.
     */
    probeAll?: boolean;
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/** Legacy response shape: the candidate digest exists only when detection was requested. */
function stripCandidateDigest(result: ImageUpdateDetectWireResult): ImageUpdateDetectWireResult {
    const { candidateDigest: _projected, ...rest } = result;
    return rest;
}

function projectLegacyImage(image: ImageUpdateImageFacts): ImageUpdateImageFacts {
    if (image.authority.source === 'unchecked') return image;
    return {
        ...image,
        authority: {
            source: image.authority.source,
            result: stripCandidateDigest(image.authority.result),
            observedAt: image.authority.observedAt,
        },
    };
}

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
        return (await this.readLocalWithLabels(nodeId, stackName)).bound;
    }

    /** The canonical snapshot and the label resolution of the same render. */
    private async readLocalWithLabels(
        nodeId: number,
        stackName: string,
    ): Promise<{ bound: ImageUpdateBoundFacts; labels: SenchoLabelResolution | null; directives: DetectionDirectives }> {
        const node = NodeRegistry.getInstance().getNode(nodeId);
        if (!node || node.type !== 'local') {
            throw new ImageUpdateFactsError('IMAGE_UPDATE_FACTS_NOT_FOUND', 404, 'Local node not found');
        }
        const { model, labels } = await readEffectiveStackFacts(nodeId, stackName);
        if (!model.renderable) {
            return {
                bound: { model: { renderable: false, code: model.code, error: model.error }, services: [], images: [] },
                labels: null,
                directives: NO_DETECTION_DIRECTIVES,
            };
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

        const directives = directivesFromResolution(labels);
        const directiveFacts = directivesToFacts(directives).filter(entry =>
            model.services.some(service => service.name === entry.service));
        return {
            bound: {
                model: { renderable: true },
                services,
                images: await this.inspectRefs(docker, [...refs]),
                // Part of the canonical evidence hash: a label-only edit between
                // observation and execution makes the observation stale.
                ...(directiveFacts.length > 0 ? { directives: directiveFacts } : {}),
            },
            labels,
            directives,
        };
    }

    async collect(
        nodeId: number,
        stackName: string,
        requestNonce: string,
        options: ImageUpdateFactsOptions = {},
    ): Promise<ImageUpdateStackFacts> {
        const { bound, labels, directives } = await this.readLocalWithLabels(nodeId, stackName);
        const observationRevision = this.nextRevision();
        const factsHash = hashImageUpdateFacts(bound);
        const unchecked = options.detection && !options.probeAll
            ? uncheckedRefs(bound.services.map(service => ({
                name: service.name,
                refs: [...(service.declaredImage ? [service.declaredImage] : []), ...service.runtimeImages],
            })), directives)
            : new Set<string>();
        const probed = await this.probeAuthorities(bound, unchecked);
        // Bind the refs the current labels leave reportable. The candidate
        // digest is checked under the lock, so a hub with registry credentials
        // is not refused just because this target's probe was anonymous.
        const triggerRefs = checkableRefsForStack(bound.services, directives);
        // The candidate digest is projected out unless the hub asked for
        // detection, so an older hub's strict parser never sees a key it does not know.
        const images = options.detection ? probed : probed.map(projectLegacyImage);
        const observationToken = ImageUpdateObservationService.getInstance().issue({
            contractVersion: 1, requestNonce, stack: stackName,
            observationRevision, factsHash, triggerRefs,
        });
        // The decision is evaluated here, where the Compose model lives, so the
        // hub records the same answer an unattended run on this node takes. A
        // model this observation could not render is already a definite skip;
        // re-rendering it would let a racing file change disagree with the
        // facts the hub is about to record.
        // It comes from the same render as the facts, so the decision and the
        // evidence cannot describe two different files.
        const unattendedPolicy = options.includePolicy
            ? (bound.model.renderable
                ? toUnattendedStatusPolicy(evaluateUpdatePolicyPair(labels, stackName, { scope: 'stack' }))
                : { decision: 'skip' as const, ineligible: [] })
            : undefined;
        const known = new Set(bound.services.map(service => service.name));
        // `bound.directives` is binding evidence only; the response carries the
        // field solely when the request asked for detection, so a legacy parser
        // never sees a key it does not know.
        const { directives: _bindingDirectives, ...boundFacts } = bound;
        return {
            name: stackName, observationRevision, observationToken, ...boundFacts, images,
            ...(unattendedPolicy ? { unattendedPolicy } : {}),
            ...(options.detection
                ? { directives: directivesToFacts(directives).filter(entry => known.has(entry.service)) }
                : {}),
        };
    }

    /**
     * Target-credential authority per image. A ref only checks-off services use
     * is left unchecked without a registry request. The result keeps the
     * candidate digest here because the observation binds the trigger decision;
     * `collect` projects it out for a legacy response.
     */
    private async probeAuthorities(
        bound: ImageUpdateBoundFacts,
        unchecked: ReadonlySet<string>,
    ): Promise<ImageUpdateImageFacts[]> {
        const probed: ImageUpdateImageFacts[] = [];
        for (const image of bound.images) {
            if (unchecked.has(image.ref)) {
                probed.push({ ...image, authority: { source: 'unchecked', result: null, observedAt: Date.now() } });
                continue;
            }
            probed.push({ ...image, authority: await collectTargetImageAuthority(image) });
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
                const configId = parsed ? configIdForLocalBuild(inspect) : null;
                const selfReferential = configId !== null && repoDigests.some((entry) => {
                    const at = entry.indexOf('@');
                    return at !== -1 && entry.slice(at + 1).toLowerCase() === configId.toLowerCase();
                });
                const localDigests = parsed
                    ? selectLocalRepoDigests(repoDigests, parsed, configId)
                    : repoDigests;
                out.push({
                    ref,
                    localDigests: [...new Set(localDigests)],
                    platform,
                    // A local build has no registry digests; that is not an
                    // inspect failure, unlike a present but unrelated digest.
                    emptyReason: localDigests.length === 0
                        ? (selfReferential ? 'no_repo_digests' : 'inspect_failed')
                        : 'none',
                });
            } catch (error) {
                console.error('[ImageUpdateFacts] Inspect failed for %s:', ref, error);
                out.push({ ref, localDigests: [], platform: null, emptyReason: 'inspect_failed' });
            }
        }
        return out;
    }
}


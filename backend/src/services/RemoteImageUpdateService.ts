import {
    fetchRemoteImageUpdateFacts,
    fetchRemoteImageUpdateRoster,
    type RemoteImageUpdateFactsOptions,
} from './remoteImageUpdateClient';
import { probeRemoteImageUpdate } from './remoteImageUpdateProbe';
import { mergeImageUpdateAuthority } from './imageUpdateAuthority';
import { ImageUpdateService, UPDATE_VERIFICATION_INCOMPLETE_WARNING, type ImageCheckResult } from './ImageUpdateService';
import type { RemoteAutoUpdateScanner } from './AutoUpdateRemoteCoordinator';
import type { ImageUpdateImageFacts, ImageUpdateStackFacts } from './imageUpdateFacts';
import { DatabaseService } from './DatabaseService';
import { buildSummary, servicePreviewImage, type UpdatePreviewImage } from './UpdatePreviewService';
import type { ImageUpdateDetectResult } from './imageUpdateDetect';
import {
    checkResultFromDetection,
    directiveFor,
    directivesFromFacts,
    uncheckedRefs,
} from './updateDetectionDirectives';
import { parseImageRef } from './registry-api';
import { probeRemoteCapability } from '../helpers/remoteCapabilities';
import { SENCHO_LABEL_DETECTION_CAPABILITY, SENCHO_LABEL_POLICY_CAPABILITY } from '../helpers/senchoLabels';

const NOT_CHECKED: ImageCheckResult = { hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true };

/**
 * The refs the hub does not probe: those only checks-off services use, as the
 * target reported. None unless the request asked for detection without
 * `probeAll`, because an unattended pre-flight verifies every image.
 */
function hubUncheckedRefs(facts: ImageUpdateStackFacts, options: RemoteImageUpdateFactsOptions | undefined): Set<string> {
    if (!options?.detection || options.probeAll) return new Set();
    return uncheckedRefs(facts.services.map(service => ({
        name: service.name,
        refs: [...(service.declaredImage ? [service.declaredImage] : []), ...service.runtimeImages],
    })), directivesFromFacts(facts));
}

export class RemoteImageUpdateService implements RemoteAutoUpdateScanner {
    private static instance: RemoteImageUpdateService;

    public static getInstance(): RemoteImageUpdateService {
        if (!this.instance) this.instance = new RemoteImageUpdateService();
        return this.instance;
    }

    public getRemoteRoster(nodeId: number, signal: AbortSignal): Promise<string[]> {
        return fetchRemoteImageUpdateRoster(nodeId, signal);
    }

    public async inspectRemoteStack(
        nodeId: number,
        stack: string,
        signal: AbortSignal,
        options?: RemoteImageUpdateFactsOptions,
    ) {
        const facts = await fetchRemoteImageUpdateFacts(nodeId, stack, signal, options);
        const unchecked = hubUncheckedRefs(facts, options);
        const imageResults = new Map<string, ImageCheckResult>();
        let next = 0;
        const worker = async () => {
            while (next < facts.images.length) {
                signal.throwIfAborted();
                const image = facts.images[next++];
                imageResults.set(image.ref, unchecked.has(image.ref) ? NOT_CHECKED : await this.checkImage(image, signal));
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, facts.images.length) }, worker));
        signal.throwIfAborted();
        return { facts, imageResults };
    }

    public async getPreview(nodeId: number, stack: string, signal: AbortSignal) {
        // A failed metadata probe is not an older target. Treating it as one
        // would drop the labels and overwrite a capable target's suppression.
        const detection = await this.detectionCapability(nodeId);
        if (detection.kind === 'unreachable') {
            throw new Error('Target metadata is unavailable; update status was not refreshed');
        }
        // The preview verifies every image a whole-stack apply would pull,
        // including one only checks-off services use.
        const options = detection.kind === 'supported'
            ? { detection: true, probeAll: true }
            : { detection: false };
        const facts = await fetchRemoteImageUpdateFacts(nodeId, stack, signal, options);
        if (!facts.model.renderable) throw new Error(facts.model.error);
        const directives = directivesFromFacts(facts);
        const unchecked = hubUncheckedRefs(facts, options);
        const previewServices = facts.services.filter(service => !service.hasBuild);
        const previewRefs = new Set(previewServices.flatMap(service =>
            [...new Set([service.declaredImage, ...service.runtimeImages].filter((ref): ref is string => ref !== null))]));
        const imagesToProbe = facts.images.filter(image => previewRefs.has(image.ref));
        const previews = new Map<string, { preview: UpdatePreviewImage; detected: ImageUpdateDetectResult | null }>();
        let next = 0;
        const worker = async () => {
            while (next < imagesToProbe.length) {
                signal.throwIfAborted();
                const image = imagesToProbe[next++];
                const notCheckable = image.ref.includes('@') || image.emptyReason === 'not_checkable' || unchecked.has(image.ref);
                const result = notCheckable ? null : await this.detectImage(image, signal);
                previews.set(image.ref, { detected: result, preview: {
                    service: '', image: image.ref, current_tag: parseImageRef(image.ref)?.tag ?? 'unknown',
                    next_tag: result?.nextTag ?? null, has_update: result?.hasUpdate ?? false,
                    digest_update: result?.digestUpdate ?? false, tag_update: result?.tagUpdate ?? false,
                    semver_bump: result?.semverBump ?? 'none',
                    check_status: notCheckable ? 'not_checkable' : result?.checkStatus ?? 'failed',
                    check_error: notCheckable ? null : result?.reason ?? (result ? null : 'Update check incomplete'),
                    digest_error: notCheckable ? null : result?.digestError ?? (result ? null : 'Update check incomplete'),
                    candidate_digest: result?.digestUpdate ? result.candidateDigest : null,
                } });
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, facts.images.length) }, worker));
        signal.throwIfAborted();
        // A build-backed service is built, not pulled, so its registry image is
        // not part of the update operation.
        const images = facts.services.filter(service => !service.hasBuild).flatMap(service => {
            const refs = [...new Set([service.declaredImage, ...service.runtimeImages].filter((ref): ref is string => ref !== null))];
            return refs.map(ref => {
                const entry = previews.get(ref);
                if (!entry) throw new Error('Remote preview is missing image evidence');
                // The rule runs after the authority merge, whichever side won it.
                return servicePreviewImage(service.name, entry.preview, entry.detected, directiveFor(directives, service.name));
            });
        });
        return buildSummary(stack, images, facts.services.filter(service => service.hasBuild).map(service => service.name));
    }

    private async detectImage(image: ImageUpdateImageFacts, signal: AbortSignal) {
        const hub = image.authority.source === 'target_credential' ? null : await probeRemoteImageUpdate(image, signal);
        return mergeImageUpdateAuthority(image.authority, hub);
    }

    private async checkImage(image: ImageUpdateImageFacts, signal: AbortSignal): Promise<ImageCheckResult> {
        if (image.ref.includes('@') || image.emptyReason === 'not_checkable') {
            return { hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true };
        }
        const result = await this.detectImage(image, signal);
        if (!result) return { hasUpdate: false, checkStatus: 'failed', error: 'Update check incomplete' };
        return checkResultFromDetection(result);
    }

    public async recheckRemoteStack(
        nodeId: number,
        stack: string,
        signal: AbortSignal,
        options: { verification?: boolean } = {},
    ) {
        const owner = ImageUpdateService.getInstance();
        if (!ImageUpdateService.isChecksEnabled()) return { warning: UPDATE_VERIFICATION_INCOMPLETE_WARNING };
        const generation = owner.reserveStackWriteGeneration(nodeId, stack);
        const scanOptions = await this.scanOptions(nodeId);
        // Verification reads every image the operation would pull, whatever
        // the reporting labels project.
        const factsOptions = options.verification && scanOptions.detection
            ? { ...scanOptions, probeAll: true }
            : scanOptions;
        const { facts, imageResults } = await this.inspectRemoteStack(nodeId, stack, signal, factsOptions);
        signal.throwIfAborted();
        return owner.commitRemoteObservation(
            nodeId, facts, imageResults, generation,
            ...(options.verification ? [options] : []),
        );
    }

    public async checkRemoteNode(nodeId: number, manual = false): Promise<boolean> {
        const owner = ImageUpdateService.getInstance();
        return owner.runRemoteScan(nodeId, manual, async () => {
            const known = Object.keys(DatabaseService.getInstance().getStackUpdateDetail(nodeId));
            const failureGenerations = new Map(known.map(stack => [stack, owner.reserveStackWriteGeneration(nodeId, stack)]));
            let options: RemoteImageUpdateFactsOptions;
            try {
                options = await this.scanOptions(nodeId);
            } catch (error) {
                for (const [stack, generation] of failureGenerations) {
                    await owner.recordRemoteCheckFailure(nodeId, stack, generation);
                }
                throw error;
            }
            let stacks: string[];
            try {
                stacks = await this.getRemoteRoster(nodeId, AbortSignal.timeout(90_000));
            } catch (error) {
                for (const [stack, generation] of failureGenerations) {
                    await owner.recordRemoteCheckFailure(nodeId, stack, generation);
                }
                throw error;
            }
            const generations = new Map(stacks.map(stack => [stack, owner.reserveStackWriteGeneration(nodeId, stack)]));
            for (const stack of stacks) {
                try {
                    const signal = AbortSignal.timeout(90_000);
                    const { facts, imageResults } = await this.inspectRemoteStack(nodeId, stack, signal, options);
                    signal.throwIfAborted();
                    await owner.commitRemoteObservation(nodeId, facts, imageResults, generations.get(stack)!);
                } catch (error) {
                    console.error('[RemoteImageUpdateService] Stack check failed:', error);
                    await owner.recordRemoteCheckFailure(nodeId, stack, generations.get(stack)!);
                }
            }
        });
    }

    /**
     * The facts a hub-run scan asks for: whatever the target can evaluate. A
     * metadata probe that did not answer is not a legacy target; the caller
     * records a failed check instead of overwriting filtered evidence.
     */
    private async scanOptions(nodeId: number): Promise<RemoteImageUpdateFactsOptions> {
        const [includePolicy, detection] = await Promise.all([
            this.targetEvaluatesPolicy(nodeId),
            this.detectionCapability(nodeId),
        ]);
        if (detection.kind === 'unreachable') {
            throw new Error('Target metadata is unavailable; update status was not refreshed');
        }
        return { includePolicy, detection: detection.kind === 'supported' };
    }

    /** Whether the target evaluates the update detection labels, is older, or did not answer. */
    public async detectionCapability(nodeId: number) {
        return probeRemoteCapability(nodeId, SENCHO_LABEL_DETECTION_CAPABILITY);
    }

    /**
     * Whether the target can evaluate `io.sencho.update`. An older target cannot,
     * so the facts request omits the policy and its rows keep the last decision
     * instead of the hub guessing one from its own filesystem.
     */
    private async targetEvaluatesPolicy(nodeId: number): Promise<boolean> {
        const capability = await probeRemoteCapability(nodeId, SENCHO_LABEL_POLICY_CAPABILITY);
        return capability.kind === 'supported';
    }
}

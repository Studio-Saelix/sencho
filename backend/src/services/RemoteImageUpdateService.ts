import { fetchRemoteImageUpdateFacts, fetchRemoteImageUpdateRoster } from './remoteImageUpdateClient';
import { probeRemoteImageUpdate } from './remoteImageUpdateProbe';
import { mergeImageUpdateAuthority } from './imageUpdateAuthority';
import { ImageUpdateService, UPDATE_VERIFICATION_INCOMPLETE_WARNING, type ImageCheckResult } from './ImageUpdateService';
import type { RemoteAutoUpdateScanner } from './AutoUpdateRemoteCoordinator';
import type { ImageUpdateImageFacts } from './imageUpdateFacts';
import { DatabaseService } from './DatabaseService';
import { buildSummary, type UpdatePreviewImage } from './UpdatePreviewService';
import { parseImageRef } from './registry-api';

export class RemoteImageUpdateService implements RemoteAutoUpdateScanner {
    private static instance: RemoteImageUpdateService;

    public static getInstance(): RemoteImageUpdateService {
        if (!this.instance) this.instance = new RemoteImageUpdateService();
        return this.instance;
    }

    public getRemoteRoster(nodeId: number, signal: AbortSignal): Promise<string[]> {
        return fetchRemoteImageUpdateRoster(nodeId, signal);
    }

    public async inspectRemoteStack(nodeId: number, stack: string, signal: AbortSignal) {
        const facts = await fetchRemoteImageUpdateFacts(nodeId, stack, signal);
        const imageResults = new Map<string, ImageCheckResult>();
        let next = 0;
        const worker = async () => {
            while (next < facts.images.length) {
                signal.throwIfAborted();
                const image = facts.images[next++];
                imageResults.set(image.ref, await this.checkImage(image, signal));
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, facts.images.length) }, worker));
        signal.throwIfAborted();
        return { facts, imageResults };
    }

    public async getPreview(nodeId: number, stack: string, signal: AbortSignal) {
        const facts = await fetchRemoteImageUpdateFacts(nodeId, stack, signal);
        if (!facts.model.renderable) throw new Error(facts.model.error);
        const previews = new Map<string, UpdatePreviewImage>();
        let next = 0;
        const worker = async () => {
            while (next < facts.images.length) {
                signal.throwIfAborted();
                const image = facts.images[next++];
                const notCheckable = image.ref.includes('@') || image.emptyReason === 'not_checkable';
                const result = notCheckable ? null : await this.detectImage(image, signal);
                previews.set(image.ref, {
                    service: '', image: image.ref, current_tag: parseImageRef(image.ref)?.tag ?? 'unknown',
                    next_tag: result?.nextTag ?? null, has_update: result?.hasUpdate ?? false,
                    digest_update: result?.digestUpdate ?? false, tag_update: result?.tagUpdate ?? false,
                    semver_bump: result?.semverBump ?? 'none',
                    check_status: notCheckable ? 'not_checkable' : result?.checkStatus ?? 'failed',
                    check_error: notCheckable ? null : result?.reason ?? (result ? null : 'Update check incomplete'),
                    digest_error: notCheckable ? null : result?.digestError ?? (result ? null : 'Update check incomplete'),
                });
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, facts.images.length) }, worker));
        signal.throwIfAborted();
        const images = facts.services.flatMap(service => {
            const refs = [...new Set([service.declaredImage, ...service.runtimeImages].filter((ref): ref is string => ref !== null))];
            return refs.map(ref => {
                const preview = previews.get(ref);
                if (!preview) throw new Error('Remote preview is missing image evidence');
                return { ...preview, service: service.name };
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
        return {
            hasUpdate: result.hasUpdate, digestUpdate: result.digestUpdate, tagUpdate: result.tagUpdate,
            checkStatus: result.checkStatus, ...(result.reason ? { error: result.reason } : {}),
        };
    }

    public async recheckRemoteStack(nodeId: number, stack: string, signal: AbortSignal) {
        const owner = ImageUpdateService.getInstance();
        if (!ImageUpdateService.isChecksEnabled()) return { warning: UPDATE_VERIFICATION_INCOMPLETE_WARNING };
        const generation = owner.reserveStackWriteGeneration(nodeId, stack);
        const { facts, imageResults } = await this.inspectRemoteStack(nodeId, stack, signal);
        signal.throwIfAborted();
        return owner.commitRemoteObservation(nodeId, facts, imageResults, generation);
    }

    public async checkRemoteNode(nodeId: number, manual = false): Promise<boolean> {
        const owner = ImageUpdateService.getInstance();
        return owner.runRemoteScan(nodeId, manual, async () => {
            const known = Object.keys(DatabaseService.getInstance().getStackUpdateDetail(nodeId));
            const failureGenerations = new Map(known.map(stack => [stack, owner.reserveStackWriteGeneration(nodeId, stack)]));
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
                    const { facts, imageResults } = await this.inspectRemoteStack(nodeId, stack, signal);
                    signal.throwIfAborted();
                    await owner.commitRemoteObservation(nodeId, facts, imageResults, generations.get(stack)!);
                } catch (error) {
                    console.error('[RemoteImageUpdateService] Stack check failed:', error);
                    await owner.recordRemoteCheckFailure(nodeId, stack, generations.get(stack)!);
                }
            }
        });
    }
}

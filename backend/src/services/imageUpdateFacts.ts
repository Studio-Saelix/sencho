import { createHash } from 'crypto';
import type { ImageUpdateDetectResult } from './imageUpdateDetect';

export const IMAGE_UPDATE_FACTS_VERSION = 1;
export const IMAGE_UPDATE_FACTS_IMAGE_LIMIT = 24;
export const IMAGE_UPDATE_FACTS_STACK_LIMIT = 500;
export const IMAGE_UPDATE_FACTS_BYTE_LIMIT = 1024 * 1024;

export type ImageUpdateDetectWireResult = ImageUpdateDetectResult;
export type ImageUpdateFactsModel = { renderable: true }
    | { renderable: false; code: 'effective_model_render_failed'; error: string };

export interface ImageUpdateServiceFacts {
    name: string;
    declaredImage: string | null;
    runtimeImages: string[];
    hasBuild: boolean;
}

export interface ImageUpdateLocalFacts {
    ref: string;
    localDigests: string[];
    platform: { os: string; architecture: string } | null;
    emptyReason: 'none' | 'no_repo_digests' | 'inspect_failed' | 'not_checkable';
}

export type ImageUpdateAuthority =
    | { source: 'target_credential' | 'anonymous'; result: ImageUpdateDetectWireResult; observedAt: number }
    | { source: 'unchecked'; result: null; observedAt: number };

export interface ImageUpdateImageFacts extends ImageUpdateLocalFacts {
    authority: ImageUpdateAuthority;
}

export interface ImageUpdateBoundFacts {
    model: ImageUpdateFactsModel;
    services: ImageUpdateServiceFacts[];
    images: ImageUpdateLocalFacts[];
}

export interface ImageUpdateStackFacts extends ImageUpdateBoundFacts {
    name: string;
    observationRevision: number;
    observationToken: string;
    images: ImageUpdateImageFacts[];
}

export interface ImageUpdateFactsResponse {
    contractVersion: 1;
    requestNonce: string;
    stacks: ImageUpdateStackFacts[];
}

/** Canonical local evidence only; registry results and observation times are not binding inputs. */
export function hashImageUpdateFacts(facts: ImageUpdateBoundFacts): string {
    const model = facts.model.renderable ? { renderable: true } : {
        renderable: false, code: facts.model.code, error: facts.model.error,
    };
    const services = facts.services.map(service => ({
        name: service.name,
        declaredImage: service.declaredImage,
        runtimeImages: [...new Set(service.runtimeImages)].sort(),
        hasBuild: service.hasBuild,
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const images = facts.images.map(image => ({
        ref: image.ref,
        localDigests: [...new Set(image.localDigests)].sort(),
        platform: image.platform ? { os: image.platform.os, architecture: image.platform.architecture } : null,
        emptyReason: image.emptyReason,
    })).sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
    return createHash('sha256').update(JSON.stringify({ model, services, images })).digest('hex');
}

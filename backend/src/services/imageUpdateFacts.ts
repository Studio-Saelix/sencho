import { createHash } from 'crypto';
import type { ImageUpdateDetectResult } from './imageUpdateDetect';

export const IMAGE_UPDATE_FACTS_VERSION = 1;
export const IMAGE_UPDATE_FACTS_IMAGE_LIMIT = 24;
export const IMAGE_UPDATE_FACTS_STACK_LIMIT = 500;
export const IMAGE_UPDATE_FACTS_BYTE_LIMIT = 1024 * 1024;
/**
 * The observation token binds the trigger refs, up to the image limit. The
 * ceiling stays below the checked request's 64 KB delivery budget so a long
 * but legitimate ref list is not rejected by the body limit.
 */
export const IMAGE_UPDATE_OBSERVATION_TOKEN_LIMIT = 48 * 1024;

/**
 * A detection result on the wire. `candidateDigest` is sent only when the hub
 * asked for detection directives: an older hub's strict parser rejects a key it
 * does not know.
 */
export type ImageUpdateDetectWireResult = Omit<ImageUpdateDetectResult, 'candidateDigest'> & {
    candidateDigest?: string | null;
};
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
    /**
     * The detection directives of the same render. Part of the canonical
     * evidence hash, so a label-only edit between observation and execution
     * makes the observation stale. Absent when every service is at its default.
     */
    directives?: ImageUpdateDirectiveFacts[];
}

export interface ImageUpdateStackFacts extends ImageUpdateBoundFacts {
    name: string;
    observationRevision: number;
    observationToken: string;
    images: ImageUpdateImageFacts[];
    /**
     * The target's unattended decision for this stack, present only when the
     * request asked for it and the target evaluates the label (the capability
     * gate is the caller's). Absent means "not evaluated here", so the reader
     * keeps the last decision it recorded rather than assuming allow.
     */
    unattendedPolicy?: ImageUpdateUnattendedPolicyFacts;
    /**
     * The update detection labels evaluated on the node that owns the stack,
     * one entry per service with a non-default directive. Present only when
     * the request asked for detection.
     */
    directives?: ImageUpdateDirectiveFacts[];
}

/** One service's update detection labels, as the owning node resolved them. */
export interface ImageUpdateDirectiveFacts {
    service: string;
    check: boolean;
    /** Digest (`sha256:...`, lowercase) or tag entries. */
    ignore: string[];
    changelogUrl: string | null;
}

/** The Updates-view projection of the unattended decision, evaluated on the node that owns the stack. */
export interface ImageUpdateUnattendedPolicyFacts {
    decision: 'allow' | 'skip';
    ineligible: { service: string; policy: string }[];
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
    const directives = (facts.directives ?? [])
        .map(entry => ({
            service: entry.service, check: entry.check, ignore: [...entry.ignore], changelogUrl: entry.changelogUrl,
        }))
        .sort((a, b) => a.service < b.service ? -1 : a.service > b.service ? 1 : 0);
    return createHash('sha256').update(JSON.stringify({ model, services, images, directives })).digest('hex');
}

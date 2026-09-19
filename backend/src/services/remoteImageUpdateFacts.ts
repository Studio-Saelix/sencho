import { z } from 'zod';
import { isValidStackName } from '../utils/validation';
import {
    IMAGE_UPDATE_FACTS_IMAGE_LIMIT, IMAGE_UPDATE_FACTS_STACK_LIMIT,
    type ImageUpdateFactsResponse,
} from './imageUpdateFacts';

const text = z.string().min(1).max(2048);
const stackName = text.refine(isValidStackName);
const reason = z.string().max(8192).nullable();
const detection = z.object({
    hasUpdate: z.boolean(), digestUpdate: z.boolean(), tagUpdate: z.boolean(),
    nextTag: text.nullable(), digestError: reason,
    tagEnumKind: z.enum(['complete', 'incomplete', 'error', 'skipped']),
    tagEnumReason: reason, checkStatus: z.enum(['ok', 'partial', 'failed', 'not_checkable']),
    reason, semverBump: z.enum(['none', 'patch', 'minor', 'major', 'unknown']),
}).strict().refine(value => value.hasUpdate === (value.digestUpdate || value.tagUpdate));
const timestamp = z.number().finite().nonnegative();
const authority = z.discriminatedUnion('source', [
    z.object({ source: z.literal('target_credential'), result: detection, observedAt: timestamp }).strict(),
    z.object({ source: z.literal('anonymous'), result: detection, observedAt: timestamp }).strict(),
    z.object({ source: z.literal('unchecked'), result: z.null(), observedAt: timestamp }).strict(),
]);
const model = z.discriminatedUnion('renderable', [
    z.object({ renderable: z.literal(true) }).strict(),
    z.object({ renderable: z.literal(false), code: z.literal('effective_model_render_failed'), error: z.string().max(8192) }).strict(),
]);
const service = z.object({
    name: text, declaredImage: text.nullable(), runtimeImages: z.array(text).max(IMAGE_UPDATE_FACTS_IMAGE_LIMIT),
    hasBuild: z.boolean(),
}).strict();
const image = z.object({
    ref: text, localDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(256),
    platform: z.object({ os: text, architecture: text }).strict().nullable(),
    emptyReason: z.enum(['none', 'no_repo_digests', 'inspect_failed', 'not_checkable']),
    authority,
}).strict();
const stack = z.object({
    name: stackName, observationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observationToken: z.string().min(1).max(4096), model,
    services: z.array(service), images: z.array(image).max(IMAGE_UPDATE_FACTS_IMAGE_LIMIT),
}).strict().superRefine((value, context) => {
    const refs = new Set(value.images.map(entry => entry.ref));
    const names = new Set(value.services.map(entry => entry.name));
    const used = new Set(value.services.flatMap(entry => [
        ...(entry.declaredImage ? [entry.declaredImage] : []), ...entry.runtimeImages,
    ]));
    if (refs.size !== value.images.length || names.size !== value.services.length
        || [...used].some(ref => !refs.has(ref)) || [...refs].some(ref => !used.has(ref))
        || (!value.model.renderable && (value.services.length > 0 || value.images.length > 0))) {
        context.addIssue({ code: 'custom', message: 'Incomplete or duplicate image evidence' });
    }
});
const envelope = {
    contractVersion: z.literal(1), requestNonce: z.string().regex(/^[a-f0-9]{32,128}$/),
};
const facts = z.object({ ...envelope, stacks: z.array(stack).max(IMAGE_UPDATE_FACTS_STACK_LIMIT) }).strict();
const roster = z.object({ ...envelope, stacks: z.array(stackName).max(IMAGE_UPDATE_FACTS_STACK_LIMIT) }).strict();

export function parseRemoteImageUpdateFacts(value: unknown, nonce: string, expectedStack?: string): ImageUpdateFactsResponse {
    const parsed = facts.safeParse(value);
    if (!parsed.success || parsed.data.requestNonce !== nonce
        || new Set(parsed.data.stacks.map(entry => entry.name)).size !== parsed.data.stacks.length
        || (expectedStack !== undefined && (parsed.data.stacks.length !== 1 || parsed.data.stacks[0].name !== expectedStack))) {
        throw new Error('Invalid remote image facts');
    }
    return parsed.data;
}

export function parseRemoteImageUpdateRoster(value: unknown, nonce: string): string[] {
    const parsed = roster.safeParse(value);
    if (!parsed.success || parsed.data.requestNonce !== nonce
        || new Set(parsed.data.stacks).size !== parsed.data.stacks.length) {
        throw new Error('Invalid remote image roster');
    }
    return parsed.data.stacks;
}

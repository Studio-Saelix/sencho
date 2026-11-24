import { z } from 'zod';
import { isValidStackName } from '../utils/validation';
import { MAX_UPDATE_IGNORE_ENTRIES, parseSenchoUrl, parseUpdateIgnoreEntry } from '../helpers/senchoLabels';
import {
    IMAGE_UPDATE_FACTS_IMAGE_LIMIT, IMAGE_UPDATE_FACTS_STACK_LIMIT,
    type ImageUpdateFactsResponse,
} from './imageUpdateFacts';

const text = z.string().min(1).max(2048);
const stackName = text.refine(isValidStackName);
const reason = z.string().max(8192).nullable();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const detectionShape = {
    hasUpdate: z.boolean(), digestUpdate: z.boolean(), tagUpdate: z.boolean(),
    nextTag: text.nullable(), digestError: reason,
    tagEnumKind: z.enum(['complete', 'incomplete', 'error', 'skipped']),
    tagEnumReason: reason, checkStatus: z.enum(['ok', 'partial', 'failed', 'not_checkable']),
    reason, semverBump: z.enum(['none', 'patch', 'minor', 'major', 'unknown']),
};
const timestamp = z.number().finite().nonnegative();
/** The candidate digest is part of a result only when the hub asked for detection. */
function authoritySchema(withDetection: boolean) {
    const result = z.object(withDetection
        ? { ...detectionShape, candidateDigest: digest.nullable().optional() }
        : detectionShape,
    ).strict().refine(value => value.hasUpdate === (value.digestUpdate || value.tagUpdate));
    return z.discriminatedUnion('source', [
        z.object({ source: z.literal('target_credential'), result, observedAt: timestamp }).strict(),
        z.object({ source: z.literal('anonymous'), result, observedAt: timestamp }).strict(),
        z.object({ source: z.literal('unchecked'), result: z.null(), observedAt: timestamp }).strict(),
    ]);
}
const model = z.discriminatedUnion('renderable', [
    z.object({ renderable: z.literal(true) }).strict(),
    z.object({ renderable: z.literal(false), code: z.literal('effective_model_render_failed'), error: z.string().max(8192) }).strict(),
]);
const service = z.object({
    name: text, declaredImage: text.nullable(), runtimeImages: z.array(text).max(IMAGE_UPDATE_FACTS_IMAGE_LIMIT),
    hasBuild: z.boolean(),
}).strict();
const unattendedPolicy = z.object({
    decision: z.enum(['allow', 'skip']),
    ineligible: z.array(z.object({ service: text, policy: text }).strict()),
}).strict();
/** A target's update detection labels, re-validated with the parsers the target used. */
const directive = z.object({
    service: text,
    check: z.boolean(),
    ignore: z.array(z.string().max(160).refine(entry => entry.trim() === entry && parseUpdateIgnoreEntry(entry) !== null))
        .max(MAX_UPDATE_IGNORE_ENTRIES),
    changelogUrl: z.string().max(2048).refine(url => parseSenchoUrl(url).ok).nullable(),
}).strict();
function stackSchema(withDetection: boolean) {
    const image = z.object({
        ref: text, localDigests: z.array(digest).max(256),
        platform: z.object({ os: text, architecture: text }).strict().nullable(),
        emptyReason: z.enum(['none', 'no_repo_digests', 'inspect_failed', 'not_checkable']),
        authority: authoritySchema(withDetection),
    }).strict();
    const base = {
        name: stackName, observationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        observationToken: z.string().min(1).max(4096), model,
        services: z.array(service), images: z.array(image).max(IMAGE_UPDATE_FACTS_IMAGE_LIMIT),
        unattendedPolicy: unattendedPolicy.optional(),
    };
    return z.object(withDetection ? { ...base, directives: z.array(directive).optional() } : base)
        .strict().superRefine((value, context) => {
            const names = new Set(value.services.map(entry => entry.name));
            const directives = 'directives' in value ? value.directives : undefined;
            if (directives && (directives.some(entry => !names.has(entry.service))
                || new Set(directives.map(entry => entry.service)).size !== directives.length)) {
                context.addIssue({ code: 'custom', message: 'Directive for an unknown or duplicate service' });
            }
        }).superRefine((value, context) => {
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
            const policy = value.unattendedPolicy;
            if (policy && (policy.decision === 'allow'
                ? policy.ineligible.length > 0
                : policy.ineligible.some(entry => !names.has(entry.service))
                || (!value.model.renderable && policy.ineligible.length > 0))) {
                context.addIssue({ code: 'custom', message: 'Inconsistent unattended policy evidence' });
            }
            if (policy && !value.model.renderable && policy.decision !== 'skip') {
                context.addIssue({ code: 'custom', message: 'An unrenderable model can only skip' });
            }
        });
}
const envelope = {
    contractVersion: z.literal(1), requestNonce: z.string().regex(/^[a-f0-9]{32,128}$/),
};
const factsSchemas = {
    plain: z.object({ ...envelope, stacks: z.array(stackSchema(false)).max(IMAGE_UPDATE_FACTS_STACK_LIMIT) }).strict(),
    detection: z.object({ ...envelope, stacks: z.array(stackSchema(true)).max(IMAGE_UPDATE_FACTS_STACK_LIMIT) }).strict(),
};
const roster = z.object({ ...envelope, stacks: z.array(stackName).max(IMAGE_UPDATE_FACTS_STACK_LIMIT) }).strict();

/**
 * Parse a target's facts. `detection` says whether the request asked for the
 * detection labels; a response that carries them unasked is refused.
 */
export function parseRemoteImageUpdateFacts(
    value: unknown,
    nonce: string,
    expectedStack?: string,
    detection = false,
): ImageUpdateFactsResponse {
    const parsed = (detection ? factsSchemas.detection : factsSchemas.plain).safeParse(value);
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

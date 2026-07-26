/**
 * Shared image-update detection used by both persisted sidebar status
 * (ImageUpdateService.checkImage) and Fleet/Anatomy preview
 * (UpdatePreviewService.computeImagePreview).
 *
 * An update is available when either:
 *   1. the local digest no longer matches the registry manifest for the
 *      currently declared tag (digestUpdate; Compose-actionable), or
 *   2. a higher pinned semver tag exists in a complete bounded tag list
 *      (tagUpdate; advisory only until Compose is edited).
 */
import {
    compareLocalToRemoteTag,
    listRegistryTagsResult,
    type DigestComparisonResult,
    type RegistryCredentials,
    type TagListResult,
} from './registry-api';

export type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

/** Per-image check confidence for preview authority and scanner persistence. */
export type PreviewImageCheckStatus = 'ok' | 'partial' | 'failed' | 'not_checkable';

interface SemverParts {
    prefix: string;
    major: number;
    minor: number;
    patch: number;
    suffix: string;
    raw: string;
}

const SEMVER_RE = /^(v)?(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z][A-Za-z0-9.-]*))?$/;

/** Max pages when enumerating tags for a pinned-semver authoritative-negative. */
export const PREVIEW_TAG_LIST_MAX_PAGES = 20;
/** Max tags accumulated across pages for the same purpose. */
export const PREVIEW_TAG_LIST_MAX_TAGS = 2000;
/** Per-page size passed to listRegistryTagsResult. */
export const PREVIEW_TAG_LIST_PAGE_SIZE = 100;

export function parseSemverTag(tag: string): SemverParts | null {
    const m = tag.match(SEMVER_RE);
    if (!m) return null;
    return {
        prefix: m[1] ?? '',
        major: Number(m[2]),
        minor: Number(m[3]),
        patch: Number(m[4]),
        suffix: m[5] ?? '',
        raw: tag,
    };
}

/**
 * A tag is "moving" when restoring the compose file would not revert the image
 * behind it: `latest`, a branch name, or an unpinned major/minor like `1.25`.
 * Only a fully-pinned semver tag (X.Y.Z, optionally `v`-prefixed and/or with a
 * `-prerelease` suffix) is treated as immutable, matching how a file rollback
 * restores the exact tag.
 */
export function isMovingTag(tag: string): boolean {
    return parseSemverTag(tag) === null;
}

function compareSemver(a: SemverParts, b: SemverParts): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
}

export function findNextTag(currentTag: string, availableTags: string[]): string | null {
    const current = parseSemverTag(currentTag);
    if (!current) return null;
    let best: SemverParts | null = null;
    for (const tag of availableTags) {
        const parsed = parseSemverTag(tag);
        if (!parsed) continue;
        if (parsed.prefix !== current.prefix) continue;
        if (parsed.suffix !== current.suffix) continue;
        if (compareSemver(parsed, current) <= 0) continue;
        if (!best || compareSemver(parsed, best) > 0) best = parsed;
    }
    return best ? best.raw : null;
}

export function computeSemverBump(currentTag: string, nextTag: string | null): SemverBump {
    if (!nextTag) return 'none';
    if (nextTag === currentTag) return 'patch';
    const current = parseSemverTag(currentTag);
    const next = parseSemverTag(nextTag);
    if (!current || !next) return 'unknown';
    if (next.major > current.major) return 'major';
    if (next.minor > current.minor) return 'minor';
    if (next.patch > current.patch) return 'patch';
    return 'none';
}

export type ListRegistryTagsResultFn = (
    registry: string,
    repo: string,
    credentials?: RegistryCredentials | null,
    opts?: { limit?: number; cursor?: string },
) => Promise<TagListResult>;

export type TagEnumOutcome =
    | { kind: 'complete'; tags: string[] }
    | { kind: 'incomplete'; tags: string[]; reason: string }
    | { kind: 'error'; reason: string }
    | { kind: 'skipped' };

/**
 * Enumerate tags with bounded pagination. Hitting the page/tag cap while a
 * nextCursor remains is incomplete (non-authoritative), not a successful empty
 * or "no newer tag" result.
 */
export async function listAllRegistryTagsBounded(
    listFn: ListRegistryTagsResultFn,
    registry: string,
    repo: string,
    credentials: RegistryCredentials | null,
    opts: { maxPages?: number; maxTags?: number; pageSize?: number } = {},
): Promise<TagEnumOutcome> {
    const maxPages = opts.maxPages ?? PREVIEW_TAG_LIST_MAX_PAGES;
    const maxTags = opts.maxTags ?? PREVIEW_TAG_LIST_MAX_TAGS;
    const pageSize = opts.pageSize ?? PREVIEW_TAG_LIST_PAGE_SIZE;
    const tags: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
        const result = await listFn(registry, repo, credentials, { limit: pageSize, cursor });
        if (!result.ok) {
            return { kind: 'error', reason: result.message };
        }
        tags.push(...result.tags);
        if (tags.length > maxTags) {
            return {
                kind: 'incomplete',
                tags: tags.slice(0, maxTags),
                reason: `Tag list exceeded ${maxTags} tags before pagination completed`,
            };
        }
        if (!result.nextCursor) {
            return { kind: 'complete', tags };
        }
        cursor = result.nextCursor;
    }
    return {
        kind: 'incomplete',
        tags,
        reason: `Tag list exceeded ${maxPages} pages before pagination completed`,
    };
}

export interface ImageUpdateDetectInput {
    localDigests: readonly string[];
    platform: { os: string; architecture: string };
    registry: string;
    repo: string;
    tag: string;
    credentials: RegistryCredentials | null;
}

export interface ImageUpdateDetectResult {
    hasUpdate: boolean;
    digestUpdate: boolean;
    tagUpdate: boolean;
    nextTag: string | null;
    digestError: string | null;
    tagEnumKind: 'complete' | 'incomplete' | 'error' | 'skipped';
    tagEnumReason: string | null;
    checkStatus: PreviewImageCheckStatus;
    /** Best operator-facing uncertainty reason for lastError / tooltips. */
    reason: string | null;
    semverBump: SemverBump;
}

export interface DetectImageUpdateDeps {
    compareDigest?: typeof compareLocalToRemoteTag;
    listRegistryTagsResult?: ListRegistryTagsResultFn;
}

export function resolveImageCheckStatus(args: {
    digest: DigestComparisonResult['kind'];
    tagApplicable: boolean;
    tagOutcome: TagEnumOutcome;
    hasUpdate: boolean;
}): PreviewImageCheckStatus {
    const { digest, tagApplicable, tagOutcome, hasUpdate } = args;

    if (digest === 'update') return 'ok';

    if (!tagApplicable) {
        return digest === 'match' ? 'ok' : 'failed';
    }

    if (tagOutcome.kind === 'complete') {
        if (hasUpdate) return 'ok';
        if (digest === 'match') return 'ok';
        return 'partial';
    }

    if (tagOutcome.kind === 'incomplete') {
        if (hasUpdate) return 'ok';
        return 'partial';
    }

    if (hasUpdate) return 'partial';
    if (digest === 'match') return 'partial';
    return 'failed';
}

function uncertaintyReason(
    checkStatus: PreviewImageCheckStatus,
    digestError: string | null,
    tagEnumReason: string | null,
): string | null {
    if (checkStatus === 'ok' || checkStatus === 'not_checkable') return null;
    return tagEnumReason ?? digestError;
}

/**
 * Core availability check shared by preview and persistence.
 */
export async function detectImageUpdate(args: ImageUpdateDetectInput & {
    deps?: DetectImageUpdateDeps;
}): Promise<ImageUpdateDetectResult> {
    const compareDigest = args.deps?.compareDigest ?? compareLocalToRemoteTag;
    const listFn = args.deps?.listRegistryTagsResult ?? listRegistryTagsResult;
    const tagApplicable = !isMovingTag(args.tag);

    const comparisonPromise: Promise<DigestComparisonResult> = args.localDigests.length > 0
        ? compareDigest(
            args.localDigests,
            args.registry,
            args.repo,
            args.tag,
            args.platform,
            args.credentials,
        )
        : Promise.resolve({ kind: 'error', reason: 'No local registry digest available' });

    const tagPromise: Promise<TagEnumOutcome> = tagApplicable
        ? listAllRegistryTagsBounded(listFn, args.registry, args.repo, args.credentials)
        : Promise.resolve({ kind: 'skipped' });

    const [comparison, tagOutcome] = await Promise.all([comparisonPromise, tagPromise]);

    let nextTag: string | null = null;
    if (tagOutcome.kind === 'complete' || tagOutcome.kind === 'incomplete') {
        nextTag = findNextTag(args.tag, tagOutcome.tags);
    }

    const digestUpdate = comparison.kind === 'update';
    const tagUpdate = nextTag !== null;
    const hasUpdate = digestUpdate || tagUpdate;

    let resolvedNext: string | null = null;
    let semverBump: SemverBump = 'none';
    if (nextTag) {
        resolvedNext = nextTag;
        semverBump = computeSemverBump(args.tag, nextTag);
    } else if (digestUpdate) {
        resolvedNext = args.tag;
        semverBump = 'patch';
    }

    const digestError = comparison.kind === 'error' ? comparison.reason : null;
    const tagEnumKind = tagOutcome.kind;
    const tagEnumReason = tagOutcome.kind === 'incomplete' || tagOutcome.kind === 'error'
        ? tagOutcome.reason
        : null;

    const checkStatus = resolveImageCheckStatus({
        digest: comparison.kind,
        tagApplicable,
        tagOutcome,
        hasUpdate,
    });

    return {
        hasUpdate,
        digestUpdate,
        tagUpdate,
        nextTag: resolvedNext,
        digestError,
        tagEnumKind,
        tagEnumReason,
        checkStatus,
        reason: uncertaintyReason(checkStatus, digestError, tagEnumReason),
        semverBump,
    };
}

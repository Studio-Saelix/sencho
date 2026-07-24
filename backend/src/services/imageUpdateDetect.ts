/**
 * Shared image-update detection used by both persisted sidebar status
 * (ImageUpdateService.checkImage) and Fleet/Anatomy preview
 * (UpdatePreviewService.computeImagePreview).
 *
 * An update is available when either:
 *   1. the local digest no longer matches the registry manifest for the
 *      currently declared tag, or
 *   2. a higher pinned semver tag exists in the registry tag list.
 */
import {
    compareLocalToRemoteTag,
    listRegistryTags,
    type DigestComparisonResult,
    type RegistryCredentials,
} from './registry-api';

export type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

export interface SemverParts {
    prefix: string;
    major: number;
    minor: number;
    patch: number;
    suffix: string;
    raw: string;
}

const SEMVER_RE = /^(v)?(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z][A-Za-z0-9.-]*))?$/;

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

export interface ImageUpdateDetection {
    hasUpdate: boolean;
    digestUpdate: boolean;
    nextTag: string | null;
    /**
     * Digest comparison failure reason when the digest path did not confirm an
     * update. Callers that need fail-closed persistence surface this as an
     * error only when hasUpdate is also false.
     */
    digestError: string | null;
}

export interface DetectImageUpdateDeps {
    compareDigest?: typeof compareLocalToRemoteTag;
    listTags?: typeof listRegistryTags;
}

/**
 * Core availability check shared by preview and persistence.
 * Digest comparison errors fail soft for the digest signal (never claim a
 * digest-based update) but a higher semver tag can still set hasUpdate.
 */
export async function detectImageUpdateAvailability(args: {
    localDigest: string | null;
    platform: { os: string; architecture: string };
    registry: string;
    repo: string;
    tag: string;
    credentials: RegistryCredentials | null;
    deps?: DetectImageUpdateDeps;
}): Promise<ImageUpdateDetection> {
    const compareDigest = args.deps?.compareDigest ?? compareLocalToRemoteTag;
    const listTags = args.deps?.listTags ?? listRegistryTags;

    const [comparison, tags] = await Promise.all([
        args.localDigest
            ? compareDigest(
                args.localDigest,
                args.registry,
                args.repo,
                args.tag,
                args.platform,
                args.credentials,
            )
            : Promise.resolve<DigestComparisonResult>({
                kind: 'error',
                reason: 'No local registry digest available',
            }),
        listTags(args.registry, args.repo, args.credentials),
    ]);

    const digestUpdate = comparison.kind === 'update';
    const nextTag = findNextTag(args.tag, tags);
    const hasUpdate = digestUpdate || nextTag !== null;
    const digestError = comparison.kind === 'error' ? comparison.reason : null;

    return { hasUpdate, digestUpdate, nextTag, digestError };
}

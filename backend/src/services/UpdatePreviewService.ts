import DockerController from './DockerController';
import { FileSystemService } from './FileSystemService';
import { RegistryService } from './RegistryService';
import {
    extractServiceImagesFromCompose,
    loadDotEnv,
    loadEffectiveServiceImages,
    loadStackBuildServices,
    type ComposeServiceImage,
} from './ImageUpdateService';
import {
    parseImageRef,
    selectLocalRepoDigest,
    compareLocalToRemoteTag,
    listRegistryTagsResult,
    type ParsedRef,
    type RegistryCredentials,
    type DigestComparisonResult,
    type TagListResult,
} from './registry-api';

export type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

/** Per-image check confidence for preview authority rollup. */
export type PreviewImageCheckStatus = 'ok' | 'partial' | 'failed' | 'not_checkable';

/** Stack-level preview authority; absent on older remotes. */
export type PreviewCheckStatus = 'ok' | 'partial' | 'failed';

export interface UpdatePreviewImage {
    service: string;
    image: string;
    current_tag: string;
    next_tag: string | null;
    has_update: boolean;
    semver_bump: SemverBump;
    /** Authority of this image's checks; not_checkable for invalid refs. */
    check_status: PreviewImageCheckStatus;
}

export type UpdateKind = 'tag' | 'digest' | 'none';

export interface UpdatePreviewSummary {
    has_update: boolean;
    primary_image: string | null;
    current_tag: string | null;
    next_tag: string | null;
    semver_bump: SemverBump;
    /**
     * Distinguishes a "new tag is available" update from a "same tag, new
     * digest" rebuild. The UI renders the rebuild case differently because
     * showing "10.11 -> 10.11" reads as a bug even though it is technically
     * accurate (the tag did not change, only the immutable digest behind it).
     */
    update_kind: UpdateKind;
    blocked: boolean;
    blocked_reason: string | null;
    /** True when one or more services declare `build:` in the effective model. */
    has_build_services: boolean;
    /** True when a manual update can rebuild local build services (always when has_build_services). */
    rebuild_available: boolean;
    /**
     * Whether every checkable image was verified authoritatively.
     * Authoritative-negative reconcile requires check_status === 'ok' and !has_update.
     * Older remotes omit this field; treat absence as non-authoritative.
     */
    check_status: PreviewCheckStatus;
}

export interface UpdatePreview {
    stack_name: string;
    images: UpdatePreviewImage[];
    build_services: string[];
    summary: UpdatePreviewSummary;
    rollback_target: string | null;
    changelog: string | null;
}

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

function maxBump(a: SemverBump, b: SemverBump): SemverBump {
    // Ranking: none < unknown < patch < minor < major.
    // unknown ranks below real semver bumps so a single unparseable tag never masks
    // a genuine major bump elsewhere in the stack.
    const order: SemverBump[] = ['none', 'unknown', 'patch', 'minor', 'major'];
    const rank = (x: SemverBump) => order.indexOf(x);
    return rank(a) >= rank(b) ? a : b;
}

async function loadStackImages(
    nodeId: number,
    stackName: string,
): Promise<ComposeServiceImage[]> {
    // A multi-file / context-dir Git stack resolves images from the effective
    // merged model so override-only services are included; single-file stacks
    // fall through to the root-compose parse below.
    const effective = await loadEffectiveServiceImages(nodeId, stackName);
    if (effective) return effective;

    const fs = FileSystemService.getInstance(nodeId);
    const composeContent = await fs.getStackContent(stackName);
    let envVars: Record<string, string> = {};
    try {
        const envContent = await fs.getEnvContent(stackName);
        envVars = loadDotEnv(envContent);
    } catch {
        // No env file - fall back to process.env only
    }
    const merged: Record<string, string> = { ...envVars };
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) merged[k] = v;
    }
    return extractServiceImagesFromCompose(composeContent, merged);
}

export interface LocalDigestInfo {
    digest: string | null;
    platform: { os: string; architecture: string };
}

export type ListRegistryTagsResultFn = (
    registry: string,
    repo: string,
    credentials?: RegistryCredentials | null,
    opts?: { limit?: number; cursor?: string },
) => Promise<TagListResult>;

export interface ComputePreviewDeps {
    getLocalDigest: (imageRef: string, parsed: ParsedRef) => Promise<LocalDigestInfo>;
    compareDigest: typeof compareLocalToRemoteTag;
    listRegistryTagsResult: ListRegistryTagsResultFn;
    getCredentials: (registry: string) => Promise<RegistryCredentials | null>;
}

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

function imageFromParts(
    service: string,
    imageRef: string,
    currentTag: string,
    nextTag: string | null,
    hasUpdate: boolean,
    semverBump: SemverBump,
    checkStatus: PreviewImageCheckStatus,
): UpdatePreviewImage {
    return {
        service,
        image: imageRef,
        current_tag: currentTag,
        next_tag: nextTag,
        has_update: hasUpdate,
        semver_bump: semverBump,
        check_status: checkStatus,
    };
}

export async function computeImagePreview(
    service: string,
    imageRef: string,
    deps: ComputePreviewDeps,
): Promise<UpdatePreviewImage> {
    const parsed = parseImageRef(imageRef);
    if (!parsed) {
        return imageFromParts(service, imageRef, 'unknown', null, false, 'none', 'not_checkable');
    }

    const credentials = await deps.getCredentials(parsed.registry);
    const tagApplicable = !isMovingTag(parsed.tag);

    // Digest-based: is a new build of the SAME tag available? A comparison error
    // fails soft for has_update (never claims digest update) but affects authority.
    const localInfo = await deps.getLocalDigest(imageRef, parsed);
    const comparisonPromise: Promise<DigestComparisonResult> = localInfo.digest
        ? deps.compareDigest(localInfo.digest, parsed.registry, parsed.repo, parsed.tag, localInfo.platform, credentials)
        : Promise.resolve({ kind: 'error', reason: 'No local registry digest available' });

    // Tag enumeration only when findNextTag can apply (pinned semver).
    const tagPromise: Promise<TagEnumOutcome> = tagApplicable
        ? listAllRegistryTagsBounded(deps.listRegistryTagsResult, parsed.registry, parsed.repo, credentials)
        : Promise.resolve({ kind: 'skipped' });

    const [comparison, tagOutcome] = await Promise.all([comparisonPromise, tagPromise]);

    let nextTag: string | null = null;
    if (tagOutcome.kind === 'complete' || tagOutcome.kind === 'incomplete') {
        nextTag = findNextTag(parsed.tag, tagOutcome.tags);
    }

    const digestUpdate = comparison.kind === 'update';
    const hasUpdate = digestUpdate || nextTag !== null;
    let semverBump: SemverBump = 'none';
    let resolvedNext: string | null = null;
    if (nextTag) {
        resolvedNext = nextTag;
        semverBump = computeSemverBump(parsed.tag, nextTag);
    } else if (digestUpdate) {
        resolvedNext = parsed.tag;
        semverBump = 'patch';
    }

    const checkStatus = resolveImageCheckStatus({
        digest: comparison.kind,
        tagApplicable,
        tagOutcome,
        hasUpdate,
    });

    return imageFromParts(service, imageRef, parsed.tag, resolvedNext, hasUpdate, semverBump, checkStatus);
}

function resolveImageCheckStatus(args: {
    digest: DigestComparisonResult['kind'];
    tagApplicable: boolean;
    tagOutcome: TagEnumOutcome;
    hasUpdate: boolean;
}): PreviewImageCheckStatus {
    const { digest, tagApplicable, tagOutcome, hasUpdate } = args;

    // Digest alone proves an update → authoritative ok regardless of tags.
    if (digest === 'update') return 'ok';

    if (!tagApplicable) {
        // Moving/non-semver: negative authority rests on digest match only.
        return digest === 'match' ? 'ok' : 'failed';
    }

    // Pinned semver: need complete tag enumeration for authoritative-negative.
    // A found next tag is a definitive positive even when digest compare failed.
    if (tagOutcome.kind === 'complete') {
        if (hasUpdate) return 'ok';
        if (digest === 'match') return 'ok';
        // digest error and no next tag: cannot exclude same-tag rebuild
        return 'partial';
    }

    if (tagOutcome.kind === 'incomplete') {
        // Newer tag on pages we fetched is a confirmed positive; otherwise partial.
        if (hasUpdate) return 'ok';
        return 'partial';
    }

    // tagOutcome.kind === 'error' or unexpected skipped for semver
    if (hasUpdate) return 'partial'; // tag prove failed; digest may still be soft
    if (digest === 'match') return 'partial';
    return 'failed';
}

function buildRollbackTarget(image: string, currentTag: string): string | null {
    const parsed = parseImageRef(image);
    if (!parsed) return null;
    // Reconstruct without the library/ prefix Docker Hub uses internally,
    // so "library/nginx" renders as "nginx:1.0.0" not "registry-1.docker.io/library/nginx:1.0.0".
    const isDockerHub = parsed.registry === 'registry-1.docker.io';
    const repo = isDockerHub && parsed.repo.startsWith('library/')
        ? parsed.repo.slice('library/'.length)
        : parsed.repo;
    const base = isDockerHub ? repo : `${parsed.registry}/${repo}`;
    return `${base}:${currentTag}`;
}

export function rollupPreviewCheckStatus(images: UpdatePreviewImage[]): PreviewCheckStatus {
    const checkable = images.filter((i) => i.check_status !== 'not_checkable');
    if (checkable.length === 0) return 'ok';
    const allFailed = checkable.every((i) => i.check_status === 'failed');
    if (allFailed) return 'failed';
    const allOk = checkable.every((i) => i.check_status === 'ok');
    if (allOk) return 'ok';
    return 'partial';
}

export function buildSummary(
    stackName: string,
    images: UpdatePreviewImage[],
    buildServices: string[] = [],
): UpdatePreview {
    const updated = images.filter(i => i.has_update);
    const hasUpdate = updated.length > 0;
    const primary = updated[0] ?? images[0] ?? null;
    const overallBump = updated.reduce<SemverBump>(
        (acc, img) => maxBump(acc, img.semver_bump),
        'none',
    );
    const blocked = overallBump === 'major';
    const hasBuildServices = buildServices.length > 0;
    // 'tag' means at least one image has a strictly newer tag; 'digest' means
    // the only updates available are same-tag rebuilds (digest changed); 'none'
    // means there is nothing to apply.
    const updateKind: UpdateKind = !hasUpdate
        ? 'none'
        : updated.some(i => i.next_tag !== null && i.next_tag !== i.current_tag)
            ? 'tag'
            : 'digest';
    return {
        stack_name: stackName,
        images,
        build_services: buildServices,
        summary: {
            has_update: hasUpdate,
            primary_image: primary ? primary.image : null,
            current_tag: primary ? primary.current_tag : null,
            next_tag: primary ? primary.next_tag : null,
            semver_bump: overallBump,
            update_kind: updateKind,
            blocked,
            blocked_reason: blocked ? 'Major version jumps require human review before applying.' : null,
            has_build_services: hasBuildServices,
            rebuild_available: hasBuildServices,
            check_status: rollupPreviewCheckStatus(images),
        },
        rollback_target: primary ? buildRollbackTarget(primary.image, primary.current_tag) : null,
        changelog: null,
    };
}

/** True when a preview is safe to clear sticky scanner state. */
export function isAuthoritativeNegativePreview(preview: UpdatePreview): boolean {
    const hasCheckable = preview.images.some((i) => i.check_status !== 'not_checkable');
    // Empty / build-only previews must not clear scanner rows that track runtime images.
    return hasCheckable
        && preview.summary.check_status === 'ok'
        && preview.summary.has_update === false;
}

/** Filter a full-stack preview down to one service's images and recompute the summary from that subset. */
export function filterPreviewForService(preview: UpdatePreview, serviceName: string): UpdatePreview {
    const images = preview.images.filter(i => i.service === serviceName);
    const buildServices = preview.build_services.filter(s => s === serviceName);
    return buildSummary(preview.stack_name, images, buildServices);
}

export class UpdatePreviewService {
    private static instance: UpdatePreviewService;

    public static getInstance(): UpdatePreviewService {
        if (!UpdatePreviewService.instance) {
            UpdatePreviewService.instance = new UpdatePreviewService();
        }
        return UpdatePreviewService.instance;
    }

    public async getPreview(nodeId: number, stackName: string): Promise<UpdatePreview> {
        const [stackImages, buildServices] = await Promise.all([
            loadStackImages(nodeId, stackName),
            loadStackBuildServices(nodeId, stackName),
        ]);
        if (stackImages.length === 0) {
            return buildSummary(stackName, [], buildServices);
        }

        const docker = DockerController.getInstance(nodeId);
        const deps: ComputePreviewDeps = {
            getCredentials: (registry) => RegistryService.getInstance().getAuthForRegistry(registry),
            compareDigest: compareLocalToRemoteTag,
            listRegistryTagsResult,
            getLocalDigest: async (imageRef: string, parsed: ParsedRef): Promise<LocalDigestInfo> => {
                try {
                    const inspect = await docker.getDocker().getImage(imageRef).inspect();
                    const repoDigests: string[] = inspect.RepoDigests ?? [];
                    const digest = selectLocalRepoDigest(repoDigests, parsed);
                    return { digest, platform: { os: inspect.Os, architecture: inspect.Architecture } };
                } catch {
                    return { digest: null, platform: { os: '', architecture: '' } };
                }
            },
        };

        const results = await Promise.all(
            stackImages.map(({ service, image }) => computeImagePreview(service, image, deps)),
        );
        return buildSummary(stackName, results, buildServices);
    }
}

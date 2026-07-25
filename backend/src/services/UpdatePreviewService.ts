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
    selectLocalRepoDigests,
    compareLocalToRemoteTag,
    listRegistryTagsResult,
    type ParsedRef,
    type RegistryCredentials,
} from './registry-api';
import {
    detectImageUpdate,
    type ImageUpdateDetectResult,
    type ListRegistryTagsResultFn,
    type PreviewImageCheckStatus,
    type SemverBump,
    computeSemverBump,
    findNextTag,
    isMovingTag,
    listAllRegistryTagsBounded,
    parseSemverTag,
    PREVIEW_TAG_LIST_MAX_PAGES,
    PREVIEW_TAG_LIST_MAX_TAGS,
    PREVIEW_TAG_LIST_PAGE_SIZE,
    type TagEnumOutcome,
} from './imageUpdateDetect';

export type { SemverBump, PreviewImageCheckStatus, TagEnumOutcome, ListRegistryTagsResultFn };
export {
    computeSemverBump,
    findNextTag,
    isMovingTag,
    listAllRegistryTagsBounded,
    parseSemverTag,
    PREVIEW_TAG_LIST_MAX_PAGES,
    PREVIEW_TAG_LIST_MAX_TAGS,
    PREVIEW_TAG_LIST_PAGE_SIZE,
};

/** Stack-level preview authority; absent on older remotes. */
export type PreviewCheckStatus = 'ok' | 'partial' | 'failed';

export interface UpdatePreviewImage {
    service: string;
    image: string;
    current_tag: string;
    next_tag: string | null;
    has_update: boolean;
    /** Same-tag content drift; Compose pull can apply without pin change. */
    digest_update: boolean;
    /** Higher pinned semver exists; advisory until Compose is edited. */
    tag_update: boolean;
    semver_bump: SemverBump;
    /** Authority of this image's checks; not_checkable for invalid refs. */
    check_status: PreviewImageCheckStatus;
    /**
     * Best operator-facing reason when check_status is not 'ok'/'not_checkable'.
     * Never paired with a digest-based has_update claim: callers must treat
     * this as verification-failed / unknown, not as "up to date" or rebuild.
     */
    check_error: string | null;
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
    /** True when any image's check_status is not 'ok' (excluding not_checkable). */
    verification_failed: boolean;
    /** First image check_error when verification_failed; otherwise null. */
    verification_error: string | null;
}

export interface UpdatePreview {
    stack_name: string;
    images: UpdatePreviewImage[];
    build_services: string[];
    summary: UpdatePreviewSummary;
    rollback_target: string | null;
    changelog: string | null;
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

export type LocalDigestEmptyReason = 'not_checkable' | 'inspect_failed' | 'unresolved';

export interface LocalDigestInfo {
    /** All usable RepoDigests for the image ref; compared as a set against the remote tag. */
    digests: string[];
    platform: { os: string; architecture: string };
    /**
     * Why digests is empty. `not_checkable` mirrors the scanner (no RepoDigests /
     * locally built) and must not surface as verification-failed. Inspect failure
     * and unresolved selection do.
     */
    emptyReason: LocalDigestEmptyReason | null;
}

export interface ComputePreviewDeps {
    getLocalDigest: (imageRef: string, parsed: ParsedRef) => Promise<LocalDigestInfo>;
    compareDigest: typeof compareLocalToRemoteTag;
    listRegistryTagsResult: ListRegistryTagsResultFn;
    getCredentials: (registry: string) => Promise<RegistryCredentials | null>;
}

function imageFromDetect(
    service: string,
    imageRef: string,
    currentTag: string,
    detected: ImageUpdateDetectResult,
): UpdatePreviewImage {
    return {
        service,
        image: imageRef,
        current_tag: currentTag,
        next_tag: detected.nextTag,
        has_update: detected.hasUpdate,
        digest_update: detected.digestUpdate,
        tag_update: detected.tagUpdate,
        semver_bump: detected.semverBump,
        check_status: detected.checkStatus,
        check_error: detected.reason,
    };
}

function notCheckableImage(service: string, imageRef: string): UpdatePreviewImage {
    return {
        service,
        image: imageRef,
        current_tag: 'unknown',
        next_tag: null,
        has_update: false,
        digest_update: false,
        tag_update: false,
        semver_bump: 'none',
        check_status: 'not_checkable',
        check_error: null,
    };
}

/** Local digest could not be established at all; never reaches the registry. */
function failedLocalDigestImage(service: string, imageRef: string, currentTag: string, reason: string): UpdatePreviewImage {
    return {
        service,
        image: imageRef,
        current_tag: currentTag,
        next_tag: null,
        has_update: false,
        digest_update: false,
        tag_update: false,
        semver_bump: 'none',
        check_status: 'failed',
        check_error: reason,
    };
}

export async function computeImagePreview(
    service: string,
    imageRef: string,
    deps: ComputePreviewDeps,
): Promise<UpdatePreviewImage> {
    const parsed = parseImageRef(imageRef);
    if (!parsed) {
        return notCheckableImage(service, imageRef);
    }

    const credentials = await deps.getCredentials(parsed.registry);
    const localInfo = await deps.getLocalDigest(imageRef, parsed);
    // A locally-built / non-registry-backed image (no RepoDigests at all) is
    // not_checkable, matching ImageUpdateService.checkImage: it must never be
    // funneled into detectImageUpdate's "no local digest" error path, which
    // would misreport it as a verification failure instead of not applicable.
    if (localInfo.emptyReason === 'not_checkable') {
        return notCheckableImage(service, imageRef);
    }
    // Inspect failure and unresolved RepoDigests never reach the registry, and
    // detectImageUpdate's generic "no local digest" reason would blur these two
    // distinct causes together; keep the specific reason, matching what
    // ImageUpdateService.checkImage reports for the same two cases.
    if (localInfo.emptyReason === 'inspect_failed') {
        return failedLocalDigestImage(service, imageRef, parsed.tag, 'Failed to inspect local image');
    }
    if (localInfo.emptyReason === 'unresolved') {
        return failedLocalDigestImage(service, imageRef, parsed.tag, 'Could not resolve a local registry digest');
    }
    const detected = await detectImageUpdate({
        localDigests: localInfo.digests,
        platform: localInfo.platform,
        registry: parsed.registry,
        repo: parsed.repo,
        tag: parsed.tag,
        credentials,
        deps: {
            compareDigest: deps.compareDigest,
            listRegistryTagsResult: deps.listRegistryTagsResult,
        },
    });
    return imageFromDetect(service, imageRef, parsed.tag, detected);
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
    const verificationError = images.find(i => i.check_error)?.check_error ?? null;
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
            verification_failed: verificationError !== null,
            verification_error: verificationError,
        },
        rollback_target: primary ? buildRollbackTarget(primary.image, primary.current_tag) : null,
        changelog: null,
    };
}

/** True when a preview is safe to clear sticky scanner state. */
export function isAuthoritativeNegativePreview(preview: UpdatePreview): boolean {
    // Every declared image must be explicitly ok. Mixed ok + not_checkable must
    // not clear sticky rows that may still track unresolved services.
    return preview.images.length > 0
        && preview.images.every((i) => i.check_status === 'ok')
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
                    if (repoDigests.length === 0) {
                        return {
                            digests: [],
                            platform: { os: inspect.Os, architecture: inspect.Architecture },
                            emptyReason: 'not_checkable',
                        };
                    }
                    const digests = selectLocalRepoDigests(repoDigests, parsed);
                    return {
                        digests,
                        platform: { os: inspect.Os, architecture: inspect.Architecture },
                        emptyReason: digests.length === 0 ? 'unresolved' : null,
                    };
                } catch (err) {
                    console.error('[UpdatePreview] local image inspect failed for %s', imageRef, err);
                    return { digests: [], platform: { os: '', architecture: '' }, emptyReason: 'inspect_failed' };
                }
            },
        };

        // Memoize service-independent detection by image ref so shared images
        // hit the registry once, then attach each service name separately.
        const detectByRef = new Map<string, Promise<UpdatePreviewImage>>();
        const results = await Promise.all(
            stackImages.map(async ({ service, image }) => {
                let shared = detectByRef.get(image);
                if (!shared) {
                    shared = computeImagePreview('_shared_', image, deps);
                    detectByRef.set(image, shared);
                }
                const base = await shared;
                return { ...base, service };
            }),
        );
        return buildSummary(stackName, results, buildServices);
    }
}

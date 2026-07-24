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
    listRegistryTags,
    type ParsedRef,
    type RegistryCredentials,
} from './registry-api';
import {
    computeSemverBump,
    detectImageUpdateAvailability,
    type SemverBump,
} from './imageUpdateDetect';

// Re-export shared helpers so existing callers keep importing from this module.
export {
    parseSemverTag,
    findNextTag,
    computeSemverBump,
    isMovingTag,
    type SemverBump,
} from './imageUpdateDetect';

export interface UpdatePreviewImage {
    service: string;
    image: string;
    current_tag: string;
    next_tag: string | null;
    has_update: boolean;
    semver_bump: SemverBump;
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

export interface LocalDigestInfo {
    digest: string | null;
    platform: { os: string; architecture: string };
}

export interface ComputePreviewDeps {
    getLocalDigest: (imageRef: string, parsed: ParsedRef) => Promise<LocalDigestInfo>;
    compareDigest: typeof compareLocalToRemoteTag;
    listRegistryTags: typeof listRegistryTags;
    getCredentials: (registry: string) => Promise<RegistryCredentials | null>;
}

export async function computeImagePreview(
    service: string,
    imageRef: string,
    deps: ComputePreviewDeps,
): Promise<UpdatePreviewImage> {
    const parsed = parseImageRef(imageRef);
    if (!parsed) {
        return {
            service,
            image: imageRef,
            current_tag: 'unknown',
            next_tag: null,
            has_update: false,
            semver_bump: 'none',
        };
    }

    const credentials = await deps.getCredentials(parsed.registry);
    const localInfo = await deps.getLocalDigest(imageRef, parsed);
    const detection = await detectImageUpdateAvailability({
        localDigest: localInfo.digest,
        platform: localInfo.platform,
        registry: parsed.registry,
        repo: parsed.repo,
        tag: parsed.tag,
        credentials,
        deps: {
            compareDigest: deps.compareDigest,
            listTags: deps.listRegistryTags,
        },
    });

    let semverBump: SemverBump = 'none';
    let resolvedNext: string | null = null;
    if (detection.nextTag) {
        resolvedNext = detection.nextTag;
        semverBump = computeSemverBump(parsed.tag, detection.nextTag);
    } else if (detection.digestUpdate) {
        resolvedNext = parsed.tag;
        semverBump = 'patch';
    }

    return {
        service,
        image: imageRef,
        current_tag: parsed.tag,
        next_tag: resolvedNext,
        has_update: detection.hasUpdate,
        semver_bump: semverBump,
    };
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
        },
        rollback_target: primary ? buildRollbackTarget(primary.image, primary.current_tag) : null,
        changelog: null,
    };
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
            listRegistryTags,
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

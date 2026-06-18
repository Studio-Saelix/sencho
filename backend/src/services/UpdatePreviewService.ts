import DockerController from './DockerController';
import { FileSystemService } from './FileSystemService';
import { RegistryService } from './RegistryService';
import {
    extractServiceImagesFromCompose,
    loadDotEnv,
    loadEffectiveServiceImages,
    type ComposeServiceImage,
} from './ImageUpdateService';
import {
    parseImageRef,
    getRemoteDigest,
    listRegistryTags,
    type RegistryCredentials,
} from './registry-api';

export type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

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
}

export interface UpdatePreview {
    stack_name: string;
    images: UpdatePreviewImage[];
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

export interface ComputePreviewDeps {
    getLocalDigest: (imageRef: string) => Promise<string | null>;
    getRemoteDigest: typeof getRemoteDigest;
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

    // Digest-based: is a new build of the SAME tag available?
    const [localDigest, remoteDigest] = await Promise.all([
        deps.getLocalDigest(imageRef),
        deps.getRemoteDigest(parsed.registry, parsed.repo, parsed.tag, credentials),
    ]);
    const digestUpdate = Boolean(localDigest && remoteDigest && localDigest !== remoteDigest);

    // Tag-based: is a higher semver tag available?
    const tags = await deps.listRegistryTags(parsed.registry, parsed.repo, credentials);
    const nextTag = findNextTag(parsed.tag, tags);

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

    return {
        service,
        image: imageRef,
        current_tag: parsed.tag,
        next_tag: resolvedNext,
        has_update: hasUpdate,
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

export function buildSummary(stackName: string, images: UpdatePreviewImage[]): UpdatePreview {
    const updated = images.filter(i => i.has_update);
    const hasUpdate = updated.length > 0;
    const primary = updated[0] ?? images[0] ?? null;
    const overallBump = updated.reduce<SemverBump>(
        (acc, img) => maxBump(acc, img.semver_bump),
        'none',
    );
    const blocked = overallBump === 'major';
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
        summary: {
            has_update: hasUpdate,
            primary_image: primary ? primary.image : null,
            current_tag: primary ? primary.current_tag : null,
            next_tag: primary ? primary.next_tag : null,
            semver_bump: overallBump,
            update_kind: updateKind,
            blocked,
            blocked_reason: blocked ? 'Major version jumps require human review before applying.' : null,
        },
        rollback_target: primary ? buildRollbackTarget(primary.image, primary.current_tag) : null,
        changelog: null,
    };
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
        const stackImages = await loadStackImages(nodeId, stackName);
        if (stackImages.length === 0) {
            return buildSummary(stackName, []);
        }

        const docker = DockerController.getInstance(nodeId);
        const deps: ComputePreviewDeps = {
            getCredentials: (registry) => RegistryService.getInstance().getAuthForRegistry(registry),
            getRemoteDigest,
            listRegistryTags,
            getLocalDigest: async (imageRef: string) => {
                try {
                    const inspect = await docker.getDocker().getImage(imageRef).inspect();
                    const repoDigests: string[] = inspect.RepoDigests ?? [];
                    for (const rd of repoDigests) {
                        if (!rd.includes('@sha256:')) continue;
                        const [, digest] = rd.split('@');
                        return digest;
                    }
                    return null;
                } catch {
                    return null;
                }
            },
        };

        const results = await Promise.all(
            stackImages.map(({ service, image }) => computeImagePreview(service, image, deps)),
        );
        return buildSummary(stackName, results);
    }
}

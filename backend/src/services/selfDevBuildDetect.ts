/**
 * Detects whether the running Sencho container's own image has fallen behind
 * the rolling `ghcr.io/studio-saelix/sencho-dev:dev` build it tracks. Reuses
 * {@link compareLocalToRemoteTagDetailed} so the verdict and the new digest
 * come from a single registry probe.
 */
import { getErrorMessage } from '../utils/errors';
import DockerController from './DockerController';
import {
    compareLocalToRemoteTagDetailed,
    selectLocalRepoDigests,
    type RegistryCredentials,
} from './registry-api';

export interface SelfDevBuildDetectInput {
    /** Container's actual running image ID (no "sha256:" prefix). */
    runningImageId: string;
    registry: string;
    repo: string;
    tag: string;
    credentials: RegistryCredentials | null;
}

export type SelfDevBuildDetectResult =
    | { kind: 'up_to_date' }
    | { kind: 'update'; digest: string }
    | { kind: 'inconclusive'; reason: string };

/** The subset of `docker image inspect` output the detector reads. */
interface InspectedImage {
    RepoDigests: string[];
    Os: string;
    Architecture: string;
}

async function defaultInspectImage(imageId: string): Promise<InspectedImage> {
    const inspect = await DockerController.getInstance().getDocker().getImage(`sha256:${imageId}`).inspect();
    return { RepoDigests: inspect.RepoDigests ?? [], Os: inspect.Os, Architecture: inspect.Architecture };
}

export interface DetectSelfDevBuildUpdateDeps {
    inspectImage?: typeof defaultInspectImage;
    compareDetailed?: typeof compareLocalToRemoteTagDetailed;
}

export async function detectSelfDevBuildUpdate(
    input: SelfDevBuildDetectInput,
    deps?: DetectSelfDevBuildUpdateDeps,
): Promise<SelfDevBuildDetectResult> {
    const { runningImageId, registry, repo, tag, credentials } = input;
    const inspectImage = deps?.inspectImage ?? defaultInspectImage;
    const compareDetailed = deps?.compareDetailed ?? compareLocalToRemoteTagDetailed;

    let inspected: InspectedImage;
    try {
        inspected = await inspectImage(runningImageId);
    } catch (e) {
        return { kind: 'inconclusive', reason: getErrorMessage(e, 'Failed to inspect the running image') };
    }

    if (!Array.isArray(inspected.RepoDigests) || inspected.RepoDigests.length === 0) {
        return { kind: 'inconclusive', reason: 'Running image has no registry digests (not registry-backed or locally built)' };
    }

    const localDigests = selectLocalRepoDigests(inspected.RepoDigests, { registry, repo, tag });
    if (localDigests.length === 0) {
        return { kind: 'inconclusive', reason: `Running image has no digest matching ${registry}/${repo}:${tag}` };
    }

    let result: Awaited<ReturnType<typeof compareLocalToRemoteTagDetailed>>;
    try {
        result = await compareDetailed(
            localDigests,
            registry,
            repo,
            tag,
            { os: inspected.Os, architecture: inspected.Architecture },
            credentials,
        );
    } catch (e) {
        return { kind: 'inconclusive', reason: getErrorMessage(e, 'Registry comparison failed') };
    }

    if (result.kind === 'match') return { kind: 'up_to_date' };
    if (result.kind === 'error') return { kind: 'inconclusive', reason: result.reason ?? 'Registry probe failed' };

    if (!result.primaryDigest) {
        return { kind: 'inconclusive', reason: 'Registry reported an update but returned no digest to identify it' };
    }
    return { kind: 'update', digest: result.primaryDigest };
}

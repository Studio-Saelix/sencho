import crypto from 'crypto';
import { classifyReferenceKind } from '../composeProjectContext';
import { buildEffectiveServiceModel, type EffectiveServiceSpec } from '../effectiveServiceModel';
import DockerController from '../DockerController';
import type { ContainerInfo } from 'dockerode';
import axios from 'axios';
import { RegistryService } from '../RegistryService';
import {
  parseImageRef,
  resolveRegistryImageDigestForPlatform,
  selectLocalRepoDigests,
} from '../registry-api';
import { DatabaseService } from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import { LicenseService } from '../LicenseService';
import { PROXY_TIER_HEADER } from '../license-headers';
import { safeAxiosTransport } from '../../utils/outboundTarget';
import type { BuildContextPlan } from '../../types/gitProjectManifest';
import type { ArtifactQualification } from './types';
import {
  computeArtifactSetFingerprint,
  decodeArtifactEvidenceJson,
  encodeArtifactEvidenceJson,
  isRecord,
  type ArtifactEvidenceJson,
  type ArtifactServiceFailureClass,
  type ObservedArtifactIdentity,
  type ServiceArtifactEvidence,
} from './json';
import { GitOpsStore } from './store';
import { GitOpsTransitions, type EventEnvelope } from './transitions';
import { newGitOpsId } from './directApplication';
import { sanitizeForLog } from '../../utils/safeLog';
import {
  loadEffectiveArtifactContext,
  platformLabelOf,
  type EffectiveArtifactContext,
  type NodePlatform,
} from './effectiveArtifactContext';

const REMOTE_RESOLVE_TIMEOUT_MS = 30_000;

function isComposeOneOff(labels: Record<string, string> | undefined): boolean {
  return labels?.['com.docker.compose.oneoff'] === 'True';
}

const DIGEST_PIN_RE = /@(sha256:[a-f0-9]{64})$/i;

type ServiceQualification = 'unresolved' | 'unavailable' | 'local_build_unverified' | 'qualified' | 'exact';

type ServiceResolveResult = {
  evidence: ServiceArtifactEvidence;
  qualification: ServiceQualification;
};

const SERVICE_QUAL_RANK: Record<ServiceQualification, number> = {
  unresolved: 0,
  unavailable: 1,
  local_build_unverified: 2,
  qualified: 3,
  exact: 4,
};

const APP_QUAL_FROM_SERVICE: Record<ServiceQualification, ArtifactQualification> = {
  unresolved: 'unresolved',
  unavailable: 'unavailable',
  local_build_unverified: 'local_build_unverified',
  qualified: 'qualified',
  exact: 'exact',
};

function weakestQualification(quals: ServiceQualification[]): ArtifactQualification {
  if (quals.length === 0) return 'unresolved';
  let weakest: ServiceQualification = 'exact';
  for (const qual of quals) {
    if (SERVICE_QUAL_RANK[qual] < SERVICE_QUAL_RANK[weakest]) weakest = qual;
  }
  return APP_QUAL_FROM_SERVICE[weakest];
}

function buildContextFingerprint(serviceName: string, buildContexts: readonly BuildContextPlan[]): string | null {
  const ctx = buildContexts.find((entry) => entry.repoPath === serviceName);
  if (!ctx || ctx.excludedFromCopy || ctx.files.length === 0) return null;
  const hashes = ctx.files.map((file) => file.sha256).sort();
  const hex = crypto.createHash('sha256').update(hashes.join('|')).digest('hex');
  return `sha256:${hex}`;
}

function mapRegistryFailure(reason: string): ArtifactServiceFailureClass {
  const lower = reason.toLowerCase();
  if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('credentials')) {
    return 'credential_failure';
  }
  if (lower.includes('ambiguous') || lower.includes('multiple') || lower.includes('confirmed')) {
    return 'platform_ambiguity';
  }
  if (lower.includes('malformed') || lower.includes('no digest')) {
    return 'digest_unavailable';
  }
  return 'registry_unavailable';
}

async function resolveRegistryService(
  serviceName: string,
  authoredRef: string,
  platform: { os: string; architecture: string } | null,
  resolvedAt: number,
): Promise<ServiceResolveResult> {
  const referenceKind = classifyReferenceKind(authoredRef);
  if (referenceKind === 'digest_pinned') {
    const match = authoredRef.match(DIGEST_PIN_RE);
    const digest = match?.[1] ?? null;
    if (!digest) {
      return {
        qualification: 'unresolved',
        evidence: {
          serviceName,
          authoredRef,
          source: 'registry',
          platform: null,
          indexDigest: null,
          platformDigest: null,
          buildContextFingerprint: null,
          producedImageId: null,
          failureClass: 'digest_unavailable',
          resolvedAt,
        },
      };
    }
    return {
      qualification: 'exact',
      evidence: {
        serviceName,
        authoredRef,
        source: 'registry',
        platform: platform ? `${platform.os}/${platform.architecture}` : null,
        indexDigest: digest,
        platformDigest: digest,
        buildContextFingerprint: null,
        producedImageId: null,
        failureClass: null,
        resolvedAt,
      },
    };
  }

  const parsed = parseImageRef(authoredRef);
  if (!parsed) {
    return {
      qualification: 'unavailable',
      evidence: {
        serviceName,
        authoredRef,
        source: 'unsupported',
        platform: null,
        indexDigest: null,
        platformDigest: null,
        buildContextFingerprint: null,
        producedImageId: null,
        failureClass: 'unsupported_registry',
        resolvedAt,
      },
    };
  }
  if (!platform) {
    return {
      qualification: 'unavailable',
      evidence: {
        serviceName,
        authoredRef,
        source: 'registry',
        platform: null,
        indexDigest: null,
        platformDigest: null,
        buildContextFingerprint: null,
        producedImageId: null,
        failureClass: 'platform_ambiguity',
        resolvedAt,
      },
    };
  }

  const credentials = await RegistryService.getInstance().getAuthForRegistry(parsed.registry);
  const remote = await resolveRegistryImageDigestForPlatform(
    parsed.registry,
    parsed.repo,
    parsed.tag,
    platform,
    credentials,
  );
  if (!remote.ok) {
    return {
      qualification: 'unavailable',
      evidence: {
        serviceName,
        authoredRef,
        source: 'registry',
        platform: `${platform.os}/${platform.architecture}`,
        indexDigest: null,
        platformDigest: null,
        buildContextFingerprint: null,
        producedImageId: null,
        failureClass: mapRegistryFailure(remote.reason),
        resolvedAt,
      },
    };
  }
  return {
    qualification: remote.qualification,
    evidence: {
      serviceName,
      authoredRef,
      source: 'registry',
      platform: remote.platformLabel,
      indexDigest: remote.indexDigest,
      platformDigest: remote.platformDigest,
      platformVariants: remote.platformVariants && remote.platformVariants.length > 0
        ? [...remote.platformVariants].sort((a, b) => a.platform.localeCompare(b.platform))
        : [{ platform: remote.platformLabel, digest: remote.platformDigest }],
      buildContextFingerprint: null,
      producedImageId: null,
      failureClass: null,
      resolvedAt,
    },
  };
}

async function resolveOneService(
  spec: EffectiveServiceSpec,
  platform: { os: string; architecture: string } | null,
  buildContexts: readonly BuildContextPlan[],
  resolvedAt: number,
): Promise<ServiceResolveResult> {
  if (spec.hasBuild) {
    return {
      qualification: 'local_build_unverified',
      evidence: {
        serviceName: spec.name,
        authoredRef: spec.declaredImage,
        source: 'build',
        platform: platform ? `${platform.os}/${platform.architecture}` : null,
        indexDigest: null,
        platformDigest: null,
        buildContextFingerprint: buildContextFingerprint(spec.name, buildContexts),
        producedImageId: null,
        failureClass: null,
        resolvedAt,
      },
    };
  }
  if (!spec.declaredImage) {
    return {
      qualification: 'unresolved',
      evidence: {
        serviceName: spec.name,
        authoredRef: null,
        source: 'unsupported',
        platform: null,
        indexDigest: null,
        platformDigest: null,
        buildContextFingerprint: null,
        producedImageId: null,
        failureClass: 'unresolved',
        resolvedAt,
      },
    };
  }
  try {
    return await resolveRegistryService(spec.name, spec.declaredImage, platform, resolvedAt);
  } catch (error) {
    console.error(
      `[GitOpsArtifactResolve] Registry resolve failed for ${spec.name}:`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      qualification: 'unavailable',
      evidence: {
        serviceName: spec.name,
        authoredRef: spec.declaredImage,
        source: 'registry',
        platform: platform ? `${platform.os}/${platform.architecture}` : null,
        indexDigest: null,
        platformDigest: null,
        buildContextFingerprint: null,
        producedImageId: null,
        failureClass: 'registry_unavailable',
        resolvedAt,
      },
    };
  }
}

function isNodePlatform(value: unknown): value is NodePlatform {
  return isRecord(value)
    && typeof value.os === 'string'
    && value.os.length > 0
    && typeof value.architecture === 'string'
    && value.architecture.length > 0;
}

function isEffectiveServiceSpec(value: unknown): value is EffectiveServiceSpec {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.name.length > 0
    && (value.declaredImage === null || typeof value.declaredImage === 'string')
    && typeof value.hasBuild === 'boolean'
    && typeof value.expectedReplicas === 'number'
    && Array.isArray(value.dependsOn)
    && typeof value.hasHealthcheck === 'boolean';
}

function isEffectiveArtifactContext(value: unknown): value is EffectiveArtifactContext {
  if (!isRecord(value) || !Array.isArray(value.services)) return false;
  if (value.platform !== null && !isNodePlatform(value.platform)) return false;
  if (value.renderable === true) {
    return value.services.every(isEffectiveServiceSpec);
  }
  if (value.renderable === false) {
    return value.services.length === 0 && typeof value.error === 'string';
  }
  return false;
}

/**
 * Fetch the leaf's rendered model and Docker platform over the node proxy.
 * Never interprets the remote node's compose_dir as a hub-local path.
 */
export async function fetchRemoteEffectiveArtifactContext(
  nodeId: number,
  stackName: string,
): Promise<EffectiveArtifactContext | null> {
  const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
  if (!target) {
    console.warn(
      '[GitOpsArtifactResolve] No proxy target for remote effective-artifact-context on node %s (%s)',
      nodeId,
      sanitizeForLog(stackName),
    );
    return null;
  }
  const proxy = LicenseService.getInstance().getProxyHeaders();
  const url = `${target.apiUrl.replace(/\/$/, '')}/api/stacks/${encodeURIComponent(stackName)}/effective-artifact-context`;
  try {
    const res = await axios.get(url, {
      ...safeAxiosTransport(target.trustedLoopback),
      headers: {
        Authorization: `Bearer ${target.apiToken}`,
        [PROXY_TIER_HEADER]: proxy.tier,
        'Content-Type': 'application/json',
      },
      timeout: REMOTE_RESOLVE_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      console.warn(
        '[GitOpsArtifactResolve] Remote effective-artifact-context returned %s for %s on node %s',
        res.status,
        sanitizeForLog(stackName),
        nodeId,
      );
      return null;
    }
    if (!isEffectiveArtifactContext(res.data)) {
      console.warn(
        '[GitOpsArtifactResolve] Remote effective-artifact-context invalid shape for %s on node %s',
        sanitizeForLog(stackName),
        nodeId,
      );
      return null;
    }
    return res.data;
  } catch (err) {
    console.warn(
      '[GitOpsArtifactResolve] Remote effective-artifact-context failed for %s on node %s: %s',
      sanitizeForLog(stackName),
      nodeId,
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

async function loadArtifactContextForNode(
  nodeId: number,
  stackName: string,
): Promise<EffectiveArtifactContext | null> {
  const node = DatabaseService.getInstance().getNode(nodeId);
  if (!node) return null;
  if (node.type === 'remote') {
    return fetchRemoteEffectiveArtifactContext(nodeId, stackName);
  }
  return loadEffectiveArtifactContext(nodeId, stackName);
}

/** Platform label for digest pins: leaf context for remote, local Docker for hub. */
export async function resolvePlatformLabelForNode(nodeId: number, stackName: string): Promise<string | null> {
  const ctx = await loadArtifactContextForNode(nodeId, stackName);
  return platformLabelOf(ctx?.platform ?? null);
}

async function resolveServices(
  stackName: string,
  nodeId: number,
  buildContexts: readonly BuildContextPlan[],
  resolvedAt: number,
): Promise<{ services: ServiceArtifactEvidence[]; qualification: ArtifactQualification; evidence: ArtifactEvidenceJson }> {
  const context = await loadArtifactContextForNode(nodeId, stackName);
  if (context && !context.renderable) {
    console.warn(
      '[GitOpsArtifactResolve] Composed model not renderable for %s on node %s: %s',
      sanitizeForLog(stackName),
      nodeId,
      sanitizeForLog(context.error),
    );
  }
  if (!context || !context.renderable) {
    return {
      services: [],
      qualification: 'unresolved',
      evidence: { kind: 'unresolved' },
    };
  }

  const platform = context.platform;
  const resolved = await Promise.all(
    context.services.map((spec) => resolveOneService(spec, platform, buildContexts, resolvedAt)),
  );
  const serviceQuals = resolved.map((entry) => entry.qualification);
  const services = resolved.map((entry) => entry.evidence);

  const qualification = weakestQualification(serviceQuals);
  const evidence = buildArtifactEvidence(qualification, services);
  return { services, qualification, evidence };
}

function buildArtifactEvidence(
  qualification: ArtifactQualification,
  services: ServiceArtifactEvidence[],
): ArtifactEvidenceJson {
  const fingerprint = services.length > 0 ? computeArtifactSetFingerprint(services) : null;
  switch (qualification) {
    case 'exact':
      return { kind: 'exact', identity: fingerprint!, services };
    case 'qualified':
      return { kind: 'qualified', identity: fingerprint!, services };
    case 'local_build_unverified':
      return { kind: 'local_build_unverified', identity: fingerprint, services };
    case 'unavailable':
      return { kind: 'unavailable', services };
    case 'stale':
      return { kind: 'stale', identity: fingerprint, services };
    default:
      return { kind: 'unresolved', services };
  }
}

function nextEvidenceVersion(generationId: string): number {
  const maxRow = DatabaseService.getInstance().getDb().prepare(
    'SELECT MAX(evidence_version) AS max FROM gitops_artifact_sets WHERE generation_id = ?',
  ).get(generationId) as { max: number | null };
  return (maxRow.max ?? 0) + 1;
}

function recordResolvedEvidence(args: {
  applicationId: string;
  generationId: string;
  qualification: ArtifactQualification;
  evidence: ArtifactEvidenceJson;
  envelope: EventEnvelope;
}): void {
  const evidenceJson = encodeArtifactEvidenceJson(args.evidence);
  GitOpsTransitions.getInstance().recordArtifactEvidence({
    applicationId: args.applicationId,
    generationId: args.generationId,
    artifactSetId: newGitOpsId(),
    evidenceVersion: nextEvidenceVersion(args.generationId),
    qualification: args.qualification,
    evidenceJson,
    authoritative: 0,
    envelope: args.envelope,
  });
}

export async function resolveAndRecordArtifactSet(args: {
  stackName: string;
  nodeId: number;
  applicationId: string;
  generationId: string;
  buildContexts: readonly BuildContextPlan[];
  envelope: EventEnvelope;
}): Promise<void> {
  try {
    const resolvedAt = args.envelope.at;
    const { qualification, evidence } = await resolveServices(
      args.stackName,
      args.nodeId,
      args.buildContexts,
      resolvedAt,
    );
    recordResolvedEvidence({
      applicationId: args.applicationId,
      generationId: args.generationId,
      qualification,
      evidence,
      envelope: args.envelope,
    });
  } catch (error) {
    console.error(
      `[GitOpsArtifactResolve] Resolution failed for ${args.applicationId}/${args.generationId}:`,
      error instanceof Error ? error.message : String(error),
    );
    recordResolvedEvidence({
      applicationId: args.applicationId,
      generationId: args.generationId,
      qualification: 'unavailable',
      evidence: { kind: 'unavailable' },
      envelope: args.envelope,
    });
  }
}

export async function probeStaleArtifactEvidence(args: {
  stackName: string;
  nodeId: number;
  applicationId: string;
  generationId: string;
  buildContexts: readonly BuildContextPlan[];
  envelope: EventEnvelope;
}): Promise<void> {
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(args.applicationId);
  if (!app?.artifact_set_id) return;
  const expectedRow = store.getArtifactSet(app.artifact_set_id);
  if (!expectedRow) return;
  let expectedEvidence: ArtifactEvidenceJson;
  try {
    expectedEvidence = decodeArtifactEvidenceJson(expectedRow.evidence_json);
  } catch {
    return;
  }
  const expectedIdentity = 'identity' in expectedEvidence ? expectedEvidence.identity : null;
  if (!expectedIdentity) return;

  try {
    const resolvedAt = args.envelope.at;
    const { qualification, evidence } = await resolveServices(
      args.stackName,
      args.nodeId,
      args.buildContexts,
      resolvedAt,
    );
    const latestIdentity = 'identity' in evidence ? evidence.identity : null;
    if (!latestIdentity || latestIdentity === expectedIdentity) return;
    if (qualification === 'unresolved' || qualification === 'unavailable') return;
    recordResolvedEvidence({
      applicationId: args.applicationId,
      generationId: args.generationId,
      qualification: 'stale',
      evidence: {
        kind: 'stale',
        identity: latestIdentity,
        services: evidence.services,
      },
      envelope: args.envelope,
    });
  } catch (error) {
    console.error(
      `[GitOpsArtifactResolve] Stale probe failed for ${args.applicationId}/${args.generationId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function unresolvedRuntimeEvidence(
  serviceName: string,
  declaredImage: string | null,
  observedAt: number,
): ServiceResolveResult {
  return {
    qualification: 'unresolved',
    evidence: {
      serviceName,
      authoredRef: declaredImage,
      source: declaredImage ? 'registry' : 'unsupported',
      platform: null,
      indexDigest: null,
      platformDigest: null,
      buildContextFingerprint: null,
      producedImageId: null,
      failureClass: 'unresolved',
      resolvedAt: observedAt,
    },
  };
}

async function observeServiceRuntime(
  docker: ReturnType<DockerController['getDocker']>,
  stackName: string,
  serviceName: string,
  declaredImage: string | null,
  observedAt: number,
): Promise<ServiceResolveResult> {
  const listed = await docker.listContainers({
    all: true,
    filters: {
      label: [
        `com.docker.compose.project=${stackName}`,
        `com.docker.compose.service=${serviceName}`,
      ],
    },
  });
  const running = listed.find((entry: ContainerInfo) => {
    const labels = (entry.Labels ?? {}) as Record<string, string>;
    return !isComposeOneOff(labels) && entry.State === 'running';
  });
  if (!running) return unresolvedRuntimeEvidence(serviceName, declaredImage, observedAt);

  try {
    const inspect = await docker.getContainer(running.Id).inspect();
    const imageId = typeof inspect.Image === 'string' ? inspect.Image : null;
    if (!imageId) return unresolvedRuntimeEvidence(serviceName, declaredImage, observedAt);

    const image = await docker.getImage(imageId).inspect();
    const platform = image.Os && image.Architecture ? `${image.Os}/${image.Architecture}` : null;
    const parsed = declaredImage ? parseImageRef(declaredImage) : null;
    const repoDigests = selectLocalRepoDigests(image.RepoDigests ?? [], parsed ?? {
      registry: 'registry-1.docker.io',
      repo: serviceName,
      tag: 'latest',
    });
    const localDigests = [...repoDigests].sort((a, b) => a.localeCompare(b));
    const hasRepoDigest = localDigests.length > 0;
    const platformDigest = localDigests[0] ?? null;
    const producedImageId = imageId.replace(/^sha256:/, '');
    const qualification: ServiceQualification = hasRepoDigest ? 'exact' : 'local_build_unverified';
    return {
      qualification,
      evidence: {
        serviceName,
        authoredRef: declaredImage,
        source: hasRepoDigest ? 'registry' : 'build',
        platform,
        indexDigest: null,
        platformDigest,
        localDigests: hasRepoDigest ? localDigests : null,
        buildContextFingerprint: null,
        producedImageId,
        failureClass: null,
        resolvedAt: observedAt,
      },
    };
  } catch {
    return unresolvedRuntimeEvidence(serviceName, declaredImage, observedAt);
  }
}

function recordRuntimeObservation(
  args: { applicationId: string; nodeId: number; envelope: EventEnvelope },
  observed: ObservedArtifactIdentity,
): void {
  GitOpsTransitions.getInstance().recordObservedRuntimeArtifact({
    applicationId: args.applicationId,
    nodeId: args.nodeId,
    observed,
    envelope: args.envelope,
  });
}

/**
 * Observe the running image identity for a stack on a node.
 * Does not require a GitOps application or generation; callers record when they have one.
 * Compose project labels use the lowercase stack name (Docker Compose convention).
 */
export async function observeStackRuntimeArtifact(args: {
  stackName: string;
  nodeId: number;
  observedAt?: number;
}): Promise<ObservedArtifactIdentity> {
  const observedAt = args.observedAt ?? Date.now();
  const projectName = args.stackName.toLowerCase();
  try {
    const model = await buildEffectiveServiceModel(args.nodeId, args.stackName);
    if (!model.renderable) {
      return { kind: 'unavailable' };
    }

    const docker = DockerController.getInstance(args.nodeId).getDocker();
    const observed = await Promise.all(
      model.services.map((spec) =>
        observeServiceRuntime(docker, projectName, spec.name, spec.declaredImage, observedAt),
      ),
    );
    const serviceQuals = observed.map((entry) => entry.qualification);
    const services = observed.map((entry) => entry.evidence);

    if (services.every((service) => service.failureClass === 'unresolved' && !service.platformDigest)) {
      return { kind: 'missing' };
    }

    const qualification = weakestQualification(serviceQuals);
    if (
      qualification !== 'exact' &&
      qualification !== 'qualified' &&
      qualification !== 'local_build_unverified'
    ) {
      return { kind: 'unavailable' };
    }

    return {
      kind: qualification,
      identity: computeArtifactSetFingerprint(services),
      observedAt,
      services,
    };
  } catch (error) {
    console.error(
      '[GitOpsArtifactResolve] Runtime observation failed for stack %s:',
      sanitizeForLog(args.stackName),
      error instanceof Error ? error.message : String(error),
    );
    return { kind: 'unavailable' };
  }
}

export async function recordObservedRuntimeArtifactForDeploy(args: {
  stackName: string;
  nodeId: number;
  applicationId: string;
  envelope: EventEnvelope;
}): Promise<void> {
  try {
    const observed = await observeStackRuntimeArtifact({
      stackName: args.stackName,
      nodeId: args.nodeId,
      observedAt: args.envelope.at,
    });
    recordRuntimeObservation(args, observed);
  } catch (error) {
    console.error(
      `[GitOpsArtifactResolve] Runtime observation failed for ${args.applicationId}:`,
      error instanceof Error ? error.message : String(error),
    );
    try {
      recordRuntimeObservation(args, { kind: 'unavailable' });
    } catch (recordError) {
      console.error(
        `[GitOpsArtifactResolve] Failed to record unavailable observation for ${args.applicationId}:`,
        recordError instanceof Error ? recordError.message : String(recordError),
      );
    }
  }
}

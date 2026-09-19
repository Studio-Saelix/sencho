import axios from 'axios';

import {
  buildSealedAuthsAad,
  openAuths,
} from '../../helpers/registryEnvelopeSeal';
import {
  getRegistryDeliveryContext,
  type RegistryDeliveryAuthEntry,
} from '../../helpers/registryDeliveryContext';
import { attestationJtiFromToken } from '../../helpers/registryDeliveryEvidence';
import { hashActionSet } from '../../helpers/registryDeliveryHashes';
import {
  parsePullReference,
  pullReferenceHost,
} from '../../helpers/registryPullReference';
import {
  probeManifestAnonymous,
  splitPullRefForProbe,
} from '../../helpers/registrySafeProbe';
import {
  probeRemoteCapability,
  type RemoteCapabilityProbe,
} from '../../helpers/remoteCapabilities';
import { safeAxiosTransport } from '../../utils/outboundTarget';
import { sanitizeForLog } from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errors';
import {
  REMOTE_REGISTRY_EXACT_REF_CONTRACT_VERSION,
  REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY,
} from '../CapabilityRegistry';
import { NodeRegistry } from '../NodeRegistry';
import {
  ECR_CACHE_SAFETY_MS,
  RegistryService,
  type DockerConfigHostResolution,
} from '../RegistryService';
import type {
  RegistryDeliveryDiscoverRequest,
  RegistryDeliveryDiscoverResponse,
} from '../RegistryDeliveryService';
import { decodeArtifactEvidenceJson } from './json';
import {
  buildPreflightEvidence,
  type PreflightEvidenceBody,
  type PreflightRegistryTargetEvidence,
  type RegistryCredentialSourceClass,
  type RegistryTargetReadinessClass,
} from './preflight';
import { GitOpsStore } from './store';

const DISCOVER_TIMEOUT_MS = 30_000;
const REGISTRY_DELIVERY_FIELD_LIMIT_BYTES = 256 * 1024;

export type RegistryReadinessDeps = {
  probeRemoteCapability: (
    nodeId: number,
    capability: string,
    abortSignal?: AbortSignal,
  ) => Promise<RemoteCapabilityProbe>;
  probeManifestAnonymous: typeof probeManifestAnonymous;
  resolveHubDockerConfigForHost: (host: string) => Promise<DockerConfigHostResolution>;
  discoverOnTarget: (
    nodeId: number,
    payload: RegistryDeliveryDiscoverRequest,
  ) => Promise<RegistryDeliveryDiscoverResponse>;
  isControlNode: (nodeId: number) => boolean;
  nowMs: () => number;
  abortSignal?: AbortSignal;
};

export type EvaluateRegistryReadinessInput = {
  artifactSetId: string | null;
  requiredNodeIds: readonly number[];
  /** Stack identity used when building a body-content discover request. */
  stackName?: string | null;
  /** Accepted compose YAML for remote discover (body-content). */
  composeContent?: string | null;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Registry readiness evaluation aborted');
  }
}

/** Hostnames named in the inbound delivery envelope for this dispatch only. */
export function envelopeCoverageHosts(): Set<string> {
  const ctx = getRegistryDeliveryContext();
  if (!ctx) return new Set();
  const hosts = new Set<string>();
  try {
    let entries: RegistryDeliveryAuthEntry[];
    if (ctx.envelope.auths) {
      entries = ctx.envelope.auths;
    } else if (ctx.envelope.sealedAuths) {
      const jti = attestationJtiFromToken(ctx.envelope.attestation);
      if (!jti) return hosts;
      const aad = buildSealedAuthsAad(
        ctx.envelope.deliverySourceId,
        jti,
        ctx.envelope.prepId,
      );
      entries = openAuths(ctx.envelope.sealedAuths, aad);
    } else {
      return hosts;
    }
    for (const entry of entries) {
      if (typeof entry.host === 'string' && entry.host.length > 0) {
        hosts.add(entry.host);
      }
    }
  } catch (err) {
    console.warn(
      '[registryReadiness] Could not read inbound delivery envelope hosts:',
      sanitizeForLog(getErrorMessage(err, 'unknown')),
    );
  }
  return hosts;
}

/**
 * Registry hosts required by the artifact set. Empty means no registry-backed
 * services (or none with an authored ref). Null means the set is unresolved
 * or missing and readiness must stay unknown.
 */
export function deriveRequiredRegistryHosts(artifactSetId: string | null): string[] | null {
  if (!artifactSetId) return null;
  const row = GitOpsStore.getInstance().getArtifactSet(artifactSetId);
  if (!row) return null;
  let decoded;
  try {
    decoded = decodeArtifactEvidenceJson(row.evidence_json);
  } catch {
    return null;
  }
  if (!decoded.services || decoded.services.length === 0) {
    // Unresolved / empty services: cannot invent hosts from Compose.
    if (decoded.kind === 'unresolved' || decoded.kind === 'unavailable') return null;
    return [];
  }
  const hosts = new Set<string>();
  for (const service of decoded.services) {
    if (service.source !== 'registry') continue;
    if (!service.authoredRef) continue;
    const parsed = parsePullReference(service.authoredRef);
    if (!parsed) continue;
    try {
      hosts.add(pullReferenceHost(parsed));
    } catch {
      // Malformed host segment: skip this service, do not invent.
    }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

async function defaultDiscoverOnTarget(
  nodeId: number,
  payload: RegistryDeliveryDiscoverRequest,
  abortSignal?: AbortSignal,
): Promise<RegistryDeliveryDiscoverResponse> {
  throwIfAborted(abortSignal);
  const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
  if (!target) {
    throw new Error('Registry delivery discovery target is unreachable');
  }
  const base = target.apiUrl.replace(/\/$/, '');
  const res = await axios.post(`${base}/api/registry-delivery/discover`, payload, {
    ...safeAxiosTransport(target.trustedLoopback),
    headers: { Authorization: `Bearer ${target.apiToken}` },
    timeout: DISCOVER_TIMEOUT_MS,
    maxBodyLength: REGISTRY_DELIVERY_FIELD_LIMIT_BYTES,
    maxContentLength: REGISTRY_DELIVERY_FIELD_LIMIT_BYTES,
    signal: abortSignal,
    validateStatus: () => true,
  });
  throwIfAborted(abortSignal);
  if (res.status < 200 || res.status >= 300) {
    throw Object.assign(
      new Error(
        typeof res.data?.error === 'string'
          ? res.data.error
          : 'Registry delivery discovery failed on target',
      ),
      { status: res.status },
    );
  }
  const data = res.data as RegistryDeliveryDiscoverResponse;
  if (
    !data
    || typeof data !== 'object'
    || !Array.isArray(data.coveredHosts)
    || !Array.isArray(data.referencedHosts)
  ) {
    throw new Error('Registry delivery discovery response failed validation');
  }
  return data;
}

export function createDefaultRegistryReadinessDeps(
  abortSignal?: AbortSignal,
): RegistryReadinessDeps {
  const registry = RegistryService.getInstance();
  return {
    probeRemoteCapability,
    probeManifestAnonymous,
    resolveHubDockerConfigForHost: (host) => registry.resolveDockerConfigForHostDetailed(host),
    discoverOnTarget: (nodeId, payload) => defaultDiscoverOnTarget(nodeId, payload, abortSignal),
    isControlNode: (nodeId) => nodeId === NodeRegistry.getInstance().getDefaultNodeId(),
    nowMs: () => Date.now(),
    abortSignal,
  };
}

function buildDiscoverRequest(
  input: EvaluateRegistryReadinessInput,
): RegistryDeliveryDiscoverRequest | null {
  const stack = input.stackName?.trim();
  if (!stack) return null;
  const compose = input.composeContent;
  if (typeof compose === 'string' && compose.length > 0) {
    return {
      stack,
      stackName: stack,
      op: 'blueprint-apply',
      sourceKind: 'body-content',
      composeContent: compose,
      actionSetHash: hashActionSet(['stack:deploy']),
      contractVersion: REMOTE_REGISTRY_EXACT_REF_CONTRACT_VERSION,
    };
  }
  return {
    stack,
    op: 'stack-deploy',
    sourceKind: 'live-project',
    actionSetHash: hashActionSet(['stack:deploy']),
    contractVersion: REMOTE_REGISTRY_EXACT_REF_CONTRACT_VERSION,
  };
}

type HostClass = 'public' | 'challenged' | 'inconclusive';

/** Classify each required host using authored refs so probes hit the real repo. */
async function classifyHostsFromRefs(
  refsByHost: Map<string, string>,
  deps: RegistryReadinessDeps,
): Promise<Map<string, HostClass>> {
  const out = new Map<string, HostClass>();
  for (const [host, ref] of refsByHost) {
    throwIfAborted(deps.abortSignal);
    let classification: HostClass = 'inconclusive';
    try {
      const result = await deps.probeManifestAnonymous(
        splitPullRefForProbe(ref),
        deps.abortSignal,
      );
      if (result.classification === 'public') classification = 'public';
      else if (result.classification === 'challenged') classification = 'challenged';
    } catch (err) {
      if (deps.abortSignal?.aborted) throw err;
      console.warn(
        '[registryReadiness] Anonymous probe failed:',
        sanitizeForLog(host),
        sanitizeForLog(getErrorMessage(err, 'unknown')),
      );
    }
    out.set(host, classification);
  }
  return out;
}

function authoredRefsByHost(artifactSetId: string): Map<string, string> {
  const map = new Map<string, string>();
  const row = GitOpsStore.getInstance().getArtifactSet(artifactSetId);
  if (!row) return map;
  let decoded;
  try {
    decoded = decodeArtifactEvidenceJson(row.evidence_json);
  } catch {
    return map;
  }
  for (const service of decoded.services ?? []) {
    if (service.source !== 'registry' || !service.authoredRef) continue;
    const parsed = parsePullReference(service.authoredRef);
    if (!parsed) continue;
    let host: string;
    try {
      host = pullReferenceHost(parsed);
    } catch {
      continue;
    }
    if (!map.has(host)) map.set(host, parsed.value);
  }
  return map;
}

function resolutionExpired(
  resolution: DockerConfigHostResolution,
  nowMs: number,
): boolean {
  if (typeof resolution.expiresAt !== 'number') return false;
  return resolution.expiresAt - ECR_CACHE_SAFETY_MS <= nowMs;
}

async function resolveChallengedHost(
  host: string,
  covered: ReadonlySet<string>,
  envelopeHosts: ReadonlySet<string>,
  deps: RegistryReadinessDeps,
): Promise<{
  readiness: RegistryTargetReadinessClass;
  sourceClass: RegistryCredentialSourceClass;
  expired: boolean;
}> {
  if (covered.has(host)) {
    return { readiness: 'ready', sourceClass: 'node_local', expired: false };
  }
  if (envelopeHosts.has(host)) {
    return { readiness: 'ready', sourceClass: 'hub_ephemeral', expired: false };
  }
  let resolution: DockerConfigHostResolution;
  try {
    resolution = await deps.resolveHubDockerConfigForHost(host);
  } catch (err) {
    console.warn(
      '[registryReadiness] Hub registry resolution failed:',
      sanitizeForLog(host),
      sanitizeForLog(getErrorMessage(err, 'unknown')),
    );
    return { readiness: 'unknown', sourceClass: 'hub_ephemeral', expired: false };
  }
  if (resolution.state === 'missing') {
    return { readiness: 'auth_missing', sourceClass: 'hub_ephemeral', expired: false };
  }
  if (resolution.state === 'unavailable') {
    return { readiness: 'auth_invalid', sourceClass: 'hub_ephemeral', expired: false };
  }
  if (resolutionExpired(resolution, deps.nowMs())) {
    return { readiness: 'auth_expired', sourceClass: 'hub_ephemeral', expired: true };
  }
  return { readiness: 'ready', sourceClass: 'hub_ephemeral', expired: false };
}

function unknownTarget(nodeId: number, hosts: readonly string[]): PreflightRegistryTargetEvidence {
  return {
    nodeId,
    sourceClass: 'hub_ephemeral',
    readiness: 'unknown',
    hosts: [...hosts],
    expired: false,
  };
}

async function evaluateOneTarget(
  nodeId: number,
  hosts: readonly string[],
  hostClass: Map<string, HostClass>,
  input: EvaluateRegistryReadinessInput,
  deps: RegistryReadinessDeps,
  envelopeHosts: ReadonlySet<string>,
): Promise<PreflightRegistryTargetEvidence> {
  throwIfAborted(deps.abortSignal);

  const challenged = hosts.filter((h) => hostClass.get(h) === 'challenged');
  const inconclusive = hosts.filter((h) => hostClass.get(h) === 'inconclusive');
  // Any inconclusive host without a challenged sibling must not look ready:
  // mixed public + inconclusive previously failed open as not_required.
  if (challenged.length === 0 && inconclusive.length > 0) {
    return unknownTarget(nodeId, hosts);
  }
  if (challenged.length === 0) {
    return {
      nodeId,
      sourceClass: 'public',
      readiness: 'not_required',
      hosts: [...hosts],
      expired: false,
    };
  }

  let covered = new Set<string>();
  if (!deps.isControlNode(nodeId)) {
    const capability = await deps.probeRemoteCapability(
      nodeId,
      REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY,
      deps.abortSignal,
    );
    if (capability.kind === 'unsupported') {
      return {
        nodeId,
        sourceClass: 'hub_ephemeral',
        readiness: 'capability_unsupported',
        hosts: [...hosts],
        expired: false,
      };
    }
    if (capability.kind === 'unreachable') {
      return unknownTarget(nodeId, hosts);
    }
    const discoverRequest = buildDiscoverRequest(input);
    if (!discoverRequest) {
      return unknownTarget(nodeId, hosts);
    }
    try {
      const discover = await deps.discoverOnTarget(nodeId, discoverRequest);
      covered = new Set(discover.coveredHosts);
    } catch (err) {
      if (deps.abortSignal?.aborted) throw err;
      const message = getErrorMessage(err, 'unknown');
      const tls = /certificate|TLS|SSL|self.?signed|UNABLE_TO_VERIFY/i.test(message);
      console.warn(
        '[registryReadiness] Discover failed:',
        sanitizeForLog(nodeId),
        sanitizeForLog(message),
      );
      return {
        nodeId,
        sourceClass: 'hub_ephemeral',
        readiness: tls ? 'tls_trust_failed' : 'registry_unreachable',
        hosts: [...hosts],
        expired: false,
      };
    }
  }

  let worst: RegistryTargetReadinessClass = 'ready';
  let sourceClass: RegistryCredentialSourceClass = 'public';
  let anyExpired = false;
  const priority: RegistryTargetReadinessClass[] = [
    'capability_unsupported',
    'auth_missing',
    'auth_invalid',
    'auth_expired',
    'tls_trust_failed',
    'registry_unreachable',
    'unknown',
    'ready',
    'not_required',
  ];
  const worse = (a: RegistryTargetReadinessClass, b: RegistryTargetReadinessClass) =>
    priority.indexOf(a) < priority.indexOf(b) ? a : b;

  for (const host of challenged) {
    const resolved = await resolveChallengedHost(host, covered, envelopeHosts, deps);
    worst = worse(worst, resolved.readiness);
    if (resolved.sourceClass === 'node_local') sourceClass = 'node_local';
    else if (resolved.sourceClass === 'hub_ephemeral' && sourceClass !== 'node_local') {
      sourceClass = 'hub_ephemeral';
    }
    if (resolved.expired) anyExpired = true;
  }

  if (inconclusive.length > 0 && worst === 'ready') {
    worst = 'unknown';
    if (sourceClass === 'public') sourceClass = 'hub_ephemeral';
  }

  const finalSource: RegistryCredentialSourceClass =
    challenged.length === 0
      ? 'public'
      : sourceClass === 'public'
        ? 'hub_ephemeral'
        : sourceClass;

  return {
    nodeId,
    sourceClass: finalSource,
    readiness: worst,
    hosts: [...hosts],
    expired: anyExpired,
  };
}

/**
 * Evaluate private-registry readiness for the required targets against an
 * artifact set. Never returns credential material. Failures and timeouts
 * produce `unknown` evidence rather than throwing to the dispatcher.
 */
export async function evaluateRegistryReadiness(
  input: EvaluateRegistryReadinessInput,
  depsPartial?: Partial<RegistryReadinessDeps>,
): Promise<PreflightEvidenceBody> {
  const defaults = createDefaultRegistryReadinessDeps(depsPartial?.abortSignal);
  const deps: RegistryReadinessDeps = { ...defaults, ...depsPartial };

  const nodeIds = [...new Set(input.requiredNodeIds)].sort((a, b) => a - b);
  if (nodeIds.length === 0) {
    return buildPreflightEvidence({
      artifactSetId: input.artifactSetId,
      targets: [],
    });
  }

  try {
    throwIfAborted(deps.abortSignal);
    const hostsOrNull = deriveRequiredRegistryHosts(input.artifactSetId);
    if (hostsOrNull === null) {
      return buildPreflightEvidence({
        artifactSetId: input.artifactSetId,
        targets: nodeIds.map((nodeId) => unknownTarget(nodeId, [])),
      });
    }

    if (hostsOrNull.length === 0) {
      return buildPreflightEvidence({
        artifactSetId: input.artifactSetId,
        targets: nodeIds.map((nodeId) => ({
          nodeId,
          sourceClass: 'public' as const,
          readiness: 'not_required' as const,
          hosts: [],
          expired: false,
        })),
      });
    }

    const refsByHost = input.artifactSetId
      ? authoredRefsByHost(input.artifactSetId)
      : new Map<string, string>();
    // Prefer authored refs; fall back to host-only keys so classification still runs.
    if (refsByHost.size === 0) {
      for (const host of hostsOrNull) {
        refsByHost.set(host, `${host}/library/alpine:latest`);
      }
    }
    const hostClass = await classifyHostsFromRefs(refsByHost, deps);

    const envelopeHosts = envelopeCoverageHosts();
    const targets: PreflightRegistryTargetEvidence[] = [];
    for (const nodeId of nodeIds) {
      targets.push(
        await evaluateOneTarget(nodeId, hostsOrNull, hostClass, input, deps, envelopeHosts),
      );
    }

    return buildPreflightEvidence({
      artifactSetId: input.artifactSetId,
      targets,
    });
  } catch (err) {
    console.warn(
      '[registryReadiness] Evaluation failed; recording unknown:',
      sanitizeForLog(getErrorMessage(err, 'unknown')),
    );
    return buildPreflightEvidence({
      artifactSetId: input.artifactSetId,
      targets: nodeIds.map((nodeId) => unknownTarget(nodeId, [])),
    });
  }
}

import axios from 'axios';
import type { Node } from '../services/DatabaseService';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry, type ProxyTarget } from '../services/NodeRegistry';
import { safeAxiosTransport } from '../utils/outboundTarget';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import type { RegistryDeliveryDiscoverResponse } from '../services/RegistryDeliveryService';
import { REMOTE_REGISTRY_EXACT_REF_CONTRACT_VERSION, REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY } from '../services/CapabilityRegistry';
import { probeRemoteCapability, type RemoteCapabilityProbe } from './remoteCapabilities';
import {
  assertSafeRegistryHost,
  probeManifestAnonymous,
  splitPullRefForProbe,
  UnsafeRegistryHopError,
} from './registrySafeProbe';
import { canonicalRefHost, normalizePullRefList, PULL_REF_MAX_COUNT } from './registryPullReference';
import {
  classifyRegistryDeliveryRouteClass,
  getRegistryDeliveryTotalBodyLimit,
  REGISTRY_DELIVERY_BODY_FIELD,
  REGISTRY_DELIVERY_FIELD_LIMIT_BYTES,
} from './registryDeliveryBodyLimits';
import { classifyRegistryDeliveryOp } from './registryOpClassifier';
import { buildRegistryDiscoverPayload } from './registryDeliveryDiscoverPayload';
import { getErrorMessage } from '../utils/errors';

export const REGISTRY_DELIVERY_ABORTED = 'REGISTRY_DELIVERY_ABORTED';
const REGISTRY_DELIVERY_TRANSPORT_NOT_CONFIDENTIAL = 'REGISTRY_DELIVERY_TRANSPORT_NOT_CONFIDENTIAL';
const REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE = 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE';
const REGISTRY_DELIVERY_ENVELOPE_TOO_LARGE = 'REGISTRY_DELIVERY_ENVELOPE_TOO_LARGE';
const REGISTRY_DELIVERY_BODY_LIMIT = 'REGISTRY_DELIVERY_BODY_LIMIT';
const REGISTRY_DELIVERY_FAILED = 'REGISTRY_DELIVERY_FAILED';

/**
 * Every machine-readable refusal code a hop-1 augment can surface. Callers
 * gate on this exact set rather than trusting any error with a string `code`
 * property, because unrelated errors (remote API codes, errno values) can
 * carry a `code` too.
 */
export const REGISTRY_DELIVERY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  REGISTRY_DELIVERY_ABORTED,
  REGISTRY_DELIVERY_TRANSPORT_NOT_CONFIDENTIAL,
  REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE,
  REGISTRY_DELIVERY_ENVELOPE_TOO_LARGE,
  REGISTRY_DELIVERY_BODY_LIMIT,
  REGISTRY_DELIVERY_FAILED,
]);

/**
 * Extracts the refusal code and HTTP status from an error raised by an
 * augment-refusal site, or null when the error is not a registry delivery
 * refusal. Every hop-1 refusal attaches its status; the 409 fallback only
 * guards a refusal that somehow does not.
 */
export function registryDeliveryRefusal(err: unknown): { code: string; status: number } | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || !REGISTRY_DELIVERY_REFUSAL_CODES.has(code)) return null;
  const status = Number((err as { status?: unknown }).status);
  return { code, status: Number.isFinite(status) ? status : 409 };
}

/**
 * Embeds the machine-readable code in a refusal message bound for a
 * string-only observable (scheduler last_error, webhook execution rows, mesh
 * activity and audit logs) where an object property would be dropped at
 * serialization.
 */
export function appendRegistryDeliveryCode(message: string, code: string): string {
  return message + ' [' + code + ']';
}

export type RegistryDeliveryAugmentResult =
  | { ok: true; body: Record<string, unknown>; augmented: boolean }
  | { ok: false; status: number; code: string; error: string };

/**
 * Re-encodes an augment refusal as a thrown Error that carries the refusal
 * status and code, so every caller site produces the machine-readable
 * refusal registryDeliveryRefusal extracts.
 */
export function throwRegistryDeliveryRefusal(augment: Extract<RegistryDeliveryAugmentResult, { ok: false }>): never {
  throw Object.assign(new Error(augment.error), { status: augment.status, code: augment.code });
}

export interface AugmentRegistryDeliveryInput {
  method: string;
  apiPath: string;
  nodeId: number;
  node: Node;
  target: ProxyTarget;
  body: Record<string, unknown>;
  /** Capability probe already fetched by the proxy gate, so a gated hop probes once. */
  capabilityProbe?: RemoteCapabilityProbe;
  abortSignal?: AbortSignal;
}

function isTransportConfidential(nodeId: number, node: Node): boolean {
  const delivery = RegistryDeliveryService.getInstance();
  if (node.mode === 'pilot_agent') {
    return PilotTunnelManager.getInstance().isTunnelConfidential(nodeId);
  }
  return delivery.isProxyTransportConfidential(nodeId);
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw Object.assign(new Error('Registry delivery aborted'), { status: 499, code: REGISTRY_DELIVERY_ABORTED });
  }
}

function passthrough(body: Record<string, unknown>): RegistryDeliveryAugmentResult {
  return { ok: true, body, augmented: false };
}

function aborted(): RegistryDeliveryAugmentResult {
  return { ok: false, status: 499, code: REGISTRY_DELIVERY_ABORTED, error: 'Request aborted' };
}

/** Structured log for a passthrough caused by a remote that cannot take delivery. */
function logDeliveryPassthrough(nodeId: number, probe: RemoteCapabilityProbe, stack: string | undefined): void {
  if (probe === 'unsupported') {
    console.error('[registryDeliveryOutbound] CAPABILITY_UNSUPPORTED', { nodeId, stack });
  } else if (probe === 'unreachable') {
    console.error('[registryDeliveryOutbound] REGISTRY_DELIVERY_TARGET_UNREACHABLE', { nodeId, stack });
  }
}

/**
 * Whether hop-1 registry delivery should run for this request, and the
 * capability probe that decided it. Returns null when the request is not
 * delivery-eligible at all; otherwise the probe result, which callers thread
 * into the augment step so the remote meta is fetched once per hop.
 */
export async function wouldAttemptRegistryDelivery(
  nodeId: number,
  method: string,
  apiPath: string,
): Promise<RemoteCapabilityProbe | null> {
  const classification = classifyRegistryDeliveryOp(method, apiPath);
  if (!classification.eligible || !classification.stage) {
    return null;
  }
  if (classifyRegistryDeliveryRouteClass(method, apiPath) == null) {
    return null;
  }
  const probe = await probeRemoteCapability(nodeId, REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY);
  if (probe === 'supported') {
    return probe;
  }
  // Unsupported and unreachable remotes pass through untouched (no secrets, no
  // buffering); only their skip is recorded. Confidentiality is NOT a gate here:
  // a supported remote over a non-confidential transport must still run hop-1 so
  // the refusal matrix can answer 409 TRANSPORT_NOT_CONFIDENTIAL.
  logDeliveryPassthrough(nodeId, probe, classification.stack);
  return probe;
}

function isDiscoverResponseShape(data: unknown): data is RegistryDeliveryDiscoverResponse {
  if (typeof data !== 'object' || data === null) return false;
  const raw = data as Record<string, unknown>;
  return raw.contractVersion === REMOTE_REGISTRY_EXACT_REF_CONTRACT_VERSION
    && [raw.referencedHosts, raw.referencedPullRefs, raw.coveredHosts].every(
      (list) => Array.isArray(list)
        && list.length <= PULL_REF_MAX_COUNT
        && list.every((entry) => typeof entry === 'string'),
    )
    && typeof raw.sourceHash === 'string'
    && typeof raw.actionSetHash === 'string'
    && typeof raw.deliverySourceId === 'string'
    && typeof raw.attestation === 'string'
    && (raw.prepId === undefined || typeof raw.prepId === 'string');
}

/**
 * Validate a 2xx discover response before it is trusted: a forged or truncated
 * body never reaches the refusal matrix. The ref-list round-trip is the
 * load-bearing check, because the target builds that list with the same
 * canonicalizer, so re-canonicalizing a genuine response reproduces it exactly.
 * Failures are deliberately status-less, so the augment catch reports a generic
 * hop-1 failure instead of echoing detail a hostile target controls.
 */
function parseDiscoverResponse(data: unknown): RegistryDeliveryDiscoverResponse {
  if (!isDiscoverResponseShape(data)) {
    throw new Error('Registry delivery discovery response failed validation');
  }
  const refs = data.referencedPullRefs;
  let canonical: string[];
  try {
    canonical = normalizePullRefList(refs);
  } catch {
    // The canonicalizer throws its own 413 when a list busts the ref limits;
    // that still means the body is not a list the target could have produced.
    throw new Error('Registry delivery discovery response failed validation');
  }
  if (canonical.length !== refs.length || canonical.some((ref, index) => ref !== refs[index])) {
    throw new Error('Registry delivery discovery response failed validation');
  }
  return data;
}

async function callTargetDiscover(
  target: ProxyTarget,
  body: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<RegistryDeliveryDiscoverResponse> {
  throwIfAborted(abortSignal);
  const base = target.apiUrl.replace(/\/$/, '');
  const res = await axios.post(`${base}/api/registry-delivery/discover`, body, {
    ...safeAxiosTransport(target.trustedLoopback),
    headers: { Authorization: `Bearer ${target.apiToken}` },
    timeout: 30_000,
    maxBodyLength: REGISTRY_DELIVERY_FIELD_LIMIT_BYTES,
    maxContentLength: REGISTRY_DELIVERY_FIELD_LIMIT_BYTES,
    signal: abortSignal,
    validateStatus: () => true,
  });
  throwIfAborted(abortSignal);
  if (res.status < 200 || res.status >= 300) {
    const message = typeof res.data?.error === 'string'
      ? res.data.error
      : 'Registry delivery discovery failed on target';
    throw Object.assign(new Error(message), { status: res.status });
  }
  return parseDiscoverResponse(res.data);
}

/**
 * Among the hosts the target does not already cover, find those holding at least
 * one challenged (credential-gated) exact pull reference. Probes anonymously over
 * the safe transport only. A host that is unsafe or blocked is never contacted and
 * is treated as inconclusive (not challenged), with its own structured log.
 */
async function findChallengedHosts(
  discover: RegistryDeliveryDiscoverResponse,
  stack: string | undefined,
  nodeId: number,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  const covered = new Set(discover.coveredHosts);
  const refsByHost = new Map<string, string[]>();
  for (const ref of discover.referencedPullRefs) {
    const host = canonicalRefHost(ref);
    if (host === null) continue;
    let refs = refsByHost.get(host);
    if (!refs) {
      refs = [];
      refsByHost.set(host, refs);
    }
    refs.push(ref);
  }

  const challengedHosts: string[] = [];
  for (const host of discover.referencedHosts) {
    throwIfAborted(abortSignal);
    if (covered.has(host)) continue;
    const refs = refsByHost.get(host);
    if (!refs || refs.length === 0) continue;

    try {
      await assertSafeRegistryHost(host);
    } catch (error) {
      if (error instanceof UnsafeRegistryHopError) {
        // The UnsafeRegistryHopError message carries the underlying reason
        // (blocked address vs resolution failure) for the operator.
        console.error('[registryDeliveryOutbound] REGISTRY_DELIVERY_UNSAFE_REGISTRY_TARGET', {
          nodeId,
          stack,
          host,
          reason: error.message,
        });
        continue;
      }
      throw error;
    }

    let sawNonPublic = false;
    for (const ref of refs) {
      throwIfAborted(abortSignal);
      const result = await probeManifestAnonymous(splitPullRefForProbe(ref), abortSignal);
      if (result.classification === 'public') continue;
      sawNonPublic = true;
      if (result.classification === 'challenged') {
        challengedHosts.push(host);
        break;
      }
    }
    if (!challengedHosts.includes(host) && sawNonPublic) {
      // A ref that is neither public nor challenged (404, 429, 5xx, transport
      // failure) leaves the host undecided; record it so an operator can tell
      // a public-only host from one the hub could not determine.
      console.warn('[registryDeliveryOutbound] REGISTRY_DELIVERY_PROBE_INCONCLUSIVE', { nodeId, stack, host });
    }
  }
  return challengedHosts;
}

/**
 * Run hop-1 discover, anonymously classify uncovered hosts, and apply the exact-ref
 * refusal matrix. When the hub delivers, merges the challenged-hosts-only envelope
 * into the JSON body for a direct hub-to-remote fetch caller.
 */
export async function augmentJsonBodyForRegistryDelivery(
  input: AugmentRegistryDeliveryInput,
): Promise<RegistryDeliveryAugmentResult> {
  const classification = classifyRegistryDeliveryOp(input.method, input.apiPath);
  if (!classification.eligible || !classification.stage) {
    return passthrough(input.body);
  }

  if (input.abortSignal?.aborted) {
    return aborted();
  }

  const routeClass = classifyRegistryDeliveryRouteClass(input.method, input.apiPath);
  if (!routeClass) {
    return passthrough(input.body);
  }

  const probe = input.capabilityProbe
    ?? await probeRemoteCapability(input.nodeId, REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY);
  if (probe === 'unsupported' || probe === 'unreachable') {
    logDeliveryPassthrough(input.nodeId, probe, classification.stack);
    return passthrough(input.body);
  }
  if (input.abortSignal?.aborted) {
    return aborted();
  }

  try {
    const discoverBody = buildRegistryDiscoverPayload({
      method: input.method,
      apiPath: input.apiPath,
      body: input.body,
    });
    if (!discoverBody) {
      return passthrough(input.body);
    }

    const discover = await callTargetDiscover(input.target, discoverBody, input.abortSignal);
    if (input.abortSignal?.aborted) {
      return aborted();
    }

    const challengedHosts = await findChallengedHosts(discover, classification.stack, input.nodeId, input.abortSignal);
    if (challengedHosts.length === 0) {
      // All uncovered refs are public or inconclusive: nothing to deliver, no refusal.
      return passthrough(input.body);
    }

    const envelope = await RegistryDeliveryService.getInstance().buildHubEnvelope(
      input.nodeId,
      discover,
      challengedHosts,
    );
    if (input.abortSignal?.aborted) {
      return aborted();
    }
    if (!envelope) {
      // At least one challenged host has no usable hub credential. Envelope
      // coverage is all-or-nothing, so a partially covered set never ships.
      return {
        ok: false,
        status: 409,
        code: REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE,
        error: 'Registry credentials unavailable for challenged image hosts',
      };
    }

    // Refuse before any credential is attached to the outbound body when the
    // transport back to the remote is not confidential.
    if (!isTransportConfidential(input.nodeId, input.node)) {
      return {
        ok: false,
        status: 409,
        code: REGISTRY_DELIVERY_TRANSPORT_NOT_CONFIDENTIAL,
        error: 'Registry credential delivery requires a confidential transport',
      };
    }

    const envelopeJson = JSON.stringify(envelope);
    if (Buffer.byteLength(envelopeJson, 'utf8') > REGISTRY_DELIVERY_FIELD_LIMIT_BYTES) {
      return {
        ok: false,
        status: 413,
        code: REGISTRY_DELIVERY_ENVELOPE_TOO_LARGE,
        error: 'Registry delivery envelope too large',
      };
    }

    const parsed = { ...input.body };
    parsed[REGISTRY_DELIVERY_BODY_FIELD] = envelope;
    const augmented = Buffer.from(JSON.stringify(parsed), 'utf-8');
    const totalLimit = getRegistryDeliveryTotalBodyLimit(routeClass);
    if (augmented.length > totalLimit) {
      return {
        ok: false,
        status: 413,
        code: REGISTRY_DELIVERY_BODY_LIMIT,
        error: 'Request body exceeds registry delivery limit',
      };
    }

    if (input.abortSignal?.aborted) {
      return aborted();
    }

    return { ok: true, body: parsed, augmented: true };
  } catch (error) {
    if (input.abortSignal?.aborted || (error as { code?: string }).code === REGISTRY_DELIVERY_ABORTED) {
      return aborted();
    }
    if (axios.isCancel(error)) {
      return aborted();
    }
    const status = Number((error as { status?: number }).status) || 500;
    console.error(
      '[registryDeliveryOutbound] hop-1 failed:',
      getErrorMessage(error, 'unknown'),
    );
    return {
      ok: false,
      status,
      code: REGISTRY_DELIVERY_FAILED,
      error: status >= 500 ? 'Registry delivery failed' : getErrorMessage(error, 'Registry delivery failed'),
    };
  }
}

/**
 * Convenience wrapper for services that already validated the remote target.
 * Loads node + proxy target from the registry.
 */
export async function prepareOutboundRegistryDeliveryBody(options: {
  method: string;
  apiPath: string;
  nodeId: number;
  body?: Record<string, unknown> | null;
  abortSignal?: AbortSignal;
}): Promise<RegistryDeliveryAugmentResult> {
  const body = options.body ?? {};
  const node = DatabaseService.getInstance().getNode(options.nodeId);
  const target = NodeRegistry.getInstance().getProxyTarget(options.nodeId);
  if (!node || !target) {
    // Defensive: every caller validates the node before invoking. Record it so
    // a future caller that skips validation shows up in logs instead of
    // silently losing delivery.
    console.warn('[registryDeliveryOutbound] REGISTRY_DELIVERY_TARGET_MISSING', { nodeId: options.nodeId });
    return passthrough(body);
  }
  return augmentJsonBodyForRegistryDelivery({
    method: options.method,
    apiPath: options.apiPath,
    nodeId: options.nodeId,
    node,
    target,
    body,
    abortSignal: options.abortSignal,
  });
}

import axios from 'axios';
import path from 'path';
import fs from 'fs';
import semver from 'semver';
import { SENCHO_VERSION } from '../generated/version';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import type { ImagePinKind } from '../helpers/selfUpdateCompose';
import { assertSafeOutboundUrl, safeAxiosTransport } from '../utils/outboundTarget';

const IMAGE_PIN_KINDS: readonly ImagePinKind[] = ['floating', 'semver', 'digest', 'unknown'];

/** Coerce an untrusted /api/meta value to a known pin kind, or null. */
function parseImagePinKind(value: unknown): ImagePinKind | null {
  return typeof value === 'string' && (IMAGE_PIN_KINDS as readonly string[]).includes(value)
    ? (value as ImagePinKind)
    : null;
}

/**
 * Static registry of capabilities supported by THIS Sencho instance.
 * Append-only: when a new feature ships, add its capability string here.
 * The frontend uses these flags (not semver comparisons) to gate features
 * on nodes that may be running older versions.
 */
export const CAPABILITIES = [
  'stacks',
  'containers',
  'resources',
  'templates',
  'global-logs',
  'system-stats',
  'fleet',
  'auto-updates',
  'labels',
  'webhooks',
  'network-topology',
  'notifications',
  'notification-routing',
  'notification-suppression',
  'notification-suppression-schedule',
  'notification-suppression-replica-retraction',
  'host-console',
  'host-console-community',
  'container-exec',
  'audit-log',
  'scheduled-ops',
  'sso',
  'authentication-mode',
  'api-tokens',
  'users',
  'registries',
  'self-update',
  'vulnerability-scanning',
  'compose-doctor',
  'update-guard',
  'compose-networking',
  'env-inventory',
  'container-label-inventory',
  'project-env-files',
  'compose-storage',
  'cross-node-rbac',
  'stack-down-remove-volumes',
  'stack-delete-prune-volumes',
  'guided-external-network-preflight',
  'service-scoped-update',
  'service-scoped-stack-alert',
  'scoped-stack-auth-evidence',
  'remote-registry-credentials',
  'remote-registry-exact-ref-proof-v1',
  'remote-registry-sealed-envelope-v1',
  'remote-image-inspect-v1',
  'remote-auto-update-checked-v1',
  'gitops-source-controller',
  'fleet-readiness-v1',
  'blueprint-digest-pins-v1',
] as const;

/**
 * Advertised by instances that enforce the proxied actor's role (instead of
 * treating every node-to-node request as admin) and honor the exact-stack
 * allowlist on stop-by-label. The control instance refuses to forward a
 * non-admin's request, or a confirmed stop, to a remote lacking this flag so a
 * mixed-version fleet cannot escalate or over-stop on an un-upgraded node.
 */
export const CROSS_NODE_RBAC_CAPABILITY = 'cross-node-rbac';

export type Capability = (typeof CAPABILITIES)[number];

/** Legacy Host Console advertisement (Admiral hubs still accept this on remotes). */
export const HOST_CONSOLE_CAPABILITY = 'host-console' as const satisfies Capability;

/** Host Console works without a paid license on this node. */
export const HOST_CONSOLE_COMMUNITY_CAPABILITY = 'host-console-community' as const satisfies Capability;

/** Remotes that evaluate weekly maintenance windows on mute/suppression replicas. */
export const NOTIFICATION_SUPPRESSION_SCHEDULE_CAPABILITY =
  'notification-suppression-schedule' as const satisfies Capability;

/**
 * Remotes that accept hub-authored `{ kind, source_updated_at }` on replica DELETE
 * and persist versioned tombstones. Without this, hubs must not send recoverable
 * soft-cleanup DELETEs (pre-tombstone remotes would bare-delete with no guard).
 */
export const NOTIFICATION_SUPPRESSION_REPLICA_RETRACTION_CAPABILITY =
  'notification-suppression-replica-retraction' as const satisfies Capability;

/** Capability for optional `?removeVolumes=true` on POST /stacks/:name/down. */
export const STACK_DOWN_REMOVE_VOLUMES_CAPABILITY = 'stack-down-remove-volumes' as const satisfies Capability;

/** Capability for honoring `?pruneVolumes` on DELETE /stacks/:name. Nodes without this
 *  capability always destroy volumes on delete (pre-existing behavior); nodes with it
 *  honor the operator's checkbox choice. */
export const STACK_DELETE_PRUNE_VOLUMES_CAPABILITY = 'stack-delete-prune-volumes' as const satisfies Capability;

/** Capability for the nested per-service update/restore routes and the `effective-services` model they read. */
export const SERVICE_SCOPED_UPDATE_CAPABILITY = 'service-scoped-update' as const satisfies Capability;

/** Capability for nullable `service_name` on stack alert rules and per-service cooldown evaluation. */
export const SERVICE_SCOPED_STACK_ALERT_CAPABILITY =
  'service-scoped-stack-alert' as const satisfies Capability;

/**
 * Remotes that consume hub-bound scoped stack auth evidence headers
 * (`x-sencho-scoped-stack-name` / `x-sencho-scoped-stack-actions`) under
 * machine auth. Hubs fail closed when scoped elevation is needed and the
 * remote lacks this flag.
 */
export const SCOPED_STACK_AUTH_EVIDENCE_CAPABILITY =
  'scoped-stack-auth-evidence' as const satisfies Capability;

/** Remotes that accept hub-delivered registry credentials for Compose operations. */
export const REMOTE_REGISTRY_CREDENTIALS_CAPABILITY =
  'remote-registry-credentials' as const satisfies Capability;

/**
 * Remotes that participate in the exact-ref registry delivery contract
 * (`contractVersion: 1`): the target reports the exact pull references the
 * project uses and the hosts it already covers with its own credentials, the
 * hub probes the uncovered hosts and delivers credentials only for the
 * challenged ones it can cover, and the attestation carries a hash of the
 * exact reference list. When the target also advertises a sealing public key
 * (and the hub pins it), the hub delivers a sealed envelope over any transport.
 * Otherwise the hub still refuses plaintext delivery over a non-confidential
 * transport (409). Absent this flag, the hub never augments and never refuses
 * (legacy silent passthrough).
 */
export const REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY =
  'remote-registry-exact-ref-proof-v1' as const satisfies Capability;

/**
 * Remotes that advertise an X25519 sealing public key on discover and can open
 * sealedAuths envelopes. Operational sealed delivery is gated by a valid
 * sealingKey on the discover response; this capability is the /api/meta flag
 * for fleet visibility and mixed-version diagnostics.
 */
export const REMOTE_REGISTRY_SEALED_ENVELOPE_V1_CAPABILITY =
  'remote-registry-sealed-envelope-v1' as const satisfies Capability;

/** Direct GitOps source-controller routes and source-policy representation. Not Blueprint source evaluation. */
export const GITOPS_SOURCE_CONTROLLER_CAPABILITY =
  'gitops-source-controller' as const satisfies Capability;

/**
 * Per-node readiness evidence and the live per-stack readiness rollup. These
 * are the node-local half of fleet readiness, and the flag says a node serves
 * them.
 *
 * The hub does not gate on it. It reads the answer instead: a node without the
 * routes replies 404, which reports the route as actually absent rather than
 * reporting a cached flag that can be stale across an upgrade. The flag is
 * advertised for consumers that read it from `/api/meta`, and the discovery
 * surface it feeds.
 */
export const FLEET_READINESS_V1_CAPABILITY = 'fleet-readiness-v1' as const satisfies Capability;

/**
 * Leaves whose `/api/blueprints/apply-local` honors `digestPins` (deploys each
 * service at the pinned digest instead of its tag). Hubs refuse to send a
 * digest-pinned apply to a leaf lacking this flag, because an older leaf
 * silently drops the field and redeploys with tag semantics.
 */
export const BLUEPRINT_DIGEST_PINS_V1_CAPABILITY =
  'blueprint-digest-pins-v1' as const satisfies Capability;

/** Contract version the hub and target negotiate for exact-ref proof. */
export const REMOTE_REGISTRY_EXACT_REF_CONTRACT_VERSION = 1;

/** Returns true when the string is a usable semver version. */
export function isValidVersion(v: string | null | undefined): v is string {
  return !!v && v !== 'unknown' && v !== '0.0.0-dev' && !!semver.valid(v);
}

// Resolved once per process at import time, then cached.
function resolveVersion(): string | null {
  // Primary: walk up to find the root package.json (always authoritative).
  // The generated SENCHO_VERSION constant can be stale when a branch falls
  // behind a release-please version bump, so we prefer the live value.
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (pkg.name === 'sencho') return pkg.version;
    } catch { /* not found, keep walking */ }
    dir = path.dirname(dir);
  }
  // Fallback: build-time constant (may be stale in dev, but correct in Docker)
  if (SENCHO_VERSION !== '0.0.0-dev') return SENCHO_VERSION;
  console.warn('[CapabilityRegistry] Could not resolve Sencho version from any source');
  return null;
}

const cachedVersion = resolveVersion();

export function getSenchoVersion(): string | null {
  return cachedVersion;
}

export interface RemoteMeta {
  version: string | null;
  capabilities: string[];
  startedAt: number | null;
  /** Error message from a failed self-update attempt on the remote node. */
  updateError: string | null;
  /** True when the /api/meta request succeeded (node is reachable). */
  online: boolean;
  /**
   * How the remote pins its Sencho image, when it advertises it. Null for an
   * older remote that predates this field or one that could not classify its
   * pin. The hub uses only this safe subset (no full image ref) for remote rows.
   */
  imagePinKind: ImagePinKind | null;
  /** True when the remote reports its update is blocked (digest/unknown pin). */
  updateBlocked: boolean;
  /**
   * Coarse image channel from the remote public meta. Null when the remote is
   * older than this field or offline. Safe to expose (no private repository path).
   */
  imageChannel: 'community' | 'hardened' | 'unknown' | null;
}

export type RemoteMetaTransportFailure =
  | 'timeout'
  | 'disconnect'
  | 'refused'
  | 'other';

/**
 * Raw outcome of a remote /api/meta probe, BEFORE normalization. Carries the
 * reason a probe did not yield meta so capability checks can distinguish a
 * reachable remote that does not advertise a flag from one that is simply
 * unreachable. `no_target` is produced by the node-scoped probe when no proxy
 * target exists; the transport-level fetch (which always has a base URL) never
 * returns it.
 */
export type RemoteMetaProbe =
  | { kind: 'ok'; meta: RemoteMeta }
  | { kind: 'no_target' }
  | { kind: 'transport_failure'; detail: RemoteMetaTransportFailure }
  | { kind: 'http_failure'; status: number }
  | { kind: 'malformed' };

// Runtime capability overrides; services call disableCapability() during init.
const disabledCapabilities = new Set<Capability>();

export function disableCapability(c: Capability): void {
  disabledCapabilities.add(c);
}

export function enableCapability(c: Capability): void {
  disabledCapabilities.delete(c);
}

/** Returns capabilities this instance actually supports at runtime. */
export function getActiveCapabilities(): readonly string[] {
  if (disabledCapabilities.size === 0) return CAPABILITIES;
  return CAPABILITIES.filter(c => !disabledCapabilities.has(c));
}

/**
 * Capabilities a pilot-agent process should hide from its own /api/meta because
 * the central->pilot path for them is not yet wired through the reverse tunnel.
 * Surfacing them would let the frontend offer a tab whose click silently falls
 * through to central's local handler.
 *
 * `self-update` is intentionally NOT here: a pilot deployed via Docker Compose
 * picks up the compose labels SelfUpdateService.initialize() needs and toggles
 * the capability on locally; the Fleet Update flow then routes through
 * NodeRegistry.getProxyTarget() so the tunnel carries the trigger.
 */
const PILOT_DISABLED_CAPABILITIES: readonly Capability[] = [
  'host-console',
  'host-console-community',
];

/** Disable capabilities that require a central->pilot path that is not yet wired. */
export function applyPilotModeCapabilityFilter(): void {
  for (const cap of PILOT_DISABLED_CAPABILITIES) disableCapability(cap);
}

/** Shared offline shape returned when a remote node is unreachable. */
export const OFFLINE_META: RemoteMeta = {
  version: null,
  capabilities: [],
  startedAt: null,
  updateError: null,
  online: false,
  imagePinKind: null,
  updateBlocked: false,
  imageChannel: null,
};

function parseImageChannel(value: unknown): RemoteMeta['imageChannel'] {
  if (value === 'community' || value === 'hardened' || value === 'unknown') return value;
  return null;
}

/** Strip any `user:pass@` userinfo from a URL so credentials never reach the logs. */
function redactUrlCredentials(url: string): string {
  return url.replace(/(\/\/)[^/@]*@/, '$1');
}

/**
 * Classify the raw shape of a 2xx /api/meta response body. Only a JSON object
 * carrying a genuine capabilities array is a usable meta document; anything
 * else (non-object JSON, a missing or non-array capabilities field) means the
 * remote did not answer with Sencho metadata, so callers must treat the node
 * as unreachable rather than as an online remote that advertises nothing.
 */
function classifyRemoteMetaBody(
  data: unknown,
): 'meta' | 'not-object' | 'capabilities-missing' | 'capabilities-not-array' | 'capabilities-not-strings' {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'not-object';
  const capabilities = (data as Record<string, unknown>).capabilities;
  if (capabilities === undefined) return 'capabilities-missing';
  if (!Array.isArray(capabilities)) return 'capabilities-not-array';
  if (!capabilities.every((entry): entry is string => typeof entry === 'string')) {
    return 'capabilities-not-strings';
  }
  return 'meta';
}

/** Classify a failed /api/meta request into a raw probe kind, logging the reason. */
function classifyMetaFetchError(err: unknown, safeUrl: string): RemoteMetaProbe {
  const maybeResponse = (err as { response?: { status?: unknown } }).response;
  if (maybeResponse && typeof maybeResponse.status === 'number') {
    console.warn(`[CapabilityRegistry] Failed to fetch meta from ${safeUrl}: HTTP ${maybeResponse.status}`);
    return { kind: 'http_failure', status: maybeResponse.status };
  }
  const code = (err as { code?: string }).code;
  let detail: RemoteMetaTransportFailure = 'other';
  if (code === 'ECONNABORTED') detail = 'timeout';
  else if (code === 'ECONNRESET') detail = 'disconnect';
  else if (code === 'ECONNREFUSED') detail = 'refused';
  console.warn(`[CapabilityRegistry] Failed to fetch meta from ${safeUrl}:`, getErrorMessage(err, 'unknown'));
  return { kind: 'transport_failure', detail };
}

/**
 * Probe /api/meta from a remote Sencho instance and return a typed outcome:
 * failure causes stay raw (malformed, transport/HTTP failure kinds), while a
 * successful meta document is normalized into a RemoteMeta. Normalization
 * consumers that only need a flattened RemoteMeta should call
 * {@link fetchRemoteMeta}.
 */
export async function probeRemoteMeta(
  baseUrl: string,
  apiToken: string,
  trustedLoopback = false,
  abortSignal?: AbortSignal,
): Promise<RemoteMetaProbe> {
  const safeUrl = redactUrlCredentials(baseUrl);
  try {
    if (!trustedLoopback) await assertSafeOutboundUrl(baseUrl);
    const res = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/meta`, {
      ...safeAxiosTransport(trustedLoopback),
      headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
      timeout: 5000,
      signal: abortSignal,
    });
    // A 2xx body that is not a JSON object with a genuine capabilities array is
    // not Sencho metadata (an intercepting proxy, an error page, a truncated
    // body). Classify it as malformed so capability probes report unreachable
    // instead of mistaking garbage for an online remote that advertises
    // nothing.
    const bodyClass = classifyRemoteMetaBody(res.data);
    if (bodyClass !== 'meta') {
      console.warn(
        `[CapabilityRegistry] Remote meta from ${safeUrl} is malformed (${bodyClass}); reporting node as unreachable`,
      );
      return { kind: 'malformed' };
    }
    const rawVersion: string | undefined = res.data.version;
    const meta: RemoteMeta = {
      version: isValidVersion(rawVersion) ? rawVersion : null,
      capabilities: res.data.capabilities as string[],
      startedAt: typeof res.data.startedAt === 'number' ? res.data.startedAt : null,
      updateError: typeof res.data.updateError === 'string' ? res.data.updateError : null,
      online: true,
      imagePinKind: parseImagePinKind(res.data.imagePinKind),
      updateBlocked: res.data.updateBlocked === true,
      imageChannel: parseImageChannel(res.data.imageChannel),
    };
    if (isDebugEnabled()) {
      // Diagnostic aid for "why is this feature gated?": log the resolved version
      // and capability count (not the full list) at the one boundary that decides
      // gating. The URL is logged with any userinfo credentials stripped.
      console.log(
        `[CapabilityRegistry:diag] meta ok from ${safeUrl}: version=${meta.version ?? 'null'} capabilities=${meta.capabilities.length}`,
      );
    }
    return { kind: 'ok', meta };
  } catch (err) {
    return classifyMetaFetchError(err, safeUrl);
  }
}

/** Fetch /api/meta from a remote Sencho instance. Returns empty data on failure. */
export async function fetchRemoteMeta(
  baseUrl: string,
  apiToken: string,
  trustedLoopback = false,
): Promise<RemoteMeta> {
  const probe = await probeRemoteMeta(baseUrl, apiToken, trustedLoopback);
  return probe.kind === 'ok' ? probe.meta : { ...OFFLINE_META };
}

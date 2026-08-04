import axios from 'axios';
import path from 'path';
import fs from 'fs';
import semver from 'semver';
import { SENCHO_VERSION } from '../generated/version';
import { isDebugEnabled } from '../utils/debug';
import type { ImagePinKind } from '../helpers/selfUpdateCompose';

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

/** Fetch /api/meta from a remote Sencho instance. Returns empty data on failure. */
export async function fetchRemoteMeta(baseUrl: string, apiToken: string): Promise<RemoteMeta> {
  const safeUrl = redactUrlCredentials(baseUrl);
  try {
    const res = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/meta`, {
      headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
      timeout: 5000,
    });
    const rawVersion: string | undefined = res.data.version;
    const meta: RemoteMeta = {
      version: isValidVersion(rawVersion) ? rawVersion : null,
      capabilities: Array.isArray(res.data.capabilities) ? res.data.capabilities : [],
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
    return meta;
  } catch (err) {
    console.warn(`[CapabilityRegistry] Failed to fetch meta from ${safeUrl}:`, (err as Error).message);
    return { ...OFFLINE_META };
  }
}

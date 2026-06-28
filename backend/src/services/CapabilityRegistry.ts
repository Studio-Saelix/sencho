import axios from 'axios';
import path from 'path';
import fs from 'fs';
import semver from 'semver';
import { SENCHO_VERSION } from '../generated/version';
import { isDebugEnabled } from '../utils/debug';

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
  'host-console',
  'container-exec',
  'audit-log',
  'scheduled-ops',
  'sso',
  'api-tokens',
  'users',
  'registries',
  'self-update',
  'vulnerability-scanning',
  'compose-doctor',
  'update-guard',
  'compose-networking',
  'env-inventory',
  'project-env-files',
  'compose-storage',
  'cross-node-rbac',
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
};

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

import axios from 'axios';
import path from 'path';
import fs from 'fs';
import semver from 'semver';
import { SENCHO_VERSION } from '../generated/version';

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
] as const;

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
 */
const PILOT_DISABLED_CAPABILITIES: readonly Capability[] = [
  'host-console',
  'self-update',
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

/** Fetch /api/meta from a remote Sencho instance. Returns empty data on failure. */
export async function fetchRemoteMeta(baseUrl: string, apiToken: string): Promise<RemoteMeta> {
  try {
    const res = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/meta`, {
      headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
      timeout: 5000,
    });
    const rawVersion: string | undefined = res.data.version;
    return {
      version: isValidVersion(rawVersion) ? rawVersion : null,
      capabilities: Array.isArray(res.data.capabilities) ? res.data.capabilities : [],
      startedAt: typeof res.data.startedAt === 'number' ? res.data.startedAt : null,
      updateError: typeof res.data.updateError === 'string' ? res.data.updateError : null,
      online: true,
    };
  } catch (err) {
    console.warn(`[CapabilityRegistry] Failed to fetch meta from ${baseUrl}:`, (err as Error).message);
    return { ...OFFLINE_META };
  }
}

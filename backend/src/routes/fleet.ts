import { Router, type Request, type Response } from 'express';
import path from 'path';
import semver from 'semver';
import si from 'systeminformation';
import type Dockerode from 'dockerode';
import { DatabaseService, type Node, type StackDossierFields } from '../services/DatabaseService';
import { ControlIdentityMismatchError, FleetSyncService, StaleSyncPushError } from '../services/FleetSyncService';
import { MAX_SYNC_ROWS, SYNC_ERROR_CODES } from '../services/fleetSyncConstants';
import { FleetUpdateTrackerService, type UpdateTracker, type TerminalStatus, UPDATE_TIMEOUT_MS, UPDATE_TIMEOUT_MSG, TERMINAL_TTL_MS } from '../services/FleetUpdateTrackerService';
import { NodeRegistry } from '../services/NodeRegistry';
import { computeNodeNetworkingSummary, type NodeNetworkingSummary } from '../services/network/networkingSummary';
import DockerController from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';
import { ComposeService } from '../services/ComposeService';
import { StackOpLockService } from '../services/StackOpLockService';
import SelfUpdateService from '../services/SelfUpdateService';
import { getSenchoVersion, isValidVersion } from '../services/CapabilityRegistry';
import { authMiddleware } from '../middleware/auth';
import { requirePaid, requireAdmin, requireNodeProxy } from '../middleware/tierGates';
import { scheduleLocalUpdate } from './license';
import { runPolicyGate, assertPolicyGateAllows, buildPolicyGateOptions } from '../helpers/policyGate';
import { captureLocalNodeFiles, captureRemoteNodeFiles, buildSnapshotDocumentation, pickDossierFields, dossierHasContent, type SnapshotNodeData, type SnapshotDocumentation } from '../utils/snapshot-capture';
import { getLatestVersion } from '../utils/version-check';
import { isValidStackName } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { withTimeout, TimeoutError } from '../utils/withTimeout';

// Mirror the system-maintenance route timeout so fleet's local-node prune
// paths cap the slow `docker system df` call at the same 8s budget (F-6).
const FLEET_DF_TIMEOUT_MS = 8_000;
import { POLICY_SEVERITIES } from '../utils/severity';
import { sanitizeForLog, redactSensitiveText } from '../utils/safeLog';
import { formatNoTargetError } from '../utils/remoteTarget';
import { CloudBackupService } from '../services/CloudBackupService';
import { NotificationService } from '../services/NotificationService';
import { invalidateNodeCaches, invalidateRemoteMetaCache } from '../helpers/cacheInvalidation';
import { activeBulkActions } from './labels';
import { runLocalLabelStop, isLabelLocalStopResponse, type StackStopResult } from '../helpers/fleetLabelStop';
import { collectFleetLabelSummaries } from '../helpers/fleetLabelSummary';
import { buildLocalConfigurationStatus, type ConfigurationStatus } from './dashboard';
import { buildLocalGraph, mergeFleetGraph, isLocalDependencyGraph, type FleetNodeGraphResult } from '../services/DependencyGraphService';
import { PROXY_TIER_HEADER } from '../services/license-headers';
import { LicenseService } from '../services/LicenseService';

const updateTracker = FleetUpdateTrackerService.getInstance();
const EARLY_FAIL_MS = 180 * 1000; // 3 minutes before declaring a probable pull failure
// Throttle the forced latest-version refresh so a caller cannot loop the recheck
// endpoint to hammer GitHub / Docker Hub. The 30-minute cache still serves reads
// between forced refreshes; this only bounds how often we bypass it.
const FORCED_RECHECK_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
let lastForcedRecheckAt = 0;

/** Test-only: reset the forced-recheck throttle clock so suites do not depend
 *  on cross-test ordering of the module-scope timestamp. */
export function _resetForcedRecheckThrottleForTests(): void {
  lastForcedRecheckAt = 0;
}

/**
 * Atomically resolve an in-flight update tracker to a terminal state and store
 * it. Re-reads the live entry and transitions only if it is still 'updating'
 * with the same startedAt; because there is no await between the read and the
 * set, a concurrent /update-status poll that already resolved this node cannot
 * be clobbered or cause a duplicate WARN. For failure-class outcomes (failed /
 * timeout) it emits one operator-visible WARN so a failed fleet update is
 * observable without enabling developer mode. The error text is secret-redacted
 * and control-stripped before logging; no tokens or meta dumps.
 */
function resolveTerminal(
  node: { id: number; name: string },
  tracker: UpdateTracker,
  status: TerminalStatus,
  error?: string,
): void {
  const live = updateTracker.get(node.id);
  if (!live || live.status !== 'updating' || live.startedAt !== tracker.startedAt) return;
  if (status !== 'completed') {
    const elapsedSec = Math.round((Date.now() - live.startedAt) / 1000);
    const detail = error ? `: ${sanitizeForLog(redactSensitiveText(error))}` : '';
    console.warn(`[Fleet] Node update ${status} for "${sanitizeForLog(node.name)}" (id ${node.id}) after ${elapsedSec}s${detail}`);
  }
  updateTracker.set(node.id, updateTracker.resolve(live, status, error));
}

const CVE_ID_RE = /^(CVE-\d{4}-\d{4,}|GHSA-[\w-]{14,})$/;

const isIntFlag = (v: unknown): v is 0 | 1 => v === 0 || v === 1;

function validateScanPolicyRow(row: unknown): string | null {
  if (!row || typeof row !== 'object') return 'row must be an object';
  const r = row as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 200) return 'name must be a non-empty string';
  if (typeof r.max_severity !== 'string' || !POLICY_SEVERITIES.has(r.max_severity)) return 'max_severity must be CRITICAL, HIGH, MEDIUM, or LOW';
  if (r.stack_pattern !== null && typeof r.stack_pattern !== 'string') return 'stack_pattern must be a string or null';
  if (typeof r.stack_pattern === 'string') {
    const patternError = validateStackPatternForRedos(r.stack_pattern);
    if (patternError) return patternError;
  }
  if (typeof r.node_identity !== 'string') return 'node_identity must be a string';
  if (r.node_identity.length > 500) return 'node_identity is too long';
  if (!isIntFlag(r.block_on_deploy)) return 'block_on_deploy must be 0 or 1';
  if (!isIntFlag(r.enabled)) return 'enabled must be 0 or 1';
  return null;
}

/**
 * Reject `stack_pattern` inputs that would compile to a backtracking-prone
 * regex. The matcher in `getMatchingPolicy` substitutes `*` with `.*`, so a
 * pattern like `***...` becomes a chain of adjacent `.*` runs that exhibit
 * catastrophic backtracking on long inputs.
 *
 * Caps mirror the limit in routes/security.ts so a control creating a policy
 * sees the same error as a replica receiving one. Length is gated at 200 by
 * the surrounding row validator.
 */
export function validateStackPatternForRedos(pattern: string): string | null {
  if (pattern.length > 200) return 'stack_pattern is too long';
  const stars = (pattern.match(/\*/g) ?? []).length;
  if (stars > 8) return 'stack_pattern has too many wildcards (max 8)';
  if (/\*{4,}/.test(pattern)) return 'stack_pattern must not contain 4+ consecutive wildcards';
  return null;
}

function validateCveSuppressionRow(row: unknown): string | null {
  if (!row || typeof row !== 'object') return 'row must be an object';
  const r = row as Record<string, unknown>;
  if (typeof r.cve_id !== 'string' || !CVE_ID_RE.test(r.cve_id)) return 'cve_id must be a valid CVE or GHSA identifier';
  if (r.pkg_name !== null && typeof r.pkg_name !== 'string') return 'pkg_name must be a string or null';
  if (typeof r.pkg_name === 'string' && r.pkg_name.length > 200) return 'pkg_name is too long';
  if (r.image_pattern !== null && typeof r.image_pattern !== 'string') return 'image_pattern must be a string or null';
  if (typeof r.image_pattern === 'string' && r.image_pattern.length > 300) return 'image_pattern is too long';
  if (typeof r.reason !== 'string') return 'reason must be a string';
  if (r.reason.length > 2000) return 'reason is too long';
  if (typeof r.created_by !== 'string' || r.created_by.length > 200) return 'created_by must be a string';
  if (typeof r.created_at !== 'number') return 'created_at must be a number';
  if (r.expires_at !== null && typeof r.expires_at !== 'number') return 'expires_at must be a number or null';
  return null;
}

function validateMisconfigAcknowledgementRow(row: unknown): string | null {
  if (!row || typeof row !== 'object') return 'row must be an object';
  const r = row as Record<string, unknown>;
  if (typeof r.rule_id !== 'string' || r.rule_id.length === 0 || r.rule_id.length > 200) return 'rule_id must be a non-empty string up to 200 chars';
  if (r.stack_pattern !== null && typeof r.stack_pattern !== 'string') return 'stack_pattern must be a string or null';
  if (typeof r.stack_pattern === 'string') {
    if (r.stack_pattern.length > 300) return 'stack_pattern is too long';
    const patternError = validateStackPatternForRedos(r.stack_pattern);
    if (patternError) return patternError;
  }
  if (typeof r.reason !== 'string') return 'reason must be a string';
  if (r.reason.length > 2000) return 'reason is too long';
  if (typeof r.created_by !== 'string' || r.created_by.length > 200) return 'created_by must be a string';
  if (typeof r.created_at !== 'number') return 'created_at must be a number';
  if (r.expires_at !== null && typeof r.expires_at !== 'number') return 'expires_at must be a number or null';
  return null;
}

interface FleetNodeOverview {
  id: number;
  name: string;
  type: 'local' | 'remote';
  mode?: string;
  status: 'online' | 'offline' | 'unknown';
  stats: {
    active: number;
    managed: number;
    unmanaged: number;
    exited: number;
    total: number;
  } | null;
  systemStats: {
    cpu: { usage: string; cores: number };
    memory: { total: number; used: number; free: number; usagePercent: string };
    disk: { total: number; used: number; free: number; usagePercent: string } | null;
  } | null;
  stacks: string[] | null;
  latency_ms?: number;
  last_successful_contact?: number | null;
  pilot_last_seen?: number | null;
  cordoned: boolean;
  cordoned_at: number | null;
  cordoned_reason: string | null;
}

/** Resolve the version to compare nodes against (latest from GitHub, or gateway fallback). */
async function getCompareTarget(gatewayVersion: string | null) {
  const latestVersion = await getLatestVersion();
  const latestValid = latestVersion !== null && isValidVersion(latestVersion);
  const result = {
    latestVersion,
    latestValid,
    compareVersion: latestValid ? latestVersion : gatewayVersion,
    compareValid: latestValid || isValidVersion(gatewayVersion),
  };
  if (isDebugEnabled()) {
    console.debug('[Fleet:debug] Compare target resolved:', { gatewayVersion, latestVersion, using: result.compareVersion, valid: result.compareValid });
  }
  return result;
}

async function fetchLocalNodeOverview(node: Node): Promise<FleetNodeOverview> {
  try {
    const composeDir = path.resolve(NodeRegistry.getInstance().getComposeDir(node.id));
    const [allContainers, stacks, currentLoad, mem, fsSize] = await Promise.all([
      DockerController.getInstance(node.id).getAllContainers(),
      FileSystemService.getInstance(node.id).getStacks(),
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
    ]);

    const isManagedByComposeDir = (c: Dockerode.ContainerInfo): boolean => {
      const workingDir: string | undefined = c.Labels?.['com.docker.compose.project.working_dir'];
      if (!workingDir) return false;
      const resolved = path.resolve(workingDir);
      return resolved === composeDir || resolved.startsWith(composeDir + path.sep);
    };

    const containers = allContainers as Dockerode.ContainerInfo[];
    const active = containers.filter(c => c.State === 'running').length;
    const exited = containers.filter(c => c.State === 'exited').length;
    const total = containers.length;
    const managed = containers.filter(c => c.State === 'running' && isManagedByComposeDir(c)).length;
    const unmanaged = containers.filter(c => c.State === 'running' && !isManagedByComposeDir(c)).length;

    const mainDisk = fsSize.find(fs => fs.mount === '/' || fs.mount === 'C:') || fsSize[0];

    return {
      id: node.id,
      name: node.name,
      type: node.type,
      status: 'online',
      stats: { active, managed, unmanaged, exited, total },
      systemStats: {
        cpu: { usage: currentLoad.currentLoad.toFixed(1), cores: currentLoad.cpus.length },
        memory: {
          total: mem.total,
          // Percentage is keyed off mem.active (the real working set), not mem.used:
          // on Linux/BSD/macOS mem.used counts reclaimable page cache and reads ~99%
          // on a busy host. mem.available is total - active, so used + free = total.
          used: mem.active,
          free: mem.available,
          usagePercent: ((mem.active / mem.total) * 100).toFixed(1),
        },
        disk: mainDisk ? {
          total: mainDisk.size,
          used: mainDisk.used,
          free: mainDisk.available,
          usagePercent: mainDisk.use ? mainDisk.use.toFixed(1) : '0',
        } : null,
      },
      stacks,
      last_successful_contact: node.last_successful_contact ?? null,
      cordoned: node.cordoned,
      cordoned_at: node.cordoned_at,
      cordoned_reason: node.cordoned_reason,
    };
  } catch (error) {
    console.error(`[Fleet] Local node ${node.name} error:`, error);
    return {
      id: node.id, name: node.name, type: node.type, status: 'offline',
      stats: null, systemStats: null, stacks: null,
      last_successful_contact: node.last_successful_contact ?? null,
      cordoned: node.cordoned,
      cordoned_at: node.cordoned_at,
      cordoned_reason: node.cordoned_reason,
    };
  }
}

function pilotLastSeenSeconds(node: Node): number | null {
  return node.mode === 'pilot_agent' && node.pilot_last_seen
    ? Math.floor(node.pilot_last_seen / 1000)
    : null;
}

function offlineRemoteOverview(node: Node, status: 'online' | 'offline'): FleetNodeOverview {
  const pilotSeen = pilotLastSeenSeconds(node);
  // For pilot-agent rows the tunnel heartbeat is the contact signal. Mirror
  // it into last_successful_contact so the Fleet "last seen" cell renders
  // the recent tunnel timestamp instead of a stale HTTP-success time.
  const lastContact = pilotSeen ?? node.last_successful_contact ?? null;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    mode: node.mode,
    status,
    stats: null,
    systemStats: null,
    stacks: null,
    last_successful_contact: lastContact,
    pilot_last_seen: pilotSeen,
    cordoned: node.cordoned,
    cordoned_at: node.cordoned_at,
    cordoned_reason: node.cordoned_reason,
  };
}

async function fetchRemoteNodeOverview(node: Node, db: DatabaseService): Promise<FleetNodeOverview> {
  const target = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!target) {
    // Soft-online keeps the Fleet card from flapping during a brief pilot
    // tunnel reconnect: a recent pilot_last_seen still counts as reachable.
    const status: 'online' | 'offline' =
      node.mode === 'pilot_agent' && node.pilot_last_seen ? 'online' : 'offline';
    return offlineRemoteOverview(node, status);
  }

  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const headers: Record<string, string> = target.apiToken
    ? { Authorization: `Bearer ${target.apiToken}` }
    : {};
  const t0 = Date.now();

  try {
    const [statsRes, systemStatsRes, stacksRes] = await Promise.allSettled([
      fetch(`${baseUrl}/api/stats`, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(`${baseUrl}/api/system/stats`, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(`${baseUrl}/api/stacks`, { headers, signal: AbortSignal.timeout(10000) }),
    ]);

    interface RemoteSystemStats {
      cpu: { usage: string; cores: number };
      memory: { total: number; used: number; free: number; usagePercent: string };
      disk?: { total: number; used: number; free: number; usagePercent: string } | null;
    }

    const stats: FleetNodeOverview['stats'] | null = statsRes.status === 'fulfilled' && statsRes.value.ok
      ? await statsRes.value.json() as FleetNodeOverview['stats'] : null;
    const systemStatsRaw: RemoteSystemStats | null = systemStatsRes.status === 'fulfilled' && systemStatsRes.value.ok
      ? await systemStatsRes.value.json() as RemoteSystemStats : null;
    const stacks: string[] | null = stacksRes.status === 'fulfilled' && stacksRes.value.ok
      ? await stacksRes.value.json() as string[] : null;

    const systemStats: FleetNodeOverview['systemStats'] | null = systemStatsRaw ? {
      cpu: systemStatsRaw.cpu,
      memory: systemStatsRaw.memory,
      disk: systemStatsRaw.disk ? {
        total: systemStatsRaw.disk.total,
        used: systemStatsRaw.disk.used,
        free: systemStatsRaw.disk.free,
        usagePercent: systemStatsRaw.disk.usagePercent,
      } : null,
    } : null;

    const completedAt = Date.now();
    const latency_ms = completedAt - t0;
    const isOnline = !!(stats || systemStats);

    if (isOnline) {
      db.updateNodeLastContact(node.id);
    }

    return {
      id: node.id,
      name: node.name,
      type: node.type,
      mode: node.mode,
      status: isOnline ? 'online' : 'offline',
      stats,
      systemStats,
      stacks,
      latency_ms,
      last_successful_contact: isOnline
        ? Math.floor(completedAt / 1000)
        : node.last_successful_contact ?? null,
      pilot_last_seen: pilotLastSeenSeconds(node),
      cordoned: node.cordoned,
      cordoned_at: node.cordoned_at,
      cordoned_reason: node.cordoned_reason,
    };
  } catch (error) {
    console.error(`[Fleet] Remote node ${node.name} error:`, error);
    return offlineRemoteOverview(node, 'offline');
  }
}

export const fleetRouter = Router();

// Fleet role: tells the frontend whether this Sencho is the control or a
// replica. The control serves read+write for security rules. Replicas are
// read-only and managed upstream.
fleetRouter.get('/role', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  res.json({ role: FleetSyncService.getRole() });
});

// Receive a full replacement of a replicated resource from the control.
// Restricted to node_proxy Bearer tokens so only a sibling Sencho can push.
//
// No requirePaid here: the control instance has already enforced its tier
// before issuing the push. The replica trusts a valid node_proxy bearer
// signed against THIS instance's secret and applies the payload regardless
// of the replica's own tier.
fleetRouter.post('/sync/:resource', authMiddleware, (req: Request, res: Response): void => {
  if (!requireNodeProxy(req, res)) return;
  const resource = req.params.resource;
  if (
    resource !== 'scan_policies'
    && resource !== 'cve_suppressions'
    && resource !== 'misconfig_acknowledgements'
  ) {
    res.status(400).json({ error: `Unsupported sync resource: ${resource}` });
    return;
  }
  const body = req.body ?? {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  const targetIdentity = typeof body.targetIdentity === 'string' ? body.targetIdentity : '';
  // pushedAt is optional for back-compat with older controls that predate the
  // versioning protocol. When present and strictly older than the most recent
  // applied push for this resource, reject with 409 STALE_SYNC_PUSH so the
  // control's retry logic can fall back to the next write. Negative or zero
  // values are treated as absent: the sender always uses Date.now().
  const pushedAt = typeof body.pushedAt === 'number' && Number.isFinite(body.pushedAt) && body.pushedAt > 0
    ? body.pushedAt
    : null;
  // controlIdentity is optional for back-compat. The receiver anchors to the
  // first non-empty fingerprint it sees and rejects mismatches afterward.
  const controlIdentity = typeof body.controlIdentity === 'string' ? body.controlIdentity : '';
  if (!rows) {
    res.status(400).json({ error: 'rows array is required' });
    return;
  }
  if (rows.length > MAX_SYNC_ROWS) {
    res.status(413).json({ error: `Too many rows (max ${MAX_SYNC_ROWS})` });
    return;
  }
  const validator =
    resource === 'scan_policies'
      ? validateScanPolicyRow
      : resource === 'cve_suppressions'
        ? validateCveSuppressionRow
        : validateMisconfigAcknowledgementRow;
  for (let i = 0; i < rows.length; i++) {
    const err = validator(rows[i]);
    if (err) {
      res.status(400).json({ error: `Invalid row at index ${i}: ${err}` });
      return;
    }
  }
  try {
    FleetSyncService.getInstance().applyIncomingSync(
      resource,
      rows,
      targetIdentity,
      pushedAt ?? undefined,
      controlIdentity || undefined,
    );
    res.json({ success: true, applied: rows.length });
  } catch (error) {
    if (error instanceof StaleSyncPushError) {
      res.status(409).json({
        error: error.message,
        code: SYNC_ERROR_CODES.staleSyncPush,
      });
      return;
    }
    if (error instanceof ControlIdentityMismatchError) {
      res.status(409).json({
        error: error.message,
        code: SYNC_ERROR_CODES.controlIdentityMismatch,
        expected: error.expected,
        got: error.got,
      });
      return;
    }
    console.error('[FleetSync] Failed to apply incoming sync:', error);
    res.status(500).json({ error: 'Failed to apply sync' });
  }
});

// Demote this replica back to a standalone control. Wipes all replicated
// security rules and the cached fingerprint, then flips `fleet_role` to
// 'control'. The local UI's write controls become available again.
// `{confirm: true}` body is required so a misclick cannot destroy mirrored
// state.
fleetRouter.post('/role/demote', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  const body = req.body ?? {};
  if (body.confirm !== true) {
    res.status(400).json({
      error: 'Demote requires explicit confirmation. Send { "confirm": true } to proceed.',
    });
    return;
  }
  try {
    const demoted = FleetSyncService.getInstance().demote();
    if (!demoted) {
      res.status(409).json({
        error: 'This instance is already a control; nothing to demote.',
        code: 'ALREADY_CONTROL',
      });
      return;
    }
    res.json({ success: true, role: 'control' });
  } catch (error) {
    console.error('[FleetSync] Demote failed:', error);
    res.status(500).json({ error: 'Failed to demote replica' });
  }
});

// Reset the control anchor on this replica. An admin must opt in explicitly
// with `{override: true}` because reanchor wipes all replicated rows; the
// next push from a different control will re-populate them. Used when a
// control is permanently rebuilt or replaced and must be re-bound to its
// existing replicas.
fleetRouter.post('/role/reanchor', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  const body = req.body ?? {};
  if (body.override !== true) {
    res.status(400).json({
      error: 'Reanchor requires explicit override. Send { "override": true } to confirm.',
    });
    return;
  }
  try {
    FleetSyncService.getInstance().reanchor();
    res.json({ success: true });
  } catch (error) {
    console.error('[FleetSync] Reanchor failed:', error);
    res.status(500).json({ error: 'Failed to reset control anchor' });
  }
});

fleetRouter.get('/sync-status', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  res.json(DatabaseService.getInstance().getFleetSyncStatuses());
});

fleetRouter.get('/overview', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const debug = isDebugEnabled();
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    if (debug) console.debug('[Fleet:debug] Overview requested, fetching', nodes.length, 'nodes');

    const results = await Promise.allSettled(
      nodes.map(async (node): Promise<FleetNodeOverview> => {
        if (node.type === 'remote') {
          return fetchRemoteNodeOverview(node, db);
        }
        return fetchLocalNodeOverview(node);
      }),
    );

    const overview: FleetNodeOverview[] = results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(`[Fleet] Failed to fetch node ${nodes[i].name}:`, result.reason);
      return {
        id: nodes[i].id,
        name: nodes[i].name,
        type: nodes[i].type,
        status: 'offline' as const,
        stats: null,
        systemStats: null,
        stacks: null,
        cordoned: nodes[i].cordoned,
        cordoned_at: nodes[i].cordoned_at,
        cordoned_reason: nodes[i].cordoned_reason,
      };
    });

    if (debug) {
      const online = overview.filter(n => n.status === 'online').length;
      console.debug('[Fleet:debug] Overview complete:', online, 'online,', overview.length - online, 'offline');
    }
    res.json(overview);
  } catch (error) {
    console.error('[Fleet] Overview error:', error);
    res.status(500).json({ error: 'Failed to fetch fleet overview' });
  }
});

interface FleetNodeConfiguration {
  id: number;
  name: string;
  type: 'local' | 'remote';
  status: 'online' | 'offline';
  configuration: ConfigurationStatus | null;
}

fleetRouter.get('/configuration', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    const userId = req.user?.userId ?? 0;
    const ls = LicenseService.getInstance();
    const localTier = ls.getTier();

    const results = await Promise.allSettled(
      nodes.map(async (node: Node): Promise<FleetNodeConfiguration> => {
        if (node.type === 'local') {
          return {
            id: node.id,
            name: node.name,
            type: 'local',
            status: 'online',
            configuration: buildLocalConfigurationStatus(node.id, userId, localTier),
          };
        }

        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) {
          return { id: node.id, name: node.name, type: 'remote', status: 'offline', configuration: null };
        }

        try {
          const resp = await fetch(
            `${target.apiUrl.replace(/\/$/, '')}/api/dashboard/configuration`,
            {
              headers: {
                ...(target.apiToken ? { Authorization: `Bearer ${target.apiToken}` } : {}),
                [PROXY_TIER_HEADER]: localTier,
              },
              signal: AbortSignal.timeout(10000),
            },
          );
          const configuration = resp.ok ? (await resp.json() as ConfigurationStatus) : null;
          return {
            id: node.id,
            name: node.name,
            type: 'remote',
            status: configuration ? 'online' : 'offline',
            configuration,
          };
        } catch {
          return { id: node.id, name: node.name, type: 'remote', status: 'offline', configuration: null };
        }
      }),
    );

    const fleet: FleetNodeConfiguration[] = results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(`[Fleet] Configuration fetch failed for node ${nodes[i].name}:`, result.reason);
      return { id: nodes[i].id, name: nodes[i].name, type: nodes[i].type, status: 'offline', configuration: null };
    });

    res.json(fleet);
  } catch (error) {
    console.error('[Fleet] Configuration overview error:', error);
    res.status(500).json({ error: 'Failed to fetch fleet configuration' });
  }
});

/**
 * Fleet-wide dependency map. Auth-only (read-only visibility, Community). Fans
 * out to every node, building each node's local graph in-process for the hub
 * and via its auth-only per-node route for remotes, then merges with per-node
 * attribution. Unreachable nodes degrade to nodeErrors so the rest still draws.
 */
fleetRouter.get('/dependency-map', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();

    const results = await Promise.allSettled(
      nodes.map(async (node: Node): Promise<FleetNodeGraphResult> => {
        if (node.type === 'local') {
          const graph = await buildLocalGraph(node.id, node.name);
          return { nodeId: node.id, nodeName: node.name, status: 'ok', graph, error: null };
        }

        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) {
          return { nodeId: node.id, nodeName: node.name, status: 'error', graph: null, error: formatNoTargetError(node) };
        }

        const resp = await fetch(
          `${target.apiUrl.replace(/\/$/, '')}/api/dependency-map/node-graph`,
          {
            headers: { ...(target.apiToken ? { Authorization: `Bearer ${target.apiToken}` } : {}) },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!resp.ok) {
          const errBody = await resp.json().catch(() => null) as { error?: string } | null;
          return { nodeId: node.id, nodeName: node.name, status: 'error', graph: null, error: errBody?.error ?? `Remote returned ${resp.status}` };
        }
        const graph = await resp.json().catch(() => null);
        // Shape-guard a reachable-but-malformed payload (proxy HTML, version
        // drift) so one bad node degrades to a nodeError instead of crashing
        // mergeFleetGraph and 500-ing the whole fleet map.
        if (!isLocalDependencyGraph(graph)) {
          console.error(`[Fleet] Dependency map: node ${sanitizeForLog(node.name)} returned a payload that failed shape validation (status ${resp.status})`);
          return { nodeId: node.id, nodeName: node.name, status: 'error', graph: null, error: 'Remote returned an unexpected dependency-graph payload' };
        }
        return { nodeId: node.id, nodeName: node.name, status: 'ok', graph, error: null };
      }),
    );

    const perNode: FleetNodeGraphResult[] = results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(`[Fleet] Dependency map fetch failed for node ${nodes[i].name}:`, result.reason);
      return { nodeId: nodes[i].id, nodeName: nodes[i].name, status: 'error', graph: null, error: getErrorMessage(result.reason, 'Failed to reach node') };
    });

    res.json(mergeFleetGraph(perNode));
  } catch (error) {
    console.error('[Fleet] Dependency map error:', error);
    res.status(500).json({ error: 'Failed to build fleet dependency map' });
  }
});

interface FleetNetworkingSummaryNode {
  nodeId: number;
  nodeName: string;
  status: 'ok' | 'error';
  summary: NodeNetworkingSummary | null;
  error: string | null;
}

function isNodeNetworkingSummary(v: unknown): v is NodeNetworkingSummary {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (['exposed', 'unknownExposure', 'networkDrift'] as const).every(k => {
    const b = o[k] as { count?: unknown; stacks?: unknown } | undefined;
    return !!b && typeof b.count === 'number' && Array.isArray(b.stacks);
  });
}

/**
 * Fleet-wide networking summary for the overview filter. Auth-only (read-only,
 * Community). Hub-exempt under /api/fleet, so it is never proxied: it builds the
 * hub's summary in-process and reaches each remote through its node-local
 * /api/networking/summary route. A remote on an older version (no route) returns
 * 404 and degrades to a skip, so one unreachable or unsupported node never fails
 * the filter for the rest.
 */
fleetRouter.get('/networking-summary', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();

    const results = await Promise.allSettled(
      nodes.map(async (node: Node): Promise<FleetNetworkingSummaryNode> => {
        if (node.type === 'local') {
          const summary = await computeNodeNetworkingSummary(node.id);
          return { nodeId: node.id, nodeName: node.name, status: 'ok', summary, error: null };
        }
        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) {
          return { nodeId: node.id, nodeName: node.name, status: 'error', summary: null, error: formatNoTargetError(node) };
        }
        const resp = await fetch(
          `${target.apiUrl.replace(/\/$/, '')}/api/networking/summary`,
          { headers: { ...(target.apiToken ? { Authorization: `Bearer ${target.apiToken}` } : {}) }, signal: AbortSignal.timeout(15000) },
        );
        if (!resp.ok) {
          return { nodeId: node.id, nodeName: node.name, status: 'error', summary: null, error: `Remote returned ${resp.status}` };
        }
        const summary = await resp.json().catch(() => null);
        if (!isNodeNetworkingSummary(summary)) {
          console.error(`[Fleet] Networking summary: node ${sanitizeForLog(node.name)} returned an unexpected payload (status ${resp.status})`);
          return { nodeId: node.id, nodeName: node.name, status: 'error', summary: null, error: 'Remote returned an unexpected summary payload' };
        }
        return { nodeId: node.id, nodeName: node.name, status: 'ok', summary, error: null };
      }),
    );

    const perNode: FleetNetworkingSummaryNode[] = results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(`[Fleet] Networking summary fetch failed for node ${nodes[i].name}:`, result.reason);
      return { nodeId: nodes[i].id, nodeName: nodes[i].name, status: 'error', summary: null, error: getErrorMessage(result.reason, 'Failed to reach node') };
    });

    res.json({ nodes: perNode });
  } catch (error) {
    console.error('[Fleet] Networking summary error:', error);
    res.status(500).json({ error: 'Failed to build fleet networking summary' });
  }
});

fleetRouter.get('/node/:nodeId/stacks', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = parseIntParam(req, res, 'nodeId', 'node ID');
    if (nodeId === null) return;
    const node = DatabaseService.getInstance().getNode(nodeId);
    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    if (node.type === 'remote') {
      const target = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!target) {
        res.status(503).json({ error: formatNoTargetError(node) });
        return;
      }
      const response = await fetch(`${target.apiUrl.replace(/\/$/, '')}/api/stacks`, {
        headers: target.apiToken ? { Authorization: `Bearer ${target.apiToken}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        res.status(502).json({ error: 'Failed to fetch stacks from remote node' });
        return;
      }
      const stacks = await response.json();
      if (isDebugEnabled()) console.debug('[Fleet:debug] Node stacks:', nodeId, node.type, Array.isArray(stacks) ? stacks.length : 0, 'stacks');
      res.json(stacks);
      return;
    }

    const stacks = await FileSystemService.getInstance(nodeId).getStacks();
    if (isDebugEnabled()) console.debug('[Fleet:debug] Node stacks:', nodeId, node.type, stacks.length, 'stacks');
    res.json(stacks);
  } catch (error) {
    console.error('[Fleet] Node stacks error:', error);
    res.status(500).json({ error: 'Failed to fetch node stacks' });
  }
});

fleetRouter.get('/node/:nodeId/stacks/:stackName/containers', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = parseIntParam(req, res, 'nodeId', 'node ID');
    if (nodeId === null) return;
    const stackName = req.params.stackName as string;
    if (!isValidStackName(stackName)) {
      res.status(400).json({ error: 'Invalid stack name' });
      return;
    }
    const node = DatabaseService.getInstance().getNode(nodeId);
    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    if (node.type === 'remote') {
      const target = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!target) {
        res.status(503).json({ error: formatNoTargetError(node) });
        return;
      }
      const response = await fetch(`${target.apiUrl.replace(/\/$/, '')}/api/stacks/${encodeURIComponent(stackName)}/containers`, {
        headers: target.apiToken ? { Authorization: `Bearer ${target.apiToken}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        res.status(502).json({ error: 'Failed to fetch containers from remote node' });
        return;
      }
      const containers = await response.json();
      res.json(containers);
      return;
    }

    const dockerController = DockerController.getInstance(nodeId);
    const containers = await dockerController.getContainersByStack(stackName);
    if (isDebugEnabled()) console.debug('[Fleet:debug] Stack containers:', nodeId, stackName, containers.length, 'containers');
    res.json(containers);
  } catch (error) {
    console.error('[Fleet] Node stack containers error:', error);
    res.status(500).json({ error: 'Failed to fetch stack containers' });
  }
});

fleetRouter.get('/update-status', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    const gatewayVersion = getSenchoVersion();
    const gatewayValid = isValidVersion(gatewayVersion);

    const { latestVersion, latestValid, compareVersion, compareValid } = await getCompareTarget(gatewayVersion);
    const debug = isDebugEnabled();

    const results = await Promise.allSettled(
      nodes.map(async (node) => {
        const tracker = updateTracker.get(node.id);
        const statusBeforeResolve = tracker?.status;

        let version: string | null = null;
        let remoteStartedAt: number | null = null;
        let remoteUpdateError: string | null = null;
        let remoteOnline = false;
        if (node.type === 'local') {
          version = gatewayVersion;
        } else {
          const meta = await NodeRegistry.getInstance().fetchMetaForNode(node.id);
          version = meta.version;
          remoteStartedAt = meta.startedAt;
          remoteUpdateError = meta.updateError;
          remoteOnline = meta.online;
        }

        if (tracker?.status === 'updating') {
          const elapsed = Date.now() - tracker.startedAt;

          if (debug) {
            console.debug('[Fleet:debug] Polling update status for node', node.id, node.name, '- elapsed:', Math.round(elapsed / 1000) + 's', 'version:', version, 'wasOffline:', tracker.wasOffline, 'remoteOnline:', remoteOnline);
          }

          if (elapsed > UPDATE_TIMEOUT_MS) {
            if (debug) console.debug('[Fleet:debug] Node', node.id, 'timed out after', Math.round(elapsed / 1000) + 's');
            resolveTerminal(node, tracker, 'timeout', UPDATE_TIMEOUT_MSG);
          } else if (node.type === 'remote') {
            if (remoteUpdateError) {
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'reported pull failure:', remoteUpdateError);
              resolveTerminal(node, tracker, 'failed', remoteUpdateError);
            } else if (!remoteOnline) {
              if (!tracker.wasOffline) {
                if (debug) console.debug('[Fleet:debug] Node', node.id, 'went offline (restarting)');
                updateTracker.set(node.id, { ...tracker, wasOffline: true });
              }
            } else if (isValidVersion(version) && version !== tracker.previousVersion) {
              // Signal 1: a valid, different version. A null/unparseable version
              // from a transient /api/meta blip is NOT a version change, so it
              // must not complete a still-running, same-process node here.
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'completed via signal 1 (version changed):', tracker.previousVersion, '->', version);
              updateTracker.set(node.id, updateTracker.resolve(tracker, 'completed'));
            } else if (
              remoteStartedAt !== null &&
              tracker.previousProcessStart !== null &&
              remoteStartedAt !== tracker.previousProcessStart
            ) {
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'completed via signal 2 (process restarted):', tracker.previousProcessStart, '->', remoteStartedAt);
              updateTracker.set(node.id, updateTracker.resolve(tracker, 'completed'));
            } else if (
              tracker.wasOffline &&
              remoteOnline &&
              (remoteStartedAt === null || tracker.previousProcessStart === null)
            ) {
              // Signal 3: offline-then-online is only trustworthy as a completion
              // signal when we cannot read the remote process start time. When
              // startedAt IS known and unchanged (signal 2 above did not fire),
              // the process never restarted, so a brief unreachable blip on the
              // same version must not be reported as a completed update; it falls
              // through to the early-fail / timeout heuristics instead.
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'completed via signal 3 (offline then online, startedAt unavailable)');
              updateTracker.set(node.id, updateTracker.resolve(tracker, 'completed'));
            } else if (
              elapsed > 15_000 &&
              isValidVersion(version) &&
              gatewayValid &&
              !semver.lt(version, compareVersion!)
            ) {
              // Signal 4: remote is now at or above gateway version (after
              // minimum processing time). Catches fast restarts where the 5s
              // polling interval misses the offline window and startedAt
              // hasn't been observed to change yet.
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'completed via signal 4 (version >= compare target):', version, '>=', compareVersion);
              updateTracker.set(node.id, updateTracker.resolve(tracker, 'completed'));
            } else if (elapsed > EARLY_FAIL_MS) {
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'early fail after', Math.round(elapsed / 1000) + 's - no signals detected');
              resolveTerminal(node, tracker, 'failed', 'Update may have failed. The node is still running and its version has not changed.');
            }
          } else if (node.type === 'local') {
            // Local node has only two failure signals: an explicit pull/spawn
            // error, or the early-fail heuristic. Success is observed by the
            // frontend overlay (it reloads when /api/health reports a new
            // startedAt), at which point the new process starts with an empty
            // tracker map.
            const selfUpdate = SelfUpdateService.getInstance();
            const localError = selfUpdate.getLastError();
            if (localError) {
              if (debug) console.debug('[Fleet:debug] Local node', node.id, 'update failed:', localError);
              resolveTerminal(node, tracker, 'failed', localError);
              selfUpdate.clearLastError();
            } else if (elapsed > EARLY_FAIL_MS) {
              if (debug) console.debug('[Fleet:debug] Local node', node.id, 'early fail after', Math.round(elapsed / 1000) + 's');
              resolveTerminal(node, tracker, 'failed', 'Local update did not complete. The container may not have restarted; check Docker logs on the host.');
            }
          }
        }

        // Auto-expire completed entries after their visibility window so the
        // badge is visible briefly after completion.
        if (tracker?.status === 'completed' && tracker.resolvedAt && Date.now() - tracker.resolvedAt > TERMINAL_TTL_MS) {
          updateTracker.delete(node.id);
        }

        let updateAvailable = false;
        if (!isValidVersion(version)) {
          // Assume remote nodes are outdated when their version is unresolvable.
          updateAvailable = node.type === 'remote';
        } else if (compareValid) {
          updateAvailable = semver.lt(version, compareVersion!);
        }

        const currentTracker = updateTracker.get(node.id);
        // A node that just finished updating runs new code with a possibly
        // different version and capability set. Drop its cached /api/meta on
        // the completion transition so the dashboard reflects the new state
        // immediately instead of waiting out the remote-meta TTL.
        if (
          node.type === 'remote' &&
          statusBeforeResolve !== 'completed' &&
          currentTracker?.status === 'completed'
        ) {
          invalidateRemoteMetaCache(node.id);
        }
        return {
          nodeId: node.id,
          name: node.name,
          type: node.type,
          version,
          latestVersion: latestValid ? latestVersion : gatewayVersion,
          updateAvailable,
          updateStatus: currentTracker?.status ?? null,
          error: currentTracker?.error ?? null,
        };
      }),
    );

    const nodeStatuses = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      console.warn(`[Fleet] Update-status poll failed for node ${nodes[i].name}:`, r.reason);
      return {
        nodeId: nodes[i].id,
        name: nodes[i].name,
        type: nodes[i].type,
        version: null,
        latestVersion: latestValid ? latestVersion : gatewayVersion,
        updateAvailable: false,
        updateStatus: null,
        error: null,
      };
    });

    if (isDebugEnabled()) {
      const trackerStates = Array.from(updateTracker.entries()).map(([nid, t]) => `${nid}:${t.status}`);
      console.debug('[Fleet:debug] Update status:', nodeStatuses.length, 'nodes, trackers:', trackerStates.join(', ') || 'none');
    }
    res.json({ nodes: nodeStatuses });
  } catch (error) {
    console.error('[Fleet] Update status error:', error);
    res.status(500).json({ error: 'Failed to fetch update status' });
  }
});

// Pilot loopback targets carry an empty apiToken because the tunnel bridge
// re-injects admin auth; sending a malformed `Bearer ` header would 401 on
// the pilot's local Express. Omit the header in that case.
function postSystemUpdate(target: { apiUrl: string; apiToken: string }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
  return fetch(`${target.apiUrl.replace(/\/$/, '')}/api/system/update`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(10000),
  });
}

fleetRouter.post('/nodes/:nodeId/update', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const nodeId = parseIntParam(req, res, 'nodeId', 'node ID');
    if (nodeId === null) return;
    const db = DatabaseService.getInstance();
    const node = db.getNode(nodeId);
    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    const existing = updateTracker.get(nodeId);
    if (existing?.status === 'updating') {
      if (Date.now() - existing.startedAt > UPDATE_TIMEOUT_MS) {
        updateTracker.set(nodeId, updateTracker.resolve(existing, 'timeout', UPDATE_TIMEOUT_MSG));
      } else {
        res.status(409).json({ error: 'Update already in progress for this node.' });
        return;
      }
    }
    // Clear terminal states to allow retry.
    if (existing && (existing.status === 'timeout' || existing.status === 'failed' || existing.status === 'completed')) {
      updateTracker.delete(nodeId);
    }

    console.log('[Fleet] Update triggered for node', node.name, node.type);
    if (isDebugEnabled()) {
      console.debug('[Fleet:debug] Update trigger details:', { nodeId, name: node.name, type: node.type, mode: node.mode });
    }

    if (node.type === 'local') {
      if (!SelfUpdateService.getInstance().isAvailable()) {
        res.status(503).json({ error: 'Self-update unavailable on the local node.' });
        return;
      }
      updateTracker.set(nodeId, updateTracker.create('updating', getSenchoVersion(), null));
      scheduleLocalUpdate(res, 'Update initiated on local node. The server will restart shortly.');
      return;
    }

    const target = NodeRegistry.getInstance().getProxyTarget(node.id);
    if (!target) {
      res.status(503).json({ error: formatNoTargetError(node) });
      return;
    }

    const meta = await NodeRegistry.getInstance().fetchMetaForNode(node.id);
    if (isDebugEnabled()) {
      console.debug('[Fleet:debug] Remote meta for update:', { nodeId, online: meta.online, version: meta.version, capabilities: meta.capabilities, startedAt: meta.startedAt });
    }
    if (!meta.online) {
      res.status(503).json({ error: 'Remote node is unreachable. Verify the node is running and the API URL is correct.' });
      return;
    }
    if (!meta.capabilities.includes('self-update')) {
      res.status(503).json({ error: 'Remote node does not support self-update. It may need to be updated manually first.' });
      return;
    }

    const response = await postSystemUpdate(target);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const errorMsg = (err as Record<string, string>)?.error || 'Remote node rejected update request.';
      updateTracker.set(nodeId, updateTracker.create('failed', meta.version, meta.startedAt, errorMsg));
      res.status(502).json({ error: errorMsg });
      return;
    }

    updateTracker.set(nodeId, updateTracker.create('updating', meta.version, meta.startedAt));
    res.status(202).json({ message: `Update initiated on ${node.name}.` });
  } catch (error) {
    console.error('[Fleet] Node update error:', error);
    const errorMsg = getErrorMessage(error, 'Failed to trigger node update.');
    const failedNodeId = parseInt(req.params.nodeId as string, 10);
    if (!isNaN(failedNodeId)) {
      updateTracker.set(failedNodeId, updateTracker.create('failed', null, null, errorMsg));
    }
    res.status(500).json({ error: 'Failed to trigger node update.' });
  }
});

fleetRouter.post('/update-all', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    const gatewayVersion = getSenchoVersion();
    const { compareVersion, compareValid } = await getCompareTarget(gatewayVersion);

    const debug = isDebugEnabled();
    console.log('[Fleet] Update-all triggered,', nodes.length, 'nodes registered');
    if (debug) console.debug('[Fleet:debug] Update-all compare target:', { gatewayVersion, compareVersion, compareValid });

    const registry = NodeRegistry.getInstance();
    const candidates = nodes.filter(node => {
      if (node.type === 'local') return false;
      const tracker = updateTracker.get(node.id);
      if (tracker?.status === 'updating') return false;
      if (registry.getProxyTarget(node.id) === null) return false;
      // Clear terminal states so they can be re-triggered.
      if (tracker && (tracker.status === 'timeout' || tracker.status === 'failed' || tracker.status === 'completed')) {
        updateTracker.delete(node.id);
      }
      return true;
    });

    const results = await Promise.allSettled(candidates.map(async (node) => {
      const target = registry.getProxyTarget(node.id);
      if (!target) return { name: node.name, triggered: false };
      const meta = await registry.fetchMetaForNode(node.id);
      if (!meta.online) {
        return { name: node.name, triggered: false };
      }
      if (!meta.capabilities.includes('self-update')) {
        return { name: node.name, triggered: false };
      }
      if (isValidVersion(meta.version) && compareValid && !semver.lt(meta.version, compareVersion!)) {
        return { name: node.name, triggered: false };
      }
      const response = await postSystemUpdate(target);
      if (response.ok) {
        updateTracker.set(node.id, updateTracker.create('updating', meta.version, meta.startedAt));
        return { name: node.name, triggered: true };
      }
      return { name: node.name, triggered: false };
    }));

    const updating: string[] = [];
    const skipped = nodes.filter(n => !candidates.includes(n)).map(n => n.name);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        console.warn(`[Fleet] Update-all failed for node ${candidates[i].name}:`, r.reason);
      }
      const val = r.status === 'fulfilled' ? r.value : { name: candidates[i].name, triggered: false };
      (val.triggered ? updating : skipped).push(val.name);
    }

    if (debug) console.debug('[Fleet:debug] Update-all results:', { updating, skippedCount: skipped.length, candidateCount: candidates.length });
    res.status(202).json({ updating, skipped });
  } catch (error) {
    console.error('[Fleet] Update all error:', error);
    res.status(500).json({ error: 'Failed to trigger fleet update.' });
  }
});

fleetRouter.delete('/nodes/:nodeId/update-status', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const nodeId = parseIntParam(req, res, 'nodeId', 'node ID');
    if (nodeId === null) return;
    const node = DatabaseService.getInstance().getNode(nodeId);
    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    updateTracker.delete(nodeId);
    res.status(204).send();
  } catch (error) {
    console.error('[Fleet] Clear update status error:', error);
    res.status(500).json({ error: 'Failed to clear update status.' });
  }
});

fleetRouter.delete('/update-status', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  // Optionally pre-fetch a fresh latest version so the next GET compares against
  // it. Throttled so a caller cannot loop this to hammer the upstream registries;
  // `rechecked` tells the client whether the forced refresh actually ran.
  let rechecked = false;
  if (req.query.recheck === 'true') {
    const now = Date.now();
    if (now - lastForcedRecheckAt >= FORCED_RECHECK_COOLDOWN_MS) {
      lastForcedRecheckAt = now;
      await getLatestVersion(true);
      rechecked = true;
    }
  }
  for (const [nodeId, tracker] of updateTracker.entries()) {
    if (tracker.status === 'timeout' || tracker.status === 'failed' || tracker.status === 'completed') {
      updateTracker.delete(nodeId);
    }
  }
  res.status(200).json({ rechecked });
});

// ─── Fleet Actions: gateway-orchestrated endpoints (multi-node) ───
//
// Per-node fleet-action endpoints (run on the target node via the proxy) live
// in `routes/fleetActions.ts`. The endpoint below is gateway-orchestrated and
// lives here so it sits behind the `/api/fleet/` proxy-exempt prefix.

// Attribute one error to every stack a node was supposed to act on. Used for
// the local-node exception path, where the control DB authoritatively knows the
// local stack list, so each stack carries the same node-level cause.
const failAllStacks = (stacks: string[], error: string): StackStopResult[] =>
  stacks.map(stackName => ({ stackName, success: false, error }));

type FleetStopNodeResult = {
  nodeId: number;
  nodeName: string;
  reachable: boolean;
  matched: boolean;
  stackResults: StackStopResult[];
  error?: string;
};

// Fleet-wide stop by label name. Each node is asked authoritatively: the local
// node matches against its own DB in-process; each remote runs the match + stop
// on its own Docker via its local-stop receiver. Remote label rows are never
// mirrored to the control, so there is no central pre-check; unreachable nodes
// are reported at the node level and never block the reachable ones.
// Tier: requireAdmin (admin-only fleet plumbing; available on every license).
fleetRouter.post('/labels/fleet-stop', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const body = req.body as { labelName?: unknown; dryRun?: unknown } | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }
  const { labelName, dryRun } = body;
  if (typeof labelName !== 'string' || labelName.trim().length === 0) {
    res.status(400).json({ error: 'labelName is required' });
    return;
  }
  const trimmed = labelName.trim();
  const isDryRun = dryRun === true;
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    if (isDebugEnabled()) console.debug('[Fleet:debug] fleet-stop:', { labelName: trimmed, dryRun: isDryRun, nodes: nodes.length });
    const results = await Promise.all(nodes.map(async (node): Promise<FleetStopNodeResult> => {
      if (node.type === 'local') {
        // Match + stop runs in-process against the control's own Docker. The
        // helper shares the per-node `bulk:<id>` lock with the per-label action
        // route so the two cannot double-stop the same containers. A control-side
        // failure (e.g. the compose dir is unreadable) degrades to a per-stack
        // error for this node only; the node is reachable, the stop just failed.
        try {
          const outcome = await runLocalLabelStop(node.id, trimmed, isDryRun);
          return { nodeId: node.id, nodeName: node.name, reachable: true, matched: outcome.matched, stackResults: outcome.stackResults };
        } catch (err) {
          const errorMsg = getErrorMessage(err, 'Failed to stop local stacks');
          const localLabel = db.getLabels(node.id).find(l => l.name === trimmed);
          const localStacks = localLabel ? db.getStacksForLabel(localLabel.id, node.id) : [];
          return {
            nodeId: node.id, nodeName: node.name, reachable: true, matched: !!localLabel,
            stackResults: failAllStacks(localStacks, errorMsg),
          };
        }
      }

      // Remote node. Ask the remote authoritatively via its admin-only local-stop
      // receiver, which name-matches under the remote's own bulk lock. There is no
      // control-side pre-check: remote label rows are never mirrored to the
      // control, so a mirror lookup would skip every remote. A node we cannot
      // reach is reported at the node level and never blocks the reachable nodes.
      const target = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!target) {
        return { nodeId: node.id, nodeName: node.name, reachable: false, matched: false, stackResults: [], error: formatNoTargetError(node) };
      }
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
        const response = await fetch(`${target.apiUrl.replace(/\/$/, '')}/api/fleet-actions/labels/local-stop`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ labelName: trimmed, dryRun: isDryRun }),
          signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) {
          const err = (await response.json().catch(() => ({}))) as { error?: string };
          return { nodeId: node.id, nodeName: node.name, reachable: false, matched: false, stackResults: [], error: err.error || `Remote returned ${response.status}` };
        }
        // A 200 with a body that isn't the local-stop contract is a remote
        // failure, not an empty stop. Fail the node (matching the non-ok and
        // unreachable paths above) instead of defaulting matched to true and
        // results to [], which the UI renders as a successful zero-stack node
        // and hides the remote contract break.
        const remote = await response.json().catch(() => null);
        if (!isLabelLocalStopResponse(remote)) {
          return { nodeId: node.id, nodeName: node.name, reachable: false, matched: false, stackResults: [], error: 'Remote returned a malformed response' };
        }
        return {
          nodeId: node.id, nodeName: node.name, reachable: true,
          matched: remote.matched,
          stackResults: remote.results,
        };
      } catch (err) {
        return { nodeId: node.id, nodeName: node.name, reachable: false, matched: false, stackResults: [], error: getErrorMessage(err, 'Failed to reach remote node') };
      }
    }));
    if (isDebugEnabled()) {
      const matched = results.filter(r => r.matched).length;
      const stopped = results.reduce((n, r) => n + r.stackResults.filter(s => s.success).length, 0);
      const failed = results.reduce((n, r) => n + r.stackResults.filter(s => !s.success).length, 0);
      console.debug('[Fleet:debug] fleet-stop complete:', { matched, stopped, failed });
    }
    res.json({ results });
  } catch (error) {
    console.error('[Fleet] fleet-stop error:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to run fleet stop') });
  }
});

// Fleet-wide Docker prune. Fans out to every node, running per-target prune
// (images/volumes/networks) under the chosen scope. Local nodes call
// DockerController directly under a per-node bulk-prune lock; remote nodes
// receive one POST /api/system/prune/system per target via the standard
// Bearer-token path. Concurrent execution against the per-node prune route in
// systemMaintenance.ts is safe because Docker's prune API is internally
// serialized and idempotent (the worst case is a duplicate call returning 0
// reclaimed bytes).
// Tier: requireAdmin (admin-only fleet plumbing; available on every license).
const FLEET_PRUNE_TARGETS = ['images', 'volumes', 'networks'] as const;
type FleetPruneTarget = (typeof FLEET_PRUNE_TARGETS)[number];

fleetRouter.post('/labels/fleet-prune', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const body = req.body as { targets?: unknown; scope?: unknown; dryRun?: unknown } | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }
  const rawTargets = Array.isArray(body.targets) ? body.targets : null;
  if (!rawTargets || rawTargets.length === 0) {
    res.status(400).json({ error: 'targets must be a non-empty array' });
    return;
  }
  const dedup = new Set<FleetPruneTarget>();
  for (const t of rawTargets) {
    if (typeof t !== 'string' || !(FLEET_PRUNE_TARGETS as readonly string[]).includes(t)) {
      res.status(400).json({ error: `Invalid target: ${typeof t === 'string' ? t : typeof t}` });
      return;
    }
    dedup.add(t as FleetPruneTarget);
  }
  const targets: FleetPruneTarget[] = Array.from(dedup);
  const scope: 'managed' | 'all' = body.scope === 'all' ? 'all' : 'managed';
  const isDryRun = body.dryRun === true;

  type TargetResult = { target: FleetPruneTarget; success: boolean; reclaimedBytes: number; error?: string; dryRun?: boolean };
  type NodeResult = {
    nodeId: number; nodeName: string; reachable: boolean; error?: string; targets: TargetResult[];
  };

  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    if (isDebugEnabled()) console.debug('[Fleet:debug] fleet-prune:', { targets, scope, dryRun: isDryRun, nodes: nodes.length });

    const results: NodeResult[] = await Promise.all(nodes.map(async (node): Promise<NodeResult> => {
      if (node.type === 'local') {
        const lockKey = `bulk-prune:${node.id}`;
        if (activeBulkActions.has(lockKey)) {
          return {
            nodeId: node.id, nodeName: node.name, reachable: true,
            targets: targets.map(t => ({ target: t, success: false, reclaimedBytes: 0, error: 'A prune is already running on this node' })),
          };
        }
        activeBulkActions.add(lockKey);
        try {
          const knownStacks = scope === 'managed' ? await FileSystemService.getInstance(node.id).getStacks() : [];
          const dockerController = DockerController.getInstance(node.id);
          const targetResults: TargetResult[] = [];
          let anySuccess = false;
          for (const target of targets) {
            try {
              if (isDryRun) {
                // estimateSystemReclaim hits `docker system df`; bound it
                // so a slow local daemon doesn't hang the fleet admin tab
                // (F-6). estimateManagedReclaim is fast (no df) and stays
                // unwrapped.
                const estimate = scope === 'managed'
                  ? await dockerController.estimateManagedReclaim(target, knownStacks)
                  : await withTimeout(
                      dockerController.estimateSystemReclaim(target, knownStacks),
                      FLEET_DF_TIMEOUT_MS,
                      'docker disk usage',
                    );
                targetResults.push({ target, success: true, reclaimedBytes: estimate.reclaimableBytes, dryRun: true });
                continue;
              }
              const result = scope === 'managed'
                ? await dockerController.pruneManagedOnly(target, knownStacks)
                : await dockerController.pruneSystem(target);
              targetResults.push({ target, success: true, reclaimedBytes: result.reclaimedBytes });
              if (result.reclaimedBytes > 0 || result.success) anySuccess = true;
            } catch (err) {
              const error = err instanceof TimeoutError
                ? 'Docker daemon is busy. Please try again in a moment.'
                : getErrorMessage(err, 'Prune failed');
              targetResults.push({ target, success: false, reclaimedBytes: 0, error });
            }
          }
          if (anySuccess && !isDryRun) invalidateNodeCaches(node.id);
          return { nodeId: node.id, nodeName: node.name, reachable: true, targets: targetResults };
        } finally {
          activeBulkActions.delete(lockKey);
        }
      }

      // Remote node: POST /api/system/prune/system per target, short-circuiting
      // on the first transport-level failure so we don't hammer a dead node.
      const proxyTarget = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!proxyTarget) {
        const error = formatNoTargetError(node);
        return {
          nodeId: node.id, nodeName: node.name, reachable: false, error,
          targets: targets.map(t => ({ target: t, success: false, reclaimedBytes: 0, error })),
        };
      }
      const baseUrl = proxyTarget.apiUrl.replace(/\/$/, '');
      const remoteHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (proxyTarget.apiToken) remoteHeaders.Authorization = `Bearer ${proxyTarget.apiToken}`;
      const targetResults: TargetResult[] = [];
      let nodeUnreachable: string | null = null;
      for (const target of targets) {
        if (nodeUnreachable) {
          targetResults.push({ target, success: false, reclaimedBytes: 0, error: nodeUnreachable });
          continue;
        }
        try {
          const response = await fetch(`${baseUrl}/api/system/prune/system`, {
            method: 'POST',
            headers: remoteHeaders,
            body: JSON.stringify({ target, scope, dryRun: isDryRun }),
            signal: AbortSignal.timeout(120000),
          });
          if (!response.ok) {
            const errBody = (await response.json().catch(() => ({}))) as { error?: string };
            const message = errBody.error || `Remote returned ${response.status}`;
            nodeUnreachable = message;
            targetResults.push({ target, success: false, reclaimedBytes: 0, error: message });
            continue;
          }
          const remote = (await response.json().catch(() => null)) as { success?: boolean; reclaimedBytes?: number; dryRun?: boolean } | null;
          if (!remote || typeof remote.reclaimedBytes !== 'number') {
            targetResults.push({ target, success: false, reclaimedBytes: 0, error: 'Invalid response from remote node' });
            continue;
          }
          const entry: TargetResult = { target, success: remote.success !== false, reclaimedBytes: remote.reclaimedBytes };
          if (remote.dryRun) entry.dryRun = true;
          targetResults.push(entry);
        } catch (err) {
          const message = getErrorMessage(err, 'Failed to reach remote node');
          nodeUnreachable = message;
          targetResults.push({ target, success: false, reclaimedBytes: 0, error: message });
        }
      }
      return {
        nodeId: node.id, nodeName: node.name,
        reachable: nodeUnreachable === null,
        error: nodeUnreachable ?? undefined,
        targets: targetResults,
      };
    }));

    if (isDebugEnabled()) {
      const reachable = results.filter(r => r.reachable).length;
      const reclaimed = results.reduce((n, r) => n + r.targets.reduce((m, t) => m + t.reclaimedBytes, 0), 0);
      console.debug('[Fleet:debug] fleet-prune complete:', { reachable, unreachable: results.length - reachable, reclaimedBytes: reclaimed });
    }
    res.json({ results });
  } catch (error) {
    console.error('[Fleet] fleet-prune error:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to run fleet prune') });
  }
});

// ─── Fleet Actions: blast-radius preview endpoints (non-destructive) ───
//
// Power the live readouts in the Fleet Action cards. Same auth gates as the
// destructive endpoints above so the surface stays uniform: an operator who
// can fire `fleet-stop` is also the operator who can ask how big it would be.

// Per-label fleet preview. Fans out to every node authoritatively (local DB +
// live remote reads via collectFleetLabelSummaries) and reports, per node, the
// matching stacks, whether the label exists at all, and reachability. The card
// uses these to distinguish "0 matching stacks" from "label exists but no
// stacks assigned" from "remote unavailable".
fleetRouter.post('/labels/match-preview', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const body = req.body as { labelName?: unknown } | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }
  const { labelName } = body;
  if (typeof labelName !== 'string' || labelName.trim().length === 0) {
    res.status(400).json({ error: 'labelName is required' });
    return;
  }
  const trimmed = labelName.trim();
  try {
    const summaries = await collectFleetLabelSummaries();
    let matchedStacks = 0;
    const perNode = summaries.map((node) => {
      const entry = node.labels.find(l => l.name === trimmed);
      const stackNames = entry?.stackNames ?? [];
      matchedStacks += stackNames.length;
      return {
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        reachable: node.reachable,
        labelExists: !!entry,
        stackCount: stackNames.length,
        stackNames,
        ...(node.error ? { error: node.error } : {}),
      };
    });
    const matchedNodes = perNode.filter(n => n.stackCount > 0).length;
    const unreachableNodes = perNode.filter(n => !n.reachable).length;
    res.json({ matchedNodes, matchedStacks, unreachableNodes, perNode });
  } catch (error) {
    console.error('[Fleet] match-preview error:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to compute match preview') });
  }
});

// Stack-label suggestions for the Stop-by-label target picker. Fans out to every
// node authoritatively (local DB + live remote reads via collectFleetLabelSummaries)
// and aggregates the per-node stack labels into one name-keyed list with node and
// stack counts plus the carrying node names. Node labels (the separate
// `/api/node-labels` namespace) are deliberately never folded in, because
// fleet-stop targets stack labels only; the `scope: 'stack'` tag makes that
// explicit. Labels with zero matching stacks fleet-wide are dropped (stopping
// them is a no-op). `unreachableNodes`/`partial` tell the card the counts cover
// only the nodes it could reach.
fleetRouter.get('/labels/suggestions', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const summaries = await collectFleetLabelSummaries();
    const agg = new Map<string, { nodeCount: number; stackCount: number; nodes: string[] }>();
    for (const node of summaries) {
      for (const label of node.labels) {
        const entry = agg.get(label.name) ?? { nodeCount: 0, stackCount: 0, nodes: [] };
        entry.nodeCount += 1;
        entry.stackCount += label.stackNames.length;
        entry.nodes.push(node.nodeName);
        agg.set(label.name, entry);
      }
    }
    const suggestions = Array.from(agg.entries())
      .filter(([, counts]) => counts.stackCount > 0)
      .map(([name, counts]) => ({ name, scope: 'stack' as const, nodeCount: counts.nodeCount, stackCount: counts.stackCount, nodes: counts.nodes }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const unreachableNodes = summaries.filter(n => !n.reachable).length;
    res.json({ suggestions, unreachableNodes, partial: unreachableNodes > 0 });
  } catch (error) {
    console.error('[Fleet] label-suggestions error:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to load stack-label suggestions') });
  }
});

// Fleet-wide prune size estimate. Local node uses the controller estimate
// helper; remote nodes hit `/api/system/prune/estimate` per target. Same
// fan-out shape as `/labels/fleet-prune` minus the locks (estimation is read
// only).
fleetRouter.post('/prune/estimate', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const body = req.body as { targets?: unknown; scope?: unknown } | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }
  const rawTargets = Array.isArray(body.targets) ? body.targets : null;
  if (!rawTargets || rawTargets.length === 0) {
    res.status(400).json({ error: 'targets must be a non-empty array' });
    return;
  }
  const dedup = new Set<FleetPruneTarget>();
  for (const t of rawTargets) {
    if (typeof t !== 'string' || !(FLEET_PRUNE_TARGETS as readonly string[]).includes(t)) {
      res.status(400).json({ error: `Invalid target: ${typeof t === 'string' ? t : typeof t}` });
      return;
    }
    dedup.add(t as FleetPruneTarget);
  }
  const targets: FleetPruneTarget[] = Array.from(dedup);
  const scope: 'managed' | 'all' = body.scope === 'all' ? 'all' : 'managed';

  type NodeEstimate = {
    nodeId: number; nodeName: string; reclaimableBytes: number; reachable: boolean; error?: string;
  };

  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    const perNode: NodeEstimate[] = await Promise.all(nodes.map(async (node): Promise<NodeEstimate> => {
      if (node.type === 'local') {
        try {
          const knownStacks = scope === 'managed' ? await FileSystemService.getInstance(node.id).getStacks() : [];
          const dockerController = DockerController.getInstance(node.id);
          let nodeBytes = 0;
          for (const target of targets) {
            // estimateSystemReclaim hits `docker system df`; bound it so a
            // slow local daemon doesn't hang the fleet estimate (F-6).
            const result = scope === 'managed'
              ? await dockerController.estimateManagedReclaim(target, knownStacks)
              : await withTimeout(
                  dockerController.estimateSystemReclaim(target, knownStacks),
                  FLEET_DF_TIMEOUT_MS,
                  'docker disk usage',
                );
            nodeBytes += result.reclaimableBytes;
          }
          return { nodeId: node.id, nodeName: node.name, reclaimableBytes: nodeBytes, reachable: true };
        } catch (err) {
          const error = err instanceof TimeoutError
            ? 'Docker daemon is busy. Please try again in a moment.'
            : getErrorMessage(err, 'Failed to estimate locally');
          return {
            nodeId: node.id, nodeName: node.name, reclaimableBytes: 0, reachable: false, error,
          };
        }
      }

      const proxyTarget = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!proxyTarget) {
        return {
          nodeId: node.id, nodeName: node.name, reclaimableBytes: 0, reachable: false,
          error: formatNoTargetError(node),
        };
      }
      const baseUrl = proxyTarget.apiUrl.replace(/\/$/, '');
      const estimateHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (proxyTarget.apiToken) estimateHeaders.Authorization = `Bearer ${proxyTarget.apiToken}`;
      // Estimate is a live readout; fan out the per-target fetches in parallel
      // so wall time matches the slowest single call rather than the sum.
      // (The destructive sibling stays serial because Docker prune is internally
      // serialized and one failure should short-circuit later targets there.)
      const perTarget = await Promise.all(targets.map(async (target): Promise<{ bytes: number; error?: string }> => {
        try {
          const response = await fetch(`${baseUrl}/api/system/prune/estimate`, {
            method: 'POST',
            headers: estimateHeaders,
            body: JSON.stringify({ target, scope }),
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) {
            const errBody = (await response.json().catch(() => ({}))) as { error?: string };
            return { bytes: 0, error: errBody.error || `Remote returned ${response.status}` };
          }
          const remote = (await response.json().catch(() => null)) as { reclaimableBytes?: number } | null;
          if (!remote || typeof remote.reclaimableBytes !== 'number') {
            return { bytes: 0, error: 'Invalid response from remote node' };
          }
          return { bytes: remote.reclaimableBytes };
        } catch (err) {
          return { bytes: 0, error: getErrorMessage(err, 'Failed to reach remote node') };
        }
      }));
      const firstError = perTarget.find(t => t.error)?.error;
      if (firstError) {
        return { nodeId: node.id, nodeName: node.name, reclaimableBytes: 0, reachable: false, error: firstError };
      }
      const nodeBytes = perTarget.reduce((sum, t) => sum + t.bytes, 0);
      return { nodeId: node.id, nodeName: node.name, reclaimableBytes: nodeBytes, reachable: true };
    }));

    const totalBytes = perNode.reduce((acc, n) => acc + (n.reachable ? n.reclaimableBytes : 0), 0);
    res.json({ totalBytes, perNode });
  } catch (error) {
    console.error('[Fleet] prune-estimate error:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to compute prune estimate') });
  }
});

// ─── Fleet Snapshots (manual and scheduled: every tier) ───

fleetRouter.post('/snapshots', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  try {
    const { description = '' } = req.body;
    if (typeof description === 'string' && description.length > 500) {
      res.status(400).json({ error: 'Description must be 500 characters or less' });
      return;
    }
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    const username = req.user?.username || 'admin';
    const captureDocs = db.getGlobalSettings().snapshot_documentation === '1';

    const captureStart = Date.now();
    const results = await Promise.allSettled(
      nodes.map(async (node) => {
        if (node.type === 'remote') {
          return captureRemoteNodeFiles(node, captureDocs);
        }
        return captureLocalNodeFiles(node, captureDocs);
      }),
    );

    const capturedNodes: SnapshotNodeData[] = [];
    const skippedNodes: Array<{ nodeId: number; nodeName: string; reason: string }> = [];

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        capturedNodes.push(result.value);
      } else {
        console.error(`[Fleet Snapshot] Failed to capture node ${nodes[i].name}:`, result.reason);
        skippedNodes.push({
          nodeId: nodes[i].id,
          nodeName: nodes[i].name,
          reason: result.reason instanceof Error ? result.reason.message : 'Unknown error',
        });
      }
    });

    let totalStacks = 0;
    const allFiles: Array<{ nodeId: number; nodeName: string; stackName: string; filename: string; content: string }> = [];
    const skippedStacks: Array<{ nodeId: number; nodeName: string; stackName: string; reason: string }> = [];

    for (const nodeData of capturedNodes) {
      totalStacks += nodeData.stacks.length;
      for (const stack of nodeData.stacks) {
        for (const file of stack.files) {
          allFiles.push({
            nodeId: nodeData.nodeId,
            nodeName: nodeData.nodeName,
            stackName: stack.stackName,
            filename: file.filename,
            content: file.content,
          });
        }
      }
      for (const warning of nodeData.warnings) {
        skippedStacks.push({
          nodeId: nodeData.nodeId,
          nodeName: nodeData.nodeName,
          stackName: warning.stackName,
          reason: warning.reason,
        });
      }
    }

    const documentation = captureDocs
      ? buildSnapshotDocumentation(capturedNodes, new Date().toISOString())
      : null;

    const snapshotId = db.createSnapshot(
      description,
      username,
      capturedNodes.length,
      totalStacks,
      JSON.stringify(skippedNodes),
      JSON.stringify(skippedStacks),
      documentation ? JSON.stringify(documentation) : '',
    );

    if (allFiles.length > 0) {
      db.insertSnapshotFiles(snapshotId, allFiles);
    }

    const cloudSvc = CloudBackupService.getInstance();
    if (cloudSvc.isEnabled() && cloudSvc.isAutoUploadOn()) {
      void cloudSvc.uploadSnapshot(snapshotId)
        .then(() => console.log(`[Fleet Snapshot] Cloud auto-upload OK for snapshot ${snapshotId}`))
        .catch(uploadErr => {
          const message = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          console.error('[Fleet Snapshot] Cloud upload failed:', message);
          void NotificationService.getInstance()
            .dispatchAlert('error', 'system', `Cloud backup upload failed for snapshot ${snapshotId}: ${message}`)
            .catch(() => { /* notification dispatch is best-effort */ });
        });
    }

    if (skippedNodes.length > 0 || skippedStacks.length > 0) {
      console.warn(`[Fleet] Snapshot ${snapshotId} partial: ${capturedNodes.length} node(s), ${totalStacks} stack(s); skipped ${skippedNodes.length} node(s), ${skippedStacks.length} stack(s)`);
    } else {
      console.log('[Fleet] Snapshot created:', capturedNodes.length, 'nodes,', totalStacks, 'stacks');
    }
    if (isDebugEnabled()) {
      console.debug(`[Fleet:debug] Snapshot ${snapshotId} capture completed in ${Date.now() - captureStart}ms, ${allFiles.length} file(s) stored`);
      for (const skip of skippedNodes) {
        console.debug(`[Fleet:debug] Skipped node "${skip.nodeName}" (id=${skip.nodeId}): ${skip.reason}`);
      }
      for (const skip of skippedStacks) {
        console.debug(`[Fleet:debug] Skipped stack "${skip.stackName}" on "${skip.nodeName}" (id=${skip.nodeId}): ${skip.reason}`);
      }
    }
    const snapshot = db.getSnapshot(snapshotId);
    res.status(201).json(snapshot);
  } catch (error) {
    console.error('[Fleet Snapshot] Create error:', error);
    res.status(500).json({ error: 'Failed to create fleet snapshot' });
  }
});

fleetRouter.get('/snapshots', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const db = DatabaseService.getInstance();
    const snapshots = db.getSnapshots(limit, offset);
    const total = db.getSnapshotCount();
    if (isDebugEnabled()) console.debug('[Fleet:debug] Snapshots list: limit=', limit, 'offset=', offset, 'total=', total);
    res.json({ snapshots, total });
  } catch (error) {
    console.error('[Fleet Snapshot] List error:', error);
    res.status(500).json({ error: 'Failed to list fleet snapshots' });
  }
});

// Registered before /snapshots/:id so "coverage" is never parsed as an id.
// Hub-local by design: snapshot rows exist only in the hub database, so the
// readiness UI fetches this with localOnly and merges it client-side.
fleetRouter.get('/snapshots/coverage', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  try {
    // Strict digits only: parseInt would accept '1abc' as 1.
    const nodeIdRaw = typeof req.query.nodeId === 'string' ? req.query.nodeId : '';
    const stackName = req.query.stackName as string;
    if (!/^\d+$/.test(nodeIdRaw)) {
      res.status(400).json({ error: 'nodeId must be a non-negative integer' });
      return;
    }
    const nodeId = parseInt(nodeIdRaw, 10);
    if (typeof stackName !== 'string' || !isValidStackName(stackName)) {
      res.status(400).json({ error: 'Invalid stack name' });
      return;
    }
    const latestAt = DatabaseService.getInstance().getLatestSnapshotTimestampFor(nodeId, stackName);
    res.json({ latestAt });
  } catch (error) {
    console.error('[Fleet Snapshot] Coverage lookup error:', error);
    res.status(500).json({ error: 'Failed to look up snapshot coverage' });
  }
});

fleetRouter.get('/snapshots/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  try {
    const id = parseIntParam(req, res, 'id', 'snapshot ID');
    if (id === null) return;
    const db = DatabaseService.getInstance();
    const snapshot = db.getSnapshot(id);
    if (!snapshot) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }

    const files = db.getSnapshotFiles(id);

    // Group files by node and stack.
    const nodesMap = new Map<number, { nodeId: number; nodeName: string; stacks: Map<string, Array<{ filename: string; content: string }>> }>();
    for (const file of files) {
      if (!nodesMap.has(file.node_id)) {
        nodesMap.set(file.node_id, { nodeId: file.node_id, nodeName: file.node_name, stacks: new Map() });
      }
      const nodeEntry = nodesMap.get(file.node_id)!;
      if (!nodeEntry.stacks.has(file.stack_name)) {
        nodeEntry.stacks.set(file.stack_name, []);
      }
      nodeEntry.stacks.get(file.stack_name)!.push({ filename: file.filename, content: file.content });
    }

    const nodes = Array.from(nodesMap.values()).map(n => ({
      nodeId: n.nodeId,
      nodeName: n.nodeName,
      stacks: Array.from(n.stacks.entries()).map(([stackName, stackFiles]) => ({
        stackName,
        files: stackFiles,
      })),
    }));

    // Surface the captured dossier metadata when present so the detail view can
    // render notes and offer to restore them. The list payload stays lean (only
    // the has_documentation flag); the blob is decrypted here on demand.
    let documentation: SnapshotDocumentation | undefined;
    if (snapshot.has_documentation) {
      const raw = db.getSnapshotDocumentation(id);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as SnapshotDocumentation;
          // Re-project each dossier through pickDossierFields so the client
          // receives the same shape restore writes back, and never any field
          // outside the eleven operator notes.
          documentation = {
            ...parsed,
            stacks: parsed.stacks.map(s => ({ ...s, dossier: pickDossierFields(s.dossier) })),
          };
        } catch (e) {
          console.error(`[Fleet Snapshot] Failed to parse documentation for snapshot ${id}:`, getErrorMessage(e, 'parse error'));
        }
      }
    }

    if (isDebugEnabled()) console.debug('[Fleet:debug] Snapshot detail:', id, files.length, 'files');
    res.json({ ...snapshot, nodes, documentation });
  } catch (error) {
    console.error('[Fleet Snapshot] Detail error:', error);
    res.status(500).json({ error: 'Failed to fetch snapshot details' });
  }
});

// Raised when a remote target node has no reachable proxy address. The
// single-stack restore route maps it to a 503; restore-all records it as a
// per-stack failure instead.
class SnapshotProxyTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotProxyTargetError';
  }
}

interface RemoteProxyContext {
  baseUrl: string;
  headers: Record<string, string>;
}

// Builds an error from a failed remote response so the thrown message names the
// remote node's actual reason (policy block, validation, write error) instead
// of a generic string. The body is truncated to keep the recorded message bounded.
async function remoteStackError(action: string, res: Awaited<ReturnType<typeof fetch>>): Promise<Error> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300).trim();
  } catch {
    // Remote body unavailable; the status code alone still names the failure.
  }
  return new Error(`${action} on remote node (${res.status})${detail ? `: ${detail}` : ''}`);
}

// Builds the base URL + proxy headers for a remote node, or null when the node
// has no reachable target. The tier header describes the central instance and
// stays unconditional; the Bearer header is gated on a non-empty token because
// pilot-loopback dispatch carries auth via the tunnel.
function buildRemoteProxyContext(node: Node): RemoteProxyContext | null {
  const proxyTarget = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!proxyTarget) return null;
  const proxyHeaders = LicenseService.getInstance().getProxyHeaders();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [PROXY_TIER_HEADER]: proxyHeaders.tier,
  };
  if (proxyTarget.apiToken) headers.Authorization = `Bearer ${proxyTarget.apiToken}`;
  return { baseUrl: proxyTarget.apiUrl.replace(/\/$/, ''), headers };
}

// Writes a snapshot stack's files back to its node: local nodes write to disk
// (backing up any current files first), remote nodes receive them over the
// proxy. Throws SnapshotProxyTargetError when a remote node is unreachable, and
// an Error carrying the remote node's status and reason on a failed remote write.
async function applySnapshotStackFiles(
  node: Node,
  stackName: string,
  files: Array<{ filename: string; content: string }>,
): Promise<void> {
  if (node.type === 'local') {
    const fsService = FileSystemService.getInstance(node.id);
    try {
      await fsService.backupStackFiles(stackName);
    } catch (e) {
      // Stack may not exist yet before first restore; that is ok.
      console.warn(`[Fleet Snapshot] Pre-restore backup failed for stack "${stackName}" (may not exist yet):`, getErrorMessage(e, 'unknown'));
    }
    for (const file of files) {
      if (file.filename === 'compose.yaml') {
        await fsService.saveStackContent(stackName, file.content);
      } else if (file.filename === '.env') {
        await fsService.saveEnvContent(stackName, file.content);
      }
    }
    return;
  }

  const ctx = buildRemoteProxyContext(node);
  if (!ctx) throw new SnapshotProxyTargetError(formatNoTargetError(node));
  for (const file of files) {
    if (file.filename === 'compose.yaml') {
      const putRes = await fetch(`${ctx.baseUrl}/api/stacks/${encodeURIComponent(stackName)}`, {
        method: 'PUT',
        headers: ctx.headers,
        body: JSON.stringify({ content: file.content }),
        signal: AbortSignal.timeout(15000),
      });
      if (!putRes.ok) throw await remoteStackError('Failed to restore compose file', putRes);
    } else if (file.filename === '.env') {
      const putRes = await fetch(`${ctx.baseUrl}/api/stacks/${encodeURIComponent(stackName)}/env`, {
        method: 'PUT',
        headers: ctx.headers,
        body: JSON.stringify({ content: file.content }),
        signal: AbortSignal.timeout(15000),
      });
      if (!putRes.ok) throw await remoteStackError('Failed to restore env file', putRes);
    }
  }
}

// Redeploys a stack after its files are restored. The deploy policy gate stays
// with the caller (local deploys gate centrally; remote deploys are gated by
// the remote node), so this only performs the deploy itself.
async function redeploySnapshotStack(node: Node, stackName: string): Promise<void> {
  if (node.type === 'local') {
    const lock = await StackOpLockService.getInstance().runExclusive(
      node.id, stackName, 'deploy', 'system',
      () => ComposeService.getInstance(node.id).deployStack(stackName),
    );
    if (!lock.ran) {
      throw new Error(`Cannot redeploy "${stackName}": another operation (${lock.existing.action}) is already in progress.`);
    }
    return;
  }
  const ctx = buildRemoteProxyContext(node);
  if (!ctx) throw new SnapshotProxyTargetError(formatNoTargetError(node));
  const deployRes = await fetch(`${ctx.baseUrl}/api/stacks/${encodeURIComponent(stackName)}/deploy`, {
    method: 'POST',
    headers: ctx.headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!deployRes.ok) throw await remoteStackError('Failed to redeploy stack', deployRes);
}

// Looks up the dossier notes a snapshot preserved for one stack, or undefined
// when no usable dossier entry exists for that stack (no documentation, an
// unparseable blob, or no matching entry).
function findSnapshotDossier(snapshotId: number, nodeId: number, stackName: string): StackDossierFields | undefined {
  const raw = DatabaseService.getInstance().getSnapshotDocumentation(snapshotId);
  if (!raw) return undefined;
  let doc: SnapshotDocumentation;
  try {
    doc = JSON.parse(raw) as SnapshotDocumentation;
  } catch (e) {
    console.error(`[Fleet Snapshot] Failed to parse documentation for snapshot ${snapshotId}:`, getErrorMessage(e, 'parse error'));
    return undefined;
  }
  // Guard against a malformed-but-parseable blob: `stacks` must be an array, and
  // only restore notes that actually carry content, so a blank or tampered entry
  // can never silently clobber the operator's current notes with empty fields.
  if (!Array.isArray(doc.stacks)) return undefined;
  const entry = doc.stacks.find(s => s?.nodeId === nodeId && s?.stackName === stackName);
  if (!entry) return undefined;
  const fields = pickDossierFields(entry.dossier);
  return dossierHasContent(fields) ? fields : undefined;
}

// Writes captured dossier notes back to a stack: local nodes upsert into the
// DB, remote nodes receive them over the proxy. Only ever called when the
// operator explicitly opted in to restoring notes.
async function restoreSnapshotStackDossier(node: Node, stackName: string, fields: StackDossierFields): Promise<void> {
  if (node.type === 'local') {
    DatabaseService.getInstance().upsertStackDossier(node.id, stackName, fields);
    return;
  }
  const ctx = buildRemoteProxyContext(node);
  if (!ctx) throw new SnapshotProxyTargetError(formatNoTargetError(node));
  const putRes = await fetch(`${ctx.baseUrl}/api/stacks/${encodeURIComponent(stackName)}/dossier`, {
    method: 'PUT',
    headers: ctx.headers,
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(15000),
  });
  if (!putRes.ok) throw await remoteStackError('Failed to restore dossier notes', putRes);
}

fleetRouter.post('/snapshots/:id/restore', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  try {
    const snapshotId = parseIntParam(req, res, 'id', 'snapshot ID');
    if (snapshotId === null) return;
    const { nodeId, stackName, redeploy = false } = req.body;
    // Strict boolean: only an explicit `true` opts in, so a stray `"false"` or
    // truthy value can never trigger an overwrite of the operator's notes.
    const restoreNotes: boolean = req.body?.restoreNotes === true;

    if (!nodeId || !stackName) {
      res.status(400).json({ error: 'nodeId and stackName are required' });
      return;
    }
    if (!isValidStackName(stackName)) {
      res.status(400).json({ error: 'Invalid stack name' });
      return;
    }

    const db = DatabaseService.getInstance();
    const snapshot = db.getSnapshot(snapshotId);
    if (!snapshot) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }

    const files = db.getSnapshotStackFiles(snapshotId, nodeId, stackName);
    if (files.length === 0) {
      res.status(404).json({ error: 'No files found for this stack in the snapshot' });
      return;
    }

    if (isDebugEnabled()) {
      const fileNames = files.map(f => f.filename).join(', ');
      console.debug('[Fleet:debug] Restore: snapshot=%s, node=%s, stack="%s", files=[%s], redeploy=%s', sanitizeForLog(snapshotId), sanitizeForLog(nodeId), sanitizeForLog(stackName), sanitizeForLog(fileNames), sanitizeForLog(redeploy));
    }

    const node = db.getNode(nodeId);
    if (!node) {
      res.status(404).json({ error: 'Target node no longer exists' });
      return;
    }

    await applySnapshotStackFiles(node, stackName, files);

    // Dossier notes are restored only on explicit opt-in, so a routine file
    // restore never clobbers the operator's current notes. The note write is
    // best-effort relative to the file restore: the files are already on disk,
    // so a notes failure (e.g. a remote dossier PUT) is reported, not fatal.
    let notesRestored = false;
    let notesError: string | undefined;
    if (restoreNotes) {
      const fields = findSnapshotDossier(snapshotId, nodeId, stackName);
      if (fields) {
        try {
          await restoreSnapshotStackDossier(node, stackName, fields);
          notesRestored = true;
        } catch (e) {
          notesError = getErrorMessage(e, 'Failed to restore documentation notes');
          console.error(`[Fleet Snapshot] Note restore failed for stack "${sanitizeForLog(stackName)}":`, notesError);
        }
      }
    }

    if (redeploy) {
      // Local deploys are gated centrally here; remote deploys are gated by the
      // remote node's own deploy endpoint.
      if (node.type === 'local' && !(await runPolicyGate(req, res, stackName, node.id))) return;
      await redeploySnapshotStack(node, stackName);
    }

    console.log('[Fleet] Snapshot restore: snapshot=%s node=%s stack=%s', snapshotId, sanitizeForLog(nodeId), sanitizeForLog(stackName));
    res.json({ message: 'Stack restored successfully', redeployed: redeploy, notesRestored, notesError });
  } catch (error) {
    if (error instanceof SnapshotProxyTargetError) {
      res.status(503).json({ error: error.message });
      return;
    }
    console.error('[Fleet Snapshot] Restore error:', error);
    res.status(500).json({ error: 'Failed to restore stack from snapshot' });
  }
});

// One row per (node, stack) in a restore-all run. A failed row carries the
// reason in `error`; a succeeded row reports whether it was also redeployed.
interface SnapshotRestoreResult {
  nodeId: number;
  nodeName: string;
  stackName: string;
  success: boolean;
  redeployed: boolean;
  notesRestored: boolean;
  error?: string;
  /** A non-fatal documentation-notes restore failure; files still restored. */
  notesError?: string;
}

fleetRouter.post('/snapshots/:id/restore-all', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  try {
    const snapshotId = parseIntParam(req, res, 'id', 'snapshot ID');
    if (snapshotId === null) return;
    const redeploy: boolean = req.body?.redeploy === true;
    const restoreNotes: boolean = req.body?.restoreNotes === true;

    const db = DatabaseService.getInstance();
    const snapshot = db.getSnapshot(snapshotId);
    if (!snapshot) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }

    const files = db.getSnapshotFiles(snapshotId);
    if (files.length === 0) {
      res.status(404).json({ error: 'Snapshot has no files to restore' });
      return;
    }

    // Group the snapshot's files by node + stack, mirroring the detail route.
    const groups = new Map<string, { nodeId: number; nodeName: string; stackName: string; files: Array<{ filename: string; content: string }> }>();
    for (const file of files) {
      const key = `${file.node_id}:${file.stack_name}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { nodeId: file.node_id, nodeName: file.node_name, stackName: file.stack_name, files: [] };
        groups.set(key, entry);
      }
      entry.files.push({ filename: file.filename, content: file.content });
    }

    const policyOptions = buildPolicyGateOptions(req);
    const results: SnapshotRestoreResult[] = [];

    // Restore every stack independently: one stack failing (unreachable node,
    // blocked deploy, write error) is recorded and the rest still proceed.
    for (const group of groups.values()) {
      try {
        if (!isValidStackName(group.stackName)) throw new Error('Invalid stack name');
        const node = db.getNode(group.nodeId);
        if (!node) throw new Error('Target node no longer exists');

        await applySnapshotStackFiles(node, group.stackName, group.files);

        // Files are restored; a notes failure is recorded but does not fail the
        // stack (and must not block the redeploy below).
        let notesRestored = false;
        let notesError: string | undefined;
        if (restoreNotes) {
          const fields = findSnapshotDossier(snapshotId, group.nodeId, group.stackName);
          if (fields) {
            try {
              await restoreSnapshotStackDossier(node, group.stackName, fields);
              notesRestored = true;
            } catch (e) {
              notesError = getErrorMessage(e, 'Failed to restore documentation notes');
              console.error(`[Fleet Snapshot] Note restore failed for stack "${sanitizeForLog(group.stackName)}":`, notesError);
            }
          }
        }

        let redeployed = false;
        if (redeploy) {
          if (node.type === 'local') await assertPolicyGateAllows(group.stackName, node.id, policyOptions);
          await redeploySnapshotStack(node, group.stackName);
          redeployed = true;
        }
        results.push({ nodeId: group.nodeId, nodeName: group.nodeName, stackName: group.stackName, success: true, redeployed, notesRestored, notesError });
      } catch (e) {
        results.push({ nodeId: group.nodeId, nodeName: group.nodeName, stackName: group.stackName, success: false, redeployed: false, notesRestored: false, error: getErrorMessage(e, 'Restore failed') });
      }
    }

    const restored = results.filter(r => r.success).length;
    const failed = results.length - restored;
    console.log('[Fleet] Snapshot restore-all: snapshot=%s restored=%s failed=%s redeploy=%s', snapshotId, restored, failed, redeploy);
    res.json({ restored, failed, redeploy, results });
  } catch (error) {
    console.error('[Fleet Snapshot] Restore-all error:', error);
    res.status(500).json({ error: 'Failed to restore snapshot' });
  }
});

fleetRouter.delete('/snapshots/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  try {
    const id = parseIntParam(req, res, 'id', 'snapshot ID');
    if (id === null) return;
    const db = DatabaseService.getInstance();
    const snapshot = db.getSnapshot(id);
    if (!snapshot) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }
    if (isDebugEnabled()) {
      console.debug(`[Fleet:debug] Deleting snapshot ${id} (${snapshot.node_count} node(s), ${snapshot.stack_count} stack(s))`);
    }
    db.deleteSnapshot(id);
    console.log('[Fleet] Snapshot deleted:', id);
    res.json({ message: 'Snapshot deleted' });
  } catch (error) {
    console.error('[Fleet Snapshot] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete snapshot' });
  }
});

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
import { getHostMemory, memoryToWire, type MemoryWire } from '../helpers/hostMemory';
import { FileSystemService } from '../services/FileSystemService';
import { ComposeService } from '../services/ComposeService';
import { StackOpLockService } from '../services/StackOpLockService';
import SelfUpdateService, { type PinInfo } from '../services/SelfUpdateService';
import { getSenchoVersion, isValidVersion } from '../services/CapabilityRegistry';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireNodeProxy, requireUserSession } from '../middleware/tierGates';
import { checkPermission, requirePermission } from '../middleware/permissions';
import { respondSelfUpdatePreflight } from './license';
import { ImageOperationService } from '../services/ImageOperationService';
import { classifyImageChannel } from '../helpers/imageChannel';
import { runPolicyGate, assertPolicyGateAllows, buildPolicyGateOptions } from '../helpers/policyGate';
import { remoteSupportsCrossNodeRbac } from '../helpers/remoteCapabilities';
import { captureLocalNodeFiles, captureRemoteNodeFiles, buildSnapshotDocumentation, pickDossierFields, dossierHasContent, FLEET_SNAPSHOT_APPLY_TIMEOUT_MS, type SnapshotNodeData, type SnapshotDocumentation } from '../utils/snapshot-capture';
import { getLatestVersion, getLatestRelease } from '../utils/version-check';
import { isValidStackName } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { validateStackPatternForRedos } from '../helpers/stackPattern';

export { validateStackPatternForRedos } from '../helpers/stackPattern';
import { getErrorMessage } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { parseRequestedTargetVersion, pickCompareTarget } from '../utils/targetVersion';
import { buildTargetImageRef, isRepinBlocked, type ImagePinKind } from '../helpers/selfUpdateCompose';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import { foldNodeEstimate, type FleetEstimateTargetResult, type FleetNodeEstimate } from '../helpers/fleetEstimate';

// Mirror the system-maintenance route timeout so fleet's local-node prune
// paths cap the slow `docker system df` call at the same 12 s budget (F-6).
const FLEET_DF_TIMEOUT_MS = 12_000;
import { POLICY_SEVERITIES } from '../utils/severity';
import { isNoOpBlockingPolicy } from '../utils/policy-risk';
import { sanitizeForLog, redactSensitiveText } from '../utils/safeLog';
import { formatNoTargetError } from '../utils/remoteTarget';
import {
  applyFleetSnapshotFiles,
  fleetSnapshotApplyConflictCode,
  selectFleetSnapshotApplyFiles,
} from '../helpers/applyFleetSnapshotFiles';
import { CloudBackupService } from '../services/CloudBackupService';
import { NotificationService } from '../services/NotificationService';
import { invalidateRemoteMetaCache } from '../helpers/cacheInvalidation';
import { activeBulkActions } from './labels';
import {
  FLEET_PRUNE_TARGETS,
  parseFleetPruneRequest,
  runFleetPrune,
  type FleetPruneTarget,
} from '../helpers/fleetPrune';
import { runLocalLabelStop, isLabelLocalStopResponse, type StackStopResult } from '../helpers/fleetLabelStop';
import { collectFleetLabelSummaries } from '../helpers/fleetLabelSummary';
import { runLocalLabelAssign, validateLabelTemplate, validateRemoteAssignResults, failAllAssign, type AssignNodeResult } from '../helpers/fleetLabelAssign';
import { MAX_ASSIGNMENTS } from '../helpers/constants';
import { buildLocalConfigurationStatus, type ConfigurationStatus } from './dashboard';
import { normalizeRemoteConfigurationStatus } from '../helpers/configurationStatus';
import { buildLocalGraph, mergeFleetGraph, isLocalDependencyGraph, type FleetNodeGraphResult } from '../services/DependencyGraphService';
import { buildNodeLabelInventory, VALID_LABEL_SOURCES, type NodeLabelInventory } from '../services/LabelInventoryService';
import { labelInventoryOptionsFromRequest, requireRevealAdmin } from '../helpers/labelInventoryRequest';
import { PROXY_TIER_HEADER, deployProvenanceHeaders } from '../services/license-headers';
import { LicenseService } from '../services/LicenseService';

const updateTracker = FleetUpdateTrackerService.getInstance();
/** Sync lock for remote reapply while meta is fetched (before the pollable tracker exists). */
const remoteReapplyDispatching = new Set<number>();
const EARLY_FAIL_MS = 180 * 1000; // 3 minutes before declaring a probable pull failure
// Shown in the Node Updates UI when a node's image is pinned in a way Fleet
// cannot repin (digest or an unresolved value). Node-neutral so it reads the
// same for the local node and a remote row.
const REPIN_BLOCKED_REASON =
  'This node pins its Sencho image to a digest or a value Fleet cannot resolve, so it cannot update automatically. Change the image tag in its compose file, then update.';

const EMPTY_PIN_STATUS = {
  imagePinKind: null,
  composeImageRef: null,
  targetImageRef: null,
  updateBlocked: false,
  updateBlockedReason: null,
  imageChannel: null,
} as const;

function localPinStatusFields(
  pin: PinInfo,
  compareVersion: string | null,
  compareValid: boolean,
  blockedReason: string,
) {
  const updateBlocked = isRepinBlocked(pin.pinKind);
  const compareTarget = pickCompareTarget(compareVersion, compareValid);
  return {
    imagePinKind: pin.pinKind,
    composeImageRef: pin.composeImageRef,
    targetImageRef:
      pin.pinKind === 'semver' && compareTarget
        ? buildTargetImageRef(pin.composeImageRef, compareTarget)
        : null,
    updateBlocked,
    updateBlockedReason: updateBlocked ? blockedReason : null,
    imageChannel: classifyImageChannel(pin.composeImageRef),
  };
}
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
  // Risk inputs are optional for back-compat: a legacy control omits them and
  // the receiver defaults such rows to severity-only. Reject only bad values.
  if (r.block_on_severity !== undefined && !isIntFlag(r.block_on_severity)) return 'block_on_severity must be 0 or 1';
  if (r.block_on_kev !== undefined && !isIntFlag(r.block_on_kev)) return 'block_on_kev must be 0 or 1';
  if (r.block_on_fixable !== undefined && !isIntFlag(r.block_on_fixable)) return 'block_on_fixable must be 0 or 1';
  // Cross-field invariant at the trust boundary: a replicated blocking policy
  // must have at least one active input, or it would persist as a silent no-op
  // gate. Absent fields default to severity-only (same as the receiver apply).
  const sev = r.block_on_severity === undefined ? 1 : (r.block_on_severity as number);
  const kev = r.block_on_kev === undefined ? 0 : (r.block_on_kev as number);
  const fix = r.block_on_fixable === undefined ? 0 : (r.block_on_fixable as number);
  if (isNoOpBlockingPolicy(r.block_on_deploy, sev, kev, fix)) {
    return 'a blocking policy must enable at least one of severity, KEV, or fixable';
  }
  return null;
}

/**
 * Reject `stack_pattern` inputs that would compile to a backtracking-prone
 * regex. Implementation lives in helpers/stackPattern.ts (re-exported above).
 */

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
    memory: MemoryWire;
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

async function resolveUpdateTarget(requested?: string): Promise<string | undefined> {
  if (requested !== undefined) return requested;
  const { compareVersion, compareValid } = await getCompareTarget(getSenchoVersion());
  return pickCompareTarget(compareVersion, compareValid);
}

async function fetchLocalNodeOverview(node: Node): Promise<FleetNodeOverview> {
  try {
    const composeDir = path.resolve(NodeRegistry.getInstance().getComposeDir(node.id));
    const [allContainers, stacks, currentLoad, hostMem, fsSize] = await Promise.all([
      DockerController.getInstance(node.id).getAllContainers(),
      FileSystemService.getInstance(node.id).getStacks(),
      si.currentLoad(),
      getHostMemory(),
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
        // ARC/balloon aware: reclaimable ARC is added back into available,
        // and ballooned memory is subtracted from used. See helpers/hostMemory.ts.
        memory: memoryToWire(hostMem),
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
      memory: MemoryWire;
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
  res.json(DatabaseService.getInstance().getFleetSyncStatuses());
});

fleetRouter.get('/overview', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
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
  if (!requirePermission(req, res, 'node:read')) return;
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
            configuration: await buildLocalConfigurationStatus(node.id, userId, localTier),
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
          const raw = resp.ok ? (await resp.json() as ConfigurationStatus) : null;
          const configuration = raw ? normalizeRemoteConfigurationStatus(raw) : null;
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
fleetRouter.get('/dependency-map', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
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

interface FleetNodeLabelInventoryResult {
  nodeId: number;
  nodeName: string;
  status: 'ok' | 'error';
  inventory: NodeLabelInventory | null;
  error: string | null;
}

function isStringOrNull(v: unknown): boolean {
  return typeof v === 'string' || v === null;
}

function isLabelIndexContainerRef(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.name === 'string'
    && isStringOrNull(o.stack)
    && isStringOrNull(o.service);
}

function isLabelValue(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.key === 'string'
    && typeof o.value === 'string'
    && typeof o.source === 'string'
    && VALID_LABEL_SOURCES.has(o.source);
}

function isContainerLabelRow(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.name === 'string'
    && typeof o.state === 'string'
    && isStringOrNull(o.stack)
    && isStringOrNull(o.service)
    && Array.isArray(o.labels)
    && o.labels.every(isLabelValue);
}

function isLabelIndexRow(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.key === 'string'
    && typeof o.value === 'string'
    && typeof o.source === 'string'
    && VALID_LABEL_SOURCES.has(o.source)
    && Array.isArray(o.containers)
    && o.containers.every(isLabelIndexContainerRef);
}

/**
 * Validate a remote node's label-inventory payload deeply enough that neither the
 * aggregation sort nor the Fleet UI ever receives a malformed row. A single bad
 * `byLabel` or `containers` element would otherwise crash the whole fleet request (or
 * the client) rather than degrading that node into `nodeErrors`. Only wire fields are
 * checked; the internal `imageId` is not part of the shape sent over the wire.
 */
function isNodeLabelInventory(v: unknown): v is NodeLabelInventory {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.nodeId === 'number'
    && Array.isArray(o.containers)
    && o.containers.every(isContainerLabelRow)
    && Array.isArray(o.byLabel)
    && o.byLabel.every(isLabelIndexRow);
}

/**
 * Fleet-wide Docker label inventory. Auth + node:read (Community). Fans out to
 * each node's /api/system/container-labels; unreachable nodes degrade gracefully.
 */
fleetRouter.get('/container-labels', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  if (!requireRevealAdmin(req, res)) return;
  const options = labelInventoryOptionsFromRequest(req);
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();

    const results = await Promise.allSettled(
      nodes.map(async (node: Node): Promise<FleetNodeLabelInventoryResult> => {
        if (node.type === 'local') {
          const inventory = await buildNodeLabelInventory(node.id, options);
          return { nodeId: node.id, nodeName: node.name, status: 'ok', inventory, error: null };
        }

        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) {
          return { nodeId: node.id, nodeName: node.name, status: 'error', inventory: null, error: formatNoTargetError(node) };
        }

        const revealQs = options.revealSecrets ? '?reveal=1' : '';
        const resp = await fetch(
          `${target.apiUrl.replace(/\/$/, '')}/api/system/container-labels${revealQs}`,
          {
            headers: { ...(target.apiToken ? { Authorization: `Bearer ${target.apiToken}` } : {}) },
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!resp.ok) {
          const errBody = await resp.json().catch(() => null) as { error?: string } | null;
          return { nodeId: node.id, nodeName: node.name, status: 'error', inventory: null, error: errBody?.error ?? `Remote returned ${resp.status}` };
        }
        const inventory = await resp.json().catch(() => null);
        if (!isNodeLabelInventory(inventory)) {
          return { nodeId: node.id, nodeName: node.name, status: 'error', inventory: null, error: 'Remote returned an unexpected label-inventory payload' };
        }
        return { nodeId: node.id, nodeName: node.name, status: 'ok', inventory, error: null };
      }),
    );

    const perNode: FleetNodeLabelInventoryResult[] = results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(`[Fleet] Container labels fetch failed for node ${nodes[i].name}:`, result.reason);
      return { nodeId: nodes[i].id, nodeName: nodes[i].name, status: 'error', inventory: null, error: getErrorMessage(result.reason, 'Failed to reach node') };
    });

    const aggregatedByLabel = new Map<string, import('../services/LabelInventoryService').LabelIndexRow>();
    for (const nodeResult of perNode) {
      if (nodeResult.status !== 'ok' || !nodeResult.inventory) continue;
      for (const row of nodeResult.inventory.byLabel) {
        const key = `${row.key}\0${row.value}\0${row.source}`;
        const existing = aggregatedByLabel.get(key);
        if (!existing) {
          aggregatedByLabel.set(key, {
            ...row,
            containers: row.containers.map(c => ({
              ...c,
              nodeId: nodeResult.nodeId,
              nodeName: nodeResult.nodeName,
            })),
          });
        } else {
          existing.containers.push(...row.containers.map(c => ({
            ...c,
            nodeId: nodeResult.nodeId,
            nodeName: nodeResult.nodeName,
          })));
        }
      }
    }

    const nodeErrors: Record<number, string> = {};
    for (const n of perNode) {
      if (n.status === 'error' && n.error) nodeErrors[n.nodeId] = n.error;
    }

    res.json({
      nodes: perNode,
      aggregatedByLabel: [...aggregatedByLabel.values()].sort((a, b) =>
        a.key.localeCompare(b.key) || a.value.localeCompare(b.value) || a.source.localeCompare(b.source)),
      nodeErrors,
      generatedAt: Date.now(),
    });
  } catch (error) {
    console.error('[Fleet] Container labels error:', error);
    res.status(500).json({ error: 'Failed to build fleet container label inventory' });
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
fleetRouter.get('/networking-summary', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
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

// Read guard uses the unscoped stack:read (no resource): a fleet node view is a
// cross-node aggregate with no single control-DB stack to scope a per-stack
// assignment against, so it requires the global stack:read every shipped role
// holds. The per-stack scoped form is correct only on the local stacks router.
fleetRouter.get('/node/:nodeId/stacks', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:read')) return;
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

// Unscoped stack:read for the same reason as /node/:nodeId/stacks above: a
// fleet-routed read has no local control-DB stack resource to scope against.
fleetRouter.get('/node/:nodeId/stacks/:stackName/containers', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:read')) return;
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
  if (!requirePermission(req, res, 'node:read')) return;
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
        let remoteImagePinKind: ImagePinKind | null = null;
        let remoteUpdateBlocked = false;
        let remoteImageChannel: 'community' | 'hardened' | 'unknown' | null = null;
        let remoteCapabilities: string[] = [];
        if (node.type === 'local') {
          version = gatewayVersion;
        } else {
          const meta = await NodeRegistry.getInstance().fetchMetaForNode(node.id);
          version = meta.version;
          remoteStartedAt = meta.startedAt;
          remoteUpdateError = meta.updateError;
          remoteOnline = meta.online;
          remoteImagePinKind = meta.imagePinKind;
          remoteUpdateBlocked = meta.updateBlocked;
          remoteImageChannel = meta.imageChannel;
          remoteCapabilities = meta.capabilities ?? [];
        }

        const isReapply = tracker?.operationKind === 'reapply_configuration';
        const earlyFailMsg = isReapply
          ? (node.type === 'local'
            ? 'Local reapply did not complete. The container may not have restarted; check Docker logs on the host.'
            : 'Reapply may have failed. The node is still running and its process start time has not changed.')
          : (node.type === 'local'
            ? 'Local update did not complete. The container may not have restarted; check Docker logs on the host.'
            : 'Update may have failed. The node is still running and its version has not changed.');

        if (tracker?.status === 'updating') {
          const elapsed = Date.now() - tracker.startedAt;

          if (debug) {
            console.debug('[Fleet:debug] Polling update status for node', node.id, node.name, '- elapsed:', Math.round(elapsed / 1000) + 's', 'version:', version, 'wasOffline:', tracker.wasOffline, 'remoteOnline:', remoteOnline);
          }

          if (elapsed > UPDATE_TIMEOUT_MS) {
            if (debug) console.debug('[Fleet:debug] Node', node.id, 'timed out after', Math.round(elapsed / 1000) + 's');
            resolveTerminal(node, tracker, 'timeout', isReapply
              ? 'Node did not come back online within 5 minutes after reapply.'
              : UPDATE_TIMEOUT_MSG);
          } else if (node.type === 'remote') {
            if (remoteUpdateError) {
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'reported pull failure:', remoteUpdateError);
              resolveTerminal(node, tracker, 'failed', remoteUpdateError);
            } else if (!remoteOnline) {
              if (!tracker.wasOffline) {
                if (debug) console.debug('[Fleet:debug] Node', node.id, 'went offline (restarting)');
                updateTracker.set(node.id, { ...tracker, wasOffline: true });
              }
            } else if (!isReapply && isValidVersion(version) && version !== tracker.previousVersion) {
              // Signal 1: a valid, different version. Skipped for reapply because
              // the authored image/version is not expected to change.
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
              !isReapply &&
              elapsed > 15_000 &&
              isValidVersion(version) &&
              gatewayValid &&
              !semver.lt(version, compareVersion!)
            ) {
              // Signal 4: remote is now at or above gateway version (after
              // minimum processing time). Never used for reapply: an already
              // current node would false-complete before the helper runs.
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'completed via signal 4 (version >= compare target):', version, '>=', compareVersion);
              updateTracker.set(node.id, updateTracker.resolve(tracker, 'completed'));
            } else if (elapsed > EARLY_FAIL_MS) {
              if (debug) console.debug('[Fleet:debug] Node', node.id, 'early fail after', Math.round(elapsed / 1000) + 's - no signals detected');
              resolveTerminal(node, tracker, 'failed', earlyFailMsg);
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
              resolveTerminal(node, tracker, 'failed', earlyFailMsg);
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

        // Apply skip-version: suppress updateAvailable when the node has skipped
        // the effective compare target (which may be the gateway fallback, not
        // just the raw GitHub latest).
        const skipRow = db.getNodeUpdateSkip(node.id);
        let skipActive = false;
        let skippedVersion: string | null = null;
        if (skipRow && compareValid && skipRow.skippedVersion === compareVersion) {
          updateAvailable = false;
          skipActive = true;
          skippedVersion = skipRow.skippedVersion;
        }

        // Image-pin metadata. The local row gets full detail (this route is
        // hub-only and authenticated); remote rows get only the safe subset
        // (pinKind + blocked flag) carried on the remote's /api/meta. A full
        // remote composeImageRef would need a new authenticated remote endpoint
        // and is deliberately out of scope.
        let imagePinKind: ImagePinKind | null = null;
        let composeImageRef: string | null = null;
        let targetImageRef: string | null = null;
        let updateBlocked = false;
        let updateBlockedReason: string | null = null;
        let imageChannel: 'community' | 'hardened' | 'unknown' | null = null;
        if (node.type === 'local') {
          const pin = await SelfUpdateService.getInstance().getPinInfo();
          if (pin) {
            ({ imagePinKind, composeImageRef, targetImageRef, updateBlocked, updateBlockedReason, imageChannel } =
              localPinStatusFields(pin, compareVersion, compareValid, REPIN_BLOCKED_REASON));
          }
        } else {
          imagePinKind = remoteImagePinKind;
          updateBlocked = remoteUpdateBlocked;
          imageChannel = remoteImageChannel;
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
          skipActive,
          skippedVersion,
          imagePinKind,
          composeImageRef,
          targetImageRef,
          updateBlocked,
          updateBlockedReason,
          imageChannel,
          operationKind: currentTracker?.operationKind ?? null,
          canReapplyCompose: node.type === 'local'
            ? SelfUpdateService.getInstance().isAvailable()
            : remoteOnline && remoteCapabilities.includes('self-update'),
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
        skipActive: false,
        skippedVersion: null,
        ...EMPTY_PIN_STATUS,
        operationKind: null,
        canReapplyCompose: false,
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
// Release notes for the Changelog tab in the Node Updates sheet.
fleetRouter.get('/update-status/release-notes', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const forceRefresh = req.query.recheck === 'true';
    const release = await getLatestRelease(forceRefresh);
    res.json({
      // Bind the notes to the release they belong to so the frontend can tell
      // when the advertised latest version has moved past the loaded notes.
      version: release ? release.tag_name.replace(/^v/, '') : null,
      releaseNotes: release?.body ?? null,
      htmlUrl: release?.html_url ?? null,
    });
  } catch (error) {
    console.error('[Fleet] Release notes error:', error);
    res.status(500).json({ error: 'Failed to fetch release notes' });
  }
});


// Pilot loopback targets carry an empty apiToken because the tunnel bridge
// re-injects admin auth; sending a malformed `Bearer ` header would 401 on
// the pilot's local Express. Omit the header in that case.
//
// targetVersion is forwarded only when it is a valid semver so the remote can
// repin a semver-pinned compose to that release. It is omitted otherwise (never
// sent as null/invalid), and an older remote that predates this field simply
// ignores the extra body key and behaves as before.
function postSystemEndpoint(
  target: { apiUrl: string; apiToken: string },
  endpoint: '/api/system/update' | '/api/system/reapply-compose',
  body: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
  return fetch(`${target.apiUrl.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

function postSystemUpdate(target: { apiUrl: string; apiToken: string }, targetVersion?: string) {
  return postSystemEndpoint(target, '/api/system/update', targetVersion ? { targetVersion } : {});
}

function postSystemReapplyCompose(target: { apiUrl: string; apiToken: string }) {
  return postSystemEndpoint(target, '/api/system/reapply-compose');
}

/** Clear a terminal tracker row, or time out a stale in-flight one. Returns a
 *  conflict message when another update/reapply is still actively running. */
function beginTrackerOperation(nodeId: number, conflictError: string): string | null {
  const existing = updateTracker.get(nodeId);
  if (existing?.status === 'updating') {
    if (Date.now() - existing.startedAt > UPDATE_TIMEOUT_MS) {
      updateTracker.set(nodeId, updateTracker.resolve(existing, 'timeout', UPDATE_TIMEOUT_MSG));
    } else {
      return conflictError;
    }
  }
  if (existing && (existing.status === 'timeout' || existing.status === 'failed' || existing.status === 'completed')) {
    updateTracker.delete(nodeId);
  }
  return null;
}

function parseRemoteUpdateFailure(payload: unknown): { error: string; code?: string } {
  if (!payload || typeof payload !== 'object') {
    return { error: 'Remote node rejected update request.' };
  }
  const response = payload as Record<string, unknown>;
  return {
    error: typeof response.error === 'string' && response.error
      ? response.error
      : 'Remote node rejected update request.',
    ...(typeof response.code === 'string' && response.code ? { code: response.code } : {}),
  };
}

// --- Skip-version endpoints ---

fleetRouter.post('/nodes/:nodeId/skip-version', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    try {
      const nodeId = parseIntParam(req, res, 'nodeId');
      if (nodeId === null) {
        return;
      }
      const db = DatabaseService.getInstance();
      const node = db.getNode(nodeId);
      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      const { version } = req.body ?? {};
      const normalized = typeof version === 'string' ? semver.valid(version) : null;
      if (!normalized || version.length > 64) {
        res.status(400).json({ error: 'Invalid version' });
        return;
      }
      const username = req.user?.username ?? 'unknown';
      db.setNodeUpdateSkip(nodeId, normalized, username);
      res.status(204).end();
    } catch (error) {
      console.error('[Fleet] Skip-version error:', error);
      res.status(500).json({ error: 'Failed to skip version' });
    }
  });

fleetRouter.delete('/nodes/:nodeId/skip-version', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    try {
      const nodeId = parseIntParam(req, res, 'nodeId');
      if (nodeId === null) {
        return;
      }
      const db = DatabaseService.getInstance();
      const node = db.getNode(nodeId);
      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      db.deleteNodeUpdateSkip(nodeId);
      res.status(204).end();
    } catch (error) {
      console.error('[Fleet] Unskip-version error:', error);
      res.status(500).json({ error: 'Failed to unskip version' });
    }
  });

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

    const requestedTarget = parseRequestedTargetVersion(req, res);
    if (requestedTarget === null) return; // invalid supplied value; 400 already sent

    const conflict = beginTrackerOperation(nodeId, 'Update already in progress for this node.');
    if (conflict) {
      res.status(409).json({ error: conflict });
      return;
    }

    console.log('[Fleet] Update triggered for node', node.name, node.type);
    if (isDebugEnabled()) {
      console.debug('[Fleet:debug] Update trigger details:', { nodeId, name: node.name, type: node.type, mode: node.mode });
    }

    if (node.type === 'local') {
      const selfUpdate = SelfUpdateService.getInstance();
      if (!selfUpdate.isAvailable()) {
        res.status(503).json({ error: 'Self-update unavailable on the local node.' });
        return;
      }
      const resolvedTarget = await resolveUpdateTarget(requestedTarget);
      const pin = await selfUpdate.getPinInfo({ fresh: true });
      if (pin && classifyImageChannel(pin.composeImageRef) === 'hardened') {
        if (!requireUserSession(req, res)) return;
        const preflight = await ImageOperationService.getInstance().preflightSwitch();
        if (!preflight.ok) {
          res.status(403).json({ error: 'Hardened image access is unavailable', code: preflight.code });
          return;
        }
        const result = await ImageOperationService.getInstance().switchToHardened(
          preflight.preflightFingerprint,
          'update',
        );
        if (!result.ok) {
          res.status(result.code === 'IMAGE_OPERATION_IN_FLIGHT' ? 409 : 500)
            .json({ error: 'Hardened update could not start', code: result.code });
          return;
        }
        updateTracker.set(nodeId, updateTracker.create('updating', getSenchoVersion(), null));
        res.status(202).json({ message: 'Update initiated on local node. The server will restart shortly.' });
        return;
      }
      if (!respondSelfUpdatePreflight(res, await selfUpdate.canSelfUpdateTarget(resolvedTarget))) return;
      const claim = await ImageOperationService.getInstance().claimCommunityUpdate({ targetVersion: resolvedTarget });
      if (!claim.ok) {
        res.status(409).json({ error: 'An image operation is already in progress.', code: claim.failureCode });
        return;
      }
      updateTracker.set(nodeId, updateTracker.create('updating', getSenchoVersion(), null));
      res.status(202).json({ message: 'Update initiated on local node. The server will restart shortly.' });
      // Schedule unconditionally: client abort can fire only `close` without `finish`,
      // which would otherwise leave the claimed operation stuck in pending_pull.
      setTimeout(() => {
        ImageOperationService.getInstance().executeClaimedCommunityUpdate({ targetVersion: resolvedTarget }).catch(error => {
          console.error('[ImageOperation] Unexpected community update failure:', error);
        });
      }, 500);
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
    // Hardened peers are digest-pinned (updateBlocked) but must still reach
    // /api/system/update so machine creds get HARDENED_REMOTE_UPDATE_UNSUPPORTED.
    if (meta.updateBlocked && meta.imageChannel !== 'hardened') {
      res.status(409).json({ error: REPIN_BLOCKED_REASON, code: 'update_blocked' });
      return;
    }

    const resolvedTarget = await resolveUpdateTarget(requestedTarget);
    const response = await postSystemUpdate(target, resolvedTarget);

    if (!response.ok) {
      const failure = parseRemoteUpdateFailure(await response.json().catch(() => null));
      updateTracker.set(nodeId, updateTracker.create('failed', meta.version, meta.startedAt, failure.error, failure.code));
      res.status(502).json(failure);
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

fleetRouter.post('/nodes/:nodeId/reapply-compose', authMiddleware, async (req: Request, res: Response): Promise<void> => {
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

    const conflict = beginTrackerOperation(nodeId, 'An update or reapply is already in progress for this node.');
    if (conflict) {
      res.status(409).json({ error: conflict });
      return;
    }

    console.log('[Fleet] Compose reapply triggered for node', node.name, node.type);

    if (node.type === 'local') {
      const selfUpdate = SelfUpdateService.getInstance();
      if (!selfUpdate.isAvailable()) {
        res.status(503).json({ error: 'Compose reapply unavailable on the local node.' });
        return;
      }
      const claim = await ImageOperationService.getInstance().claimComposeReapply();
      if (!claim.ok) {
        res.status(409).json({ error: 'An image operation is already in progress.', code: claim.failureCode });
        return;
      }
      updateTracker.set(
        nodeId,
        updateTracker.create('updating', getSenchoVersion(), null, undefined, undefined, 'reapply_configuration'),
      );
      res.status(202).json({ message: 'Compose reapply initiated on local node. The server will restart shortly.' });
      setTimeout(() => {
        ImageOperationService.getInstance().executeClaimedComposeReapply().catch(error => {
          console.error('[ImageOperation] Unexpected compose reapply failure:', error);
        });
      }, 500);
      return;
    }

    // Sync lock before any await so a concurrent reapply gets 409 without
    // racing the remote POST. The pollable tracker is created only after meta
    // is known (full process identity), immediately before dispatch.
    if (remoteReapplyDispatching.has(nodeId)) {
      res.status(409).json({ error: 'An update or reapply is already in progress for this node.' });
      return;
    }
    remoteReapplyDispatching.add(nodeId);

    const failOwnedTracker = (
      error: string,
      code?: string,
      previousVersion: string | null = null,
      previousProcessStart: number | null = null,
    ) => {
      const current = updateTracker.get(nodeId);
      if (current?.status !== 'updating' || current.operationKind !== 'reapply_configuration') return;
      updateTracker.set(
        nodeId,
        updateTracker.create('failed', previousVersion, previousProcessStart, error, code, 'reapply_configuration'),
      );
    };

    try {
      const target = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!target) {
        const error = formatNoTargetError(node);
        res.status(503).json({ error });
        return;
      }

      const meta = await NodeRegistry.getInstance().fetchMetaForNode(node.id);
      if (!meta.online) {
        const error = 'Remote node is unreachable. Verify the node is running and the API URL is correct.';
        res.status(503).json({ error });
        return;
      }
      if (!meta.capabilities.includes('self-update')) {
        const error = 'Remote node does not support compose reapply. It may need to be updated manually first.';
        res.status(503).json({ error });
        return;
      }
      // Digest pins and updateBlocked are intentional non-gates: reapply never
      // repins the image, so blocked update rows remain eligible.

      // Reserve before the remote POST so a concurrent reapply still sees
      // 'updating' after this request leaves the dispatch set in finally.
      updateTracker.set(
        nodeId,
        updateTracker.create(
          'updating',
          meta.version,
          meta.startedAt,
          undefined,
          undefined,
          'reapply_configuration',
        ),
      );

      const response = await postSystemReapplyCompose(target);

      if (!response.ok) {
        const failure = parseRemoteUpdateFailure(await response.json().catch(() => null));
        failOwnedTracker(failure.error, failure.code, meta.version, meta.startedAt);
        res.status(502).json(failure);
        return;
      }

      res.status(202).json({ message: `Compose reapply initiated on ${node.name}.` });
    } finally {
      remoteReapplyDispatching.delete(nodeId);
    }
  } catch (error) {
    console.error('[Fleet] Node compose reapply error:', error);
    const errorMsg = getErrorMessage(error, 'Failed to trigger compose reapply.');
    const failedNodeId = parseInt(req.params.nodeId as string, 10);
    if (!isNaN(failedNodeId)) {
      remoteReapplyDispatching.delete(failedNodeId);
      const current = updateTracker.get(failedNodeId);
      if (current?.status === 'updating' && current.operationKind === 'reapply_configuration') {
        updateTracker.set(
          failedNodeId,
          updateTracker.create('failed', null, null, errorMsg, undefined, 'reapply_configuration'),
        );
      }
    }
    res.status(500).json({ error: 'Failed to trigger compose reapply.' });
  }
});

fleetRouter.post('/update-all', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    const gatewayVersion = getSenchoVersion();
    const { compareVersion, compareValid } = await getCompareTarget(gatewayVersion);
    // Forward the compare target so each remote repins a semver pin to it; omit
    // when there is no valid target so a remote falls back to legacy behavior.
    const updateAllTarget = pickCompareTarget(compareVersion, compareValid);

    const debug = isDebugEnabled();
    console.log('[Fleet] Update-all triggered,', nodes.length, 'nodes registered');
    if (debug) console.debug('[Fleet:debug] Update-all compare target:', { gatewayVersion, compareVersion, compareValid });

    const registry = NodeRegistry.getInstance();
    const remoteNodes = nodes.filter(node => node.type === 'remote');
    const candidates = remoteNodes.filter(node => {
      const tracker = updateTracker.get(node.id);
      if (tracker?.status === 'updating') return false;
      if (registry.getProxyTarget(node.id) === null) return false;
      // Clear terminal states so they can be re-triggered.
      if (tracker && (tracker.status === 'timeout' || tracker.status === 'failed' || tracker.status === 'completed')) {
        updateTracker.delete(node.id);
      }
      // Skip nodes that have skipped the current compare target version.
      const skipRow = db.getNodeUpdateSkip(node.id);
      if (skipRow && compareValid && skipRow.skippedVersion === compareVersion) {
        if (debug) console.debug('[Fleet:debug] Update-all skipping', node.name, '(version', compareVersion, 'skipped)');
        return false;
      }
      return true;
    });

    const results = await Promise.allSettled(candidates.map(async (node) => {
      const target = registry.getProxyTarget(node.id);
      if (!target) return { nodeId: node.id, name: node.name, kind: 'skipped' as const };
      const meta = await registry.fetchMetaForNode(node.id);
      if (!meta.online) {
        return { nodeId: node.id, name: node.name, kind: 'skipped' as const };
      }
      if (!meta.capabilities.includes('self-update')) {
        return { nodeId: node.id, name: node.name, kind: 'skipped' as const };
      }
      if (meta.updateBlocked && meta.imageChannel !== 'hardened') {
        return { nodeId: node.id, name: node.name, kind: 'skipped' as const };
      }
      if (isValidVersion(meta.version) && compareValid && !semver.lt(meta.version, compareVersion!)) {
        return { nodeId: node.id, name: node.name, kind: 'skipped' as const };
      }
      const response = await postSystemUpdate(target, updateAllTarget);
      if (response.ok) {
        updateTracker.set(node.id, updateTracker.create('updating', meta.version, meta.startedAt));
        return { nodeId: node.id, name: node.name, kind: 'updating' as const };
      }
      const failure = parseRemoteUpdateFailure(await response.json().catch(() => null));
      updateTracker.set(node.id, updateTracker.create('failed', meta.version, meta.startedAt, failure.error, failure.code));
      return { nodeId: node.id, name: node.name, kind: 'failed' as const, ...failure };
    }));

    const updating: string[] = [];
    const skipped = remoteNodes.filter(n => !candidates.includes(n)).map(n => n.name);
    const failed: Array<{ nodeId: number; name: string; code: string; error: string }> = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        console.warn(`[Fleet] Update-all failed for node ${candidates[i].name}:`, r.reason);
        failed.push({
          nodeId: candidates[i].id,
          name: candidates[i].name,
          code: 'REMOTE_UPDATE_REQUEST_FAILED',
          error: 'Failed to reach remote node for update.',
        });
        continue;
      }
      if (r.value.kind === 'updating') updating.push(r.value.name);
      else if (r.value.kind === 'failed') {
        failed.push({
          nodeId: r.value.nodeId,
          name: r.value.name,
          code: r.value.code ?? 'REMOTE_UPDATE_REQUEST_FAILED',
          error: r.value.error,
        });
      } else skipped.push(r.value.name);
    }

    if (debug) console.debug('[Fleet:debug] Update-all results:', { updating, skippedCount: skipped.length, failedCount: failed.length, candidateCount: candidates.length });
    res.status(202).json({ updating, skipped, failed });
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
// Permission: every confirmed stack requires stack:deploy. Discovery-only dry
// runs require node:read.
fleetRouter.post('/labels/fleet-stop', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { labelName?: unknown; dryRun?: unknown; targets?: unknown } | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }
  const { labelName, dryRun, targets } = body;
  if (typeof labelName !== 'string' || labelName.trim().length === 0) {
    res.status(400).json({ error: 'labelName is required' });
    return;
  }
  // Optional per-node allowlist binding execution to exactly the preview the
  // operator confirmed: each entry names a node and the stacks to stop on it.
  // This binds both axes of drift between preview and execution: a node that was
  // unreachable during preview and reconnects cannot enter the stop (it is not
  // in the map), and a stack that gained the label after preview is never
  // stopped (the executor intersects the live label match against this set).
  // Absent (e.g. a dry run) the fan-out scans the whole fleet as before.
  let confirmedStacksByNode: Map<number, Set<string>> | null = null;
  if (targets !== undefined) {
    if (!Array.isArray(targets)) {
      res.status(400).json({ error: 'targets must be an array' });
      return;
    }
    confirmedStacksByNode = new Map();
    for (const raw of targets) {
      if (!raw || typeof raw !== 'object') {
        res.status(400).json({ error: 'each target must be an object' });
        return;
      }
      const { nodeId, stackNames } = raw as { nodeId?: unknown; stackNames?: unknown };
      if (typeof nodeId !== 'number' || !Number.isInteger(nodeId)) {
        res.status(400).json({ error: 'target.nodeId must be an integer' });
        return;
      }
      if (!Array.isArray(stackNames) || !stackNames.every(s => typeof s === 'string')) {
        res.status(400).json({ error: 'target.stackNames must be an array of strings' });
        return;
      }
      confirmedStacksByNode.set(nodeId, new Set(stackNames as string[]));
    }
  }
  const trimmed = labelName.trim();
  const isDryRun = dryRun === true;
  if (confirmedStacksByNode) {
    const denied = [...confirmedStacksByNode].some(([nodeId, stackNames]) =>
      [...stackNames].some(stackName =>
        !checkPermission(req, 'stack:deploy', 'stack', stackName, nodeId)));
    if (denied) {
      res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
      return;
    }
  } else if (isDryRun) {
    if (!requirePermission(req, res, 'node:read')) return;
  } else if (!requirePermission(req, res, 'stack:deploy')) {
    return;
  }
  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    const targetNodes = confirmedStacksByNode ? nodes.filter(n => confirmedStacksByNode.has(n.id)) : nodes;
    if (isDebugEnabled()) console.debug('[Fleet:debug] fleet-stop:', { labelName: trimmed, dryRun: isDryRun, nodes: targetNodes.length, scoped: confirmedStacksByNode !== null });
    const results = await Promise.all(targetNodes.map(async (node): Promise<FleetStopNodeResult> => {
      const allowedStacks = confirmedStacksByNode?.get(node.id);
      if (node.type === 'local') {
        // Match + stop runs in-process against the control's own Docker. The
        // helper shares the per-node `bulk:<id>` lock with the per-label action
        // route so the two cannot double-stop the same containers. A control-side
        // failure (e.g. the compose dir is unreadable) degrades to a per-stack
        // error for this node only; the node is reachable, the stop just failed.
        try {
          const outcome = await runLocalLabelStop(node.id, trimmed, isDryRun, allowedStacks);
          return { nodeId: node.id, nodeName: node.name, reachable: true, matched: outcome.matched, stackResults: outcome.stackResults };
        } catch (err) {
          const errorMsg = getErrorMessage(err, 'Failed to stop local stacks');
          const localLabel = db.getLabels(node.id).find(l => l.name === trimmed);
          // With a confirmed allowlist, report the full confirmed set as
          // failures rather than the current label assignment: a confirmed stack
          // that lost its label after the preview must still surface, not vanish
          // because it is no longer assigned when the exception is reconstructed.
          const localStacks = allowedStacks
            ? [...allowedStacks]
            : (localLabel ? db.getStacksForLabel(localLabel.id, node.id) : []);
          return {
            nodeId: node.id, nodeName: node.name, reachable: true, matched: !!localLabel,
            stackResults: failAllStacks(localStacks, errorMsg),
          };
        }
      }

      // Remote node. Ask the remote authoritatively via its permission-checked local-stop
      // receiver, which name-matches under the remote's own bulk lock. There is no
      // control-side pre-check: remote label rows are never mirrored to the
      // control, so a mirror lookup would skip every remote. A node we cannot
      // reach is reported at the node level and never blocks the reachable nodes.
      const target = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!target) {
        return { nodeId: node.id, nodeName: node.name, reachable: false, matched: false, stackResults: [], error: formatNoTargetError(node) };
      }
      // A real stop bound to a confirmed stack set must only go to a remote that
      // honors the allowlist (cross-node-rbac). An older remote ignores
      // `stackNames` and would stop every label-matched stack, including ones
      // labelled after the preview. Refuse to send and report the node as
      // needing an upgrade instead. Dry runs carry no allowlist and only
      // preview, so they are safe to send to any version.
      if (!isDryRun && allowedStacks) {
        const supported = await remoteSupportsCrossNodeRbac(node.id);
        if (!supported) {
          return {
            nodeId: node.id, nodeName: node.name, reachable: false, matched: false,
            stackResults: failAllStacks([...allowedStacks], 'Node must be upgraded to honor an exact-stack stop'),
            error: 'Node is running a version that cannot limit the stop to the confirmed stacks; upgrade it and retry.',
          };
        }
      }
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
        const response = await fetch(`${target.apiUrl.replace(/\/$/, '')}/api/fleet-actions/labels/local-stop`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            labelName: trimmed,
            dryRun: isDryRun,
            ...(allowedStacks ? { stackNames: [...allowedStacks] } : {}),
          }),
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
        // Defense in depth behind the capability gate: if a confirmed allowlist
        // was sent, the remote must report exactly the confirmed set: one result
        // per confirmed stack, no extras, no duplicates. Extras mean the remote
        // ignored the allowlist (an over-broad stop); a missing confirmed stack
        // means it silently dropped one. Either way fail the node rather than
        // render an over-broad or partial result as clean. A current remote
        // always reconciles to one result per confirmed stack, so this only
        // rejects an older or misbehaving receiver.
        if (allowedStacks) {
          const returned = remote.results.map(r => r.stackName);
          const returnedSet = new Set(returned);
          const exact = returned.length === allowedStacks.size
            && returnedSet.size === returned.length
            && [...allowedStacks].every(s => returnedSet.has(s));
          if (!exact) {
            return { nodeId: node.id, nodeName: node.name, reachable: false, matched: false, stackResults: [], error: 'Remote did not report exactly the confirmed stacks' };
          }
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
    // A confirmed node that was deleted or unregistered between preview and
    // execution would otherwise vanish from the response (the node-list filter
    // above drops it), letting the remaining successes read as a clean stop.
    // Surface each missing confirmed node as an unreachable failure, with its
    // confirmed stacks marked failed so the run is reported as partial, not
    // clean.
    const missingResults: FleetStopNodeResult[] = [];
    if (confirmedStacksByNode) {
      const present = new Set(nodes.map(n => n.id));
      for (const [nodeId, stacks] of confirmedStacksByNode) {
        if (!present.has(nodeId)) {
          missingResults.push({
            nodeId, nodeName: `Node ${nodeId}`, reachable: false, matched: false,
            stackResults: failAllStacks([...stacks], 'Node no longer exists'),
            error: 'Node no longer exists',
          });
        }
      }
    }
    const allResults = [...results, ...missingResults];
    if (isDebugEnabled()) {
      const matched = allResults.filter(r => r.matched).length;
      const stopped = allResults.reduce((n, r) => n + r.stackResults.filter(s => s.success).length, 0);
      const failed = allResults.reduce((n, r) => n + r.stackResults.filter(s => !s.success).length, 0);
      console.debug('[Fleet:debug] fleet-stop complete:', { matched, stopped, failed, missing: missingResults.length });
    }
    res.json({ results: allResults });
  } catch (error) {
    console.error('[Fleet] fleet-stop error:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to run fleet stop') });
  }
});

// Fleet-wide bulk label assign. Propagates a label template (name + color) to
// stacks across one or more nodes: for each target node the label is resolved or
// created by name on that node, then assigned to the given stacks preserving
// their existing labels (add semantics). Labels are node-local, so the control
// never reuses a local label id on a remote; the local node runs in-process and
// each remote runs its own `/api/fleet-actions/labels/local-assign` receiver.
// Per-node failures (unknown node, no proxy target, unreachable, mixed-version
// remote, malformed response) degrade that node only and never discard the rest
// of the fan-out.
// Permission: every target stack requires stack:edit.
fleetRouter.post('/labels/bulk-assign', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { label?: unknown; targets?: unknown } | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }
  const validated = validateLabelTemplate(body.label);
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    res.status(400).json({ error: 'targets must be a non-empty array' });
    return;
  }
  // Normalize targets: each must name a node and carry a string array of stacks.
  // Stack names are deduped per node and empty groups are dropped, so the cap
  // measures real assignments rather than padded input.
  const targets: { nodeId: number; stackNames: string[] }[] = [];
  let totalStacks = 0;
  for (const raw of body.targets as unknown[]) {
    if (!raw || typeof raw !== 'object') {
      res.status(400).json({ error: 'each target must be an object' });
      return;
    }
    const { nodeId, stackNames } = raw as { nodeId?: unknown; stackNames?: unknown };
    if (typeof nodeId !== 'number' || !Number.isInteger(nodeId)) {
      res.status(400).json({ error: 'target.nodeId must be an integer' });
      return;
    }
    if (!Array.isArray(stackNames) || !stackNames.every(s => typeof s === 'string')) {
      res.status(400).json({ error: 'target.stackNames must be an array of strings' });
      return;
    }
    const unique = Array.from(new Set(stackNames as string[]));
    if (unique.length === 0) continue;
    totalStacks += unique.length;
    targets.push({ nodeId, stackNames: unique });
  }
  if (targets.length === 0) {
    res.status(400).json({ error: 'no target stacks provided' });
    return;
  }
  if (totalStacks > MAX_ASSIGNMENTS) {
    res.status(400).json({ error: `targets may not exceed ${MAX_ASSIGNMENTS} stack assignments` });
    return;
  }
  const denied = targets.some(target => target.stackNames.some(stackName =>
    !checkPermission(req, 'stack:edit', 'stack', stackName, target.nodeId)));
  if (denied) {
    res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
    return;
  }
  const { template } = validated;
  try {
    const db = DatabaseService.getInstance();
    const nodesById = new Map(db.getNodes().map(n => [n.id, n]));
    if (isDebugEnabled()) console.debug('[Fleet:debug] bulk-assign:', { label: template.name, targets: targets.length, totalStacks });
    const results: AssignNodeResult[] = await Promise.all(targets.map(async (target): Promise<AssignNodeResult> => {
      const node = nodesById.get(target.nodeId);
      if (!node) {
        return {
          nodeId: target.nodeId, nodeName: `Node ${target.nodeId}`, reachable: false, created: false, error: 'Unknown node',
          stackResults: failAllAssign(target.stackNames, 'Unknown node'),
        };
      }
      if (node.type === 'local') {
        try {
          const outcome = await runLocalLabelAssign(node.id, template, target.stackNames);
          return { nodeId: node.id, nodeName: node.name, reachable: true, created: outcome.created, stackResults: outcome.stackResults };
        } catch (err) {
          return {
            nodeId: node.id, nodeName: node.name, reachable: true, created: false,
            stackResults: failAllAssign(target.stackNames, getErrorMessage(err, 'Failed to assign labels')),
          };
        }
      }

      const proxyTarget = NodeRegistry.getInstance().getProxyTarget(node.id);
      if (!proxyTarget) {
        const error = formatNoTargetError(node);
        return { nodeId: node.id, nodeName: node.name, reachable: false, created: false, error, stackResults: failAllAssign(target.stackNames, error) };
      }
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (proxyTarget.apiToken) headers.Authorization = `Bearer ${proxyTarget.apiToken}`;
        const response = await fetch(`${proxyTarget.apiUrl.replace(/\/$/, '')}/api/fleet-actions/labels/local-assign`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ label: template, stackNames: target.stackNames }),
          signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) {
          const err = (await response.json().catch(() => ({}))) as { error?: string };
          const message = err.error || `Remote returned ${response.status}`;
          return { nodeId: node.id, nodeName: node.name, reachable: false, created: false, error: message, stackResults: failAllAssign(target.stackNames, message) };
        }
        // A 200 whose body is not the expected { created, results } shape, or
        // whose results do not cover exactly the stacks this node was asked to
        // label, is a degraded node, not a clean no-op: report it as a per-node
        // failure so a malformed or partial remote cannot read as a successful
        // zero-stack assign.
        const remote = validateRemoteAssignResults(target.stackNames, await response.json().catch(() => null));
        if (!remote.ok) {
          const message = 'Remote returned a malformed response';
          return { nodeId: node.id, nodeName: node.name, reachable: false, created: false, error: message, stackResults: failAllAssign(target.stackNames, message) };
        }
        return {
          nodeId: node.id, nodeName: node.name, reachable: true,
          created: remote.created,
          stackResults: remote.results,
        };
      } catch (err) {
        const errorMsg = getErrorMessage(err, 'Failed to reach remote node');
        return { nodeId: node.id, nodeName: node.name, reachable: false, created: false, error: errorMsg, stackResults: failAllAssign(target.stackNames, errorMsg) };
      }
    }));
    res.json({ results });
  } catch (error) {
    console.error('[Fleet] bulk-assign error:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to run bulk label assign') });
  }
});

// Fleet-wide Docker prune. Dry runs collect one itemized plan per node. Execute
// validates the reviewed roster, preflights every plan, then starts mutation.
// Tier: requireAdmin (admin-only fleet plumbing; available on every license).
fleetRouter.post('/labels/fleet-prune', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const parsed = parseFleetPruneRequest(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const response = await runFleetPrune(
      DatabaseService.getInstance().getNodes(),
      parsed.request,
      activeBulkActions,
    );
    res.status(response.status).json(response.body);
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
  if (!requirePermission(req, res, 'node:read')) return;
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
  if (!requirePermission(req, res, 'node:read')) return;
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
// only). Per-target failures keep successful targets' bytes via foldNodeEstimate
// rather than zeroing the whole node.
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

  try {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    const perNode: FleetNodeEstimate[] = await Promise.all(nodes.map(async (node): Promise<FleetNodeEstimate> => {
      if (node.type === 'local') {
        let knownStacks: string[];
        let dockerController: ReturnType<typeof DockerController.getInstance>;
        try {
          knownStacks = scope === 'managed' ? await FileSystemService.getInstance(node.id).getStacks() : [];
          // Init can throw if the node row disappears mid-request; keep that
          // failure per-node so other fleet estimates still return.
          dockerController = DockerController.getInstance(node.id);
        } catch (err) {
          return {
            nodeId: node.id,
            nodeName: node.name,
            reclaimableBytes: 0,
            reachable: false,
            error: getErrorMessage(err, 'Failed to estimate locally'),
          };
        }
        const perTarget: FleetEstimateTargetResult[] = [];
        for (const target of targets) {
          // Bound so a slow local daemon does not hang the fleet
          // estimate (F-6). Both managed and all scopes bound each
          // per-target call at the same 12 s. Failures stay per-target so
          // earlier successes are not discarded.
          try {
            const estimate = scope === 'managed'
              ? dockerController.estimateManagedReclaim(target, knownStacks)
              : dockerController.estimateSystemReclaim(target, knownStacks);
            const result = await withTimeout(estimate, FLEET_DF_TIMEOUT_MS, 'docker disk usage');
            perTarget.push({ bytes: result.reclaimableBytes });
          } catch (err) {
            const error = err instanceof TimeoutError
              ? 'Docker daemon is busy. Please try again in a moment.'
              : getErrorMessage(err, 'Failed to estimate locally');
            perTarget.push({ bytes: 0, error });
          }
        }
        return foldNodeEstimate({ nodeId: node.id, nodeName: node.name }, perTarget);
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
      const perTarget = await Promise.all(targets.map(async (target): Promise<FleetEstimateTargetResult> => {
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
          // Remote nodes are an untrusted boundary: reject non-finite or
          // negative values so a bad estimate cannot shrink the fleet total.
          if (
            !remote
            || typeof remote.reclaimableBytes !== 'number'
            || !Number.isFinite(remote.reclaimableBytes)
            || remote.reclaimableBytes < 0
          ) {
            return { bytes: 0, error: 'Invalid response from remote node' };
          }
          return { bytes: remote.reclaimableBytes };
        } catch (err) {
          return { bytes: 0, error: getErrorMessage(err, 'Failed to reach remote node') };
        }
      }));
      return foldNodeEstimate({ nodeId: node.id, nodeName: node.name }, perTarget);
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

    // Group files by node and stack. Unavailable decrypts keep attribution but
    // never expose ciphertext or fabricated placeholders as content.
    type DetailFile =
      | { filename: string; content: string }
      | { filename: string; unavailable: true };
    const fileDecryptWarnings: Array<{ nodeId: number; nodeName: string; stackName: string; filename: string }> = [];
    const nodesMap = new Map<number, { nodeId: number; nodeName: string; stacks: Map<string, DetailFile[]> }>();
    for (const file of files) {
      if (!nodesMap.has(file.node_id)) {
        nodesMap.set(file.node_id, { nodeId: file.node_id, nodeName: file.node_name, stacks: new Map() });
      }
      const nodeEntry = nodesMap.get(file.node_id)!;
      if (!nodeEntry.stacks.has(file.stack_name)) {
        nodeEntry.stacks.set(file.stack_name, []);
      }
      if (file.available) {
        nodeEntry.stacks.get(file.stack_name)!.push({ filename: file.filename, content: file.content });
      } else {
        nodeEntry.stacks.get(file.stack_name)!.push({ filename: file.filename, unavailable: true });
        fileDecryptWarnings.push({
          nodeId: file.node_id,
          nodeName: file.node_name,
          stackName: file.stack_name,
          filename: file.filename,
        });
      }
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
    res.json({ ...snapshot, nodes, documentation, fileDecryptWarnings });
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
  let code: string | undefined;
  try {
    const raw = (await res.text()).trim();
    detail = raw.slice(0, 300);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'code' in parsed && typeof parsed.code === 'string') {
      code = parsed.code;
    }
  } catch {
    // Body missing or not JSON; status (and any truncated text) still name the failure.
  }
  return Object.assign(
    new Error(`${action} on remote node (${res.status})${detail ? `: ${detail}` : ''}`),
    { code, httpStatus: res.status },
  );
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

// Writes a snapshot stack's files back to its node. Existing stacks capture a
// recovery generation before the first write; capture failure aborts with no
// mutation. A later write failure can leave live files changed; the captured
// generation remains. Throws SnapshotProxyTargetError when the remote has no
// proxy target. A non-OK apply response becomes an Error with the remote
// status and body (capture, lock, or write).
async function applySnapshotStackFiles(
  node: Node,
  stackName: string,
  files: Array<{ filename: string; content: string }>,
): Promise<void> {
  const applyFiles = selectFleetSnapshotApplyFiles(files);
  if (node.type === 'local') {
    await applyFleetSnapshotFiles({
      nodeId: node.id,
      stackName,
      files: applyFiles,
      actor: 'system:fleet-snapshot',
    });
    return;
  }

  const ctx = buildRemoteProxyContext(node);
  if (!ctx) throw new SnapshotProxyTargetError(formatNoTargetError(node));
  const applyRes = await fetch(`${ctx.baseUrl}/api/stacks/${encodeURIComponent(stackName)}/fleet-snapshot-apply`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ files: applyFiles }),
    signal: AbortSignal.timeout(FLEET_SNAPSHOT_APPLY_TIMEOUT_MS),
  });
  if (!applyRes.ok) throw await remoteStackError('Failed to restore stack files', applyRes);
}

// Redeploys a stack after its files are restored. The deploy policy gate stays
// with the caller (local deploys gate centrally; remote deploys are gated by
// the remote node), so this only performs the deploy itself.
async function redeploySnapshotStack(node: Node, stackName: string): Promise<void> {
  if (node.type === 'local') {
    const lock = await StackOpLockService.getInstance().runExclusive(
      node.id, stackName, 'deploy', 'system',
      () => ComposeService.getInstance(node.id).deployStack(
        stackName,
        undefined,
        undefined,
        { source: 'fleet_snapshot', actor: 'system:fleet-snapshot' },
      ),
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
    headers: {
      ...ctx.headers,
      ...deployProvenanceHeaders('fleet_snapshot', 'system:fleet-snapshot'),
    },
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
    if (files.some(f => !f.available)) {
      res.status(409).json({
        error: 'One or more snapshot files could not be decrypted',
        code: 'SNAPSHOT_FILE_UNAVAILABLE',
      });
      return;
    }
    const writableFiles = files
      .filter((f): f is Extract<typeof f, { available: true }> => f.available)
      .map(f => ({ filename: f.filename, content: f.content }));

    if (isDebugEnabled()) {
      const fileNames = writableFiles.map(f => f.filename).join(', ');
      console.debug('[Fleet:debug] Restore: snapshot=%s, node=%s, stack="%s", files=[%s], redeploy=%s', sanitizeForLog(snapshotId), sanitizeForLog(nodeId), sanitizeForLog(stackName), sanitizeForLog(fileNames), sanitizeForLog(redeploy));
    }

    const node = db.getNode(nodeId);
    if (!node) {
      res.status(404).json({ error: 'Target node no longer exists' });
      return;
    }

    await applySnapshotStackFiles(node, stackName, writableFiles);

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
    const conflict = fleetSnapshotApplyConflictCode(error);
    if (conflict) {
      res.status(409).json({ error: getErrorMessage(error, 'Restore conflict'), code: conflict });
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

    // Group the snapshot's files by node + stack, retaining availability so
    // unavailable rows are rejected before any content is written.
    const groups = new Map<string, {
      nodeId: number;
      nodeName: string;
      stackName: string;
      files: typeof files;
    }>();
    for (const file of files) {
      const key = `${file.node_id}:${file.stack_name}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { nodeId: file.node_id, nodeName: file.node_name, stackName: file.stack_name, files: [] };
        groups.set(key, entry);
      }
      entry.files.push(file);
    }

    const policyOptions = buildPolicyGateOptions(req);
    const results: SnapshotRestoreResult[] = [];

    // Restore every stack independently: one stack failing (unreachable node,
    // blocked deploy, write error) is recorded and the rest still proceed.
    for (const group of groups.values()) {
      try {
        if (!isValidStackName(group.stackName)) throw new Error('Invalid stack name');
        if (group.files.some(f => !f.available)) {
          results.push({
            nodeId: group.nodeId,
            nodeName: group.nodeName,
            stackName: group.stackName,
            success: false,
            redeployed: false,
            notesRestored: false,
            error: 'One or more snapshot files could not be decrypted',
          });
          continue;
        }
        const node = db.getNode(group.nodeId);
        if (!node) throw new Error('Target node no longer exists');

        const writableFiles = group.files
          .filter((f): f is Extract<typeof f, { available: true }> => f.available)
          .map(f => ({ filename: f.filename, content: f.content }));
        await applySnapshotStackFiles(node, group.stackName, writableFiles);

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

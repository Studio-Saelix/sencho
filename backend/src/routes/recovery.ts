import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { checkPermission, type PermissionAction } from '../middleware/permissions';
import type { ResourceType } from '../services/DatabaseService';
import { isValidStackName } from '../utils/validation';
import { buildLocalRecoveryNodeDescriptor, getLocalVolumeProtectionStatus } from '../services/recovery/capability';
import { operationIdFromRequest } from '../services/recovery/dispatcher';
import {
  RecoveryEngineService,
  RECOVERY_FAILURE_DOMAIN,
  SAME_FAILURE_DOMAIN_WARNING,
  sha256Digest,
  type PointContentDownload,
} from '../services/recovery/operationRunner';
import {
  authorizeNodeWide,
  authorizePointContentRead,
  authorizeStorageAccess,
  mayLearnIdIsUnknown,
  RECOVERY_ACCESS_ACTION,
  type PointContentReadTarget,
  type RecoveryAccess,
} from '../services/recovery/authorization';
import { RECOVERY_RESERVED_PREFIX } from '../services/recovery/reservedNames';
import { RECOVERY_RESERVED_TARGET_PREFIX } from '../services/recovery/restoreIntents';
import { RecoveryOperationStore } from '../services/recovery/operations';
import { RecoveryPointStore } from '../services/recovery/recoveryPoints';
import { RecoveryRepositoryStore } from '../services/recovery/repositories';
import { RestoreIntentStore } from '../services/recovery/restoreIntents';
import { RestoreFenceStore } from '../services/recovery/restoreFence';
import { overwriteIntentScope } from '../services/recovery/overwriteRestore';
import { StorageIdentityStore, deriveStorageKey, isDockerVolumeName } from '../services/recovery/storageIdentity';
import {
  describeIneligible,
  describeStoredLocator,
  generationTokenMatchesVolume,
  inspectVolumeSource,
  knownStacksFor,
  listVolumeSources,
  resolveVolumeDependents,
} from '../services/recovery/volumeSources';
import { ownerNodeKeyFor } from '../services/recovery/localRepository';
import { getRecoveryAuthorityId } from '../services/recovery/recoveryDb';
import { evaluateCoverage, evaluateRootCoverage, type RootCoverageInput } from '../services/recovery/coverage';
import {
  classifyRecoveryError,
  errorDetailFor,
  isRecoveryErrorClass,
  RecoveryError,
} from '../services/recovery/redaction';
import { ROOT_COVERAGE_FRESHNESS_MS } from '../services/recovery/types';
import {
  POINT_DOWNLOAD_IDLE_MS,
  POINT_READ_RETRY_AFTER_S,
  parsePageOffset,
  parsePointPath,
} from '../services/recovery/pointContents';
import type {
  RecoveryErrorClass,
  RecoveryOperation,
  RootCoverageReason,
  StorageDependent,
} from '../services/recovery/types';
import { errorMessageForLog, sanitizeForLog } from '../utils/safeLog';
import DockerController from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';
import { parseEffectiveModel } from '../services/preflight/effectiveModel';

export const recoveryRouter = Router();

/**
 * The node-local recovery API.
 *
 * Every route here runs on the node that owns the storage, whether the request
 * came from that node's own UI, from the hub over the direct proxy, or from the
 * hub over a Pilot tunnel. That is why the authorization check lives here and not
 * at the hub: a relayed request is held to the same rule as a local one, and a
 * hub that connects later cannot widen what this node allows.
 *
 * Mutating routes answer `503` until boot finishes, `409` when a lock is held or
 * stale, and never `202` for work that has not been admitted.
 */

export const ERROR_STATUS: Readonly<Record<RecoveryErrorClass, number>> = {
  invalid_request: 400,
  permission_denied: 403,
  capability_unavailable: 503,
  update_required: 409,
  schema_unsupported: 503,
  identity_unknown: 409,
  lock_held: 409,
  lock_stale: 409,
  repository_unavailable: 503,
  repository_key_unavailable: 503,
  source_unreadable: 422,
  integrity_mismatch: 409,
  attributes_not_restored: 422,
  interrupted: 409,
  transport_unreachable: 503,
  // The hub preflight answers these two with 503; the table says the same.
  node_refused: 503,
  node_error: 503,
  internal: 500,
  // The overwrite surface. A changed precondition, a moved generation and a
  // dependent that appeared are all "ask for a new preview"; a fence that cannot
  // be applied and a missing volume are the node's state, not the request's.
  precondition_failed: 409,
  dependents_changed: 409,
  fence_unavailable: 503,
  pre_restore_failed: 422,
  insufficient_space: 507,
  cleanup_failed: 500,
  not_cancellable: 409,
};

/** The machine code a client switches on, one per class. */
export function codeFor(errorClass: RecoveryErrorClass): string {
  return errorClass.toUpperCase();
}

function sendRecoveryError(
  res: Response,
  errorClass: RecoveryErrorClass,
  extra: Record<string, unknown> = {},
  detail?: string,
): void {
  res.status(ERROR_STATUS[errorClass]).json({
    error: detail ?? errorDetailFor(errorClass),
    errorClass,
    code: codeFor(errorClass),
    ...extra,
  });
}

/**
 * `requirePermission`, answering in the recovery error shape. The shared guard
 * sends `{ error, code }` only, and every other answer from these routes carries
 * `errorClass`, so a client has one field to switch on.
 */
function requireRecoveryPermission(
  req: Request,
  res: Response,
  action: PermissionAction,
  resourceType?: ResourceType,
  resourceId?: string,
): boolean {
  if (checkPermission(req, action, resourceType, resourceId)) return true;
  sendRecoveryError(res, 'permission_denied');
  return false;
}

/**
 * The log line for a handler that failed unexpectedly. The method and path come
 * from the request, so each is stripped of control characters before it is
 * printed; the error text is already redacted.
 */
export function logInternalFailure(method: string, path: string, err: unknown): void {
  console.error('Recovery: %s %s failed:', sanitizeForLog(method), sanitizeForLog(path), errorMessageForLog(err));
}

/** Answer a thrown recovery error with its documented status and body. */
function sendThrown(req: Request, res: Response, err: unknown): void {
  const errorClass = classifyRecoveryError(err);
  if (errorClass === 'internal') {
    logInternalFailure(req.method, req.path, err);
  }
  // A response whose headers are already on the wire cannot carry a JSON error.
  // The body is partial by definition, so the only honest end is to break the
  // connection rather than let a client read a truncated body as a whole one.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const extra: Record<string, unknown> = {};
  if (err instanceof RecoveryError && err.reason !== undefined) extra.reason = err.reason;
  // A read refused for capacity frees up within seconds, and says when to ask again.
  if (err instanceof RecoveryError && err.reason === 'read_capacity') {
    res.setHeader('Retry-After', String(POINT_READ_RETRY_AFTER_S));
  }
  sendRecoveryError(res, errorClass, extra, err instanceof RecoveryError ? err.detail : undefined);
}

/** Run a handler and turn every thrown recovery error into its documented answer. */
function handle(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      sendThrown(req, res, err);
    }
  };
}

const idempotencyBody = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
});

/**
 * A volume name Docker accepts. Anything else (a path, a NUL, a non-ASCII name)
 * is refused here, before it can reach the daemon and come back as a `500`.
 */
const volumeNameField = z.string().trim().min(1).max(255).refine(isDockerVolumeName);

const createPointBody = idempotencyBody.extend({
  volumeName: volumeNameField,
});

const verifyBody = idempotencyBody.extend({
  method: z.enum(['engine_check_metadata', 'engine_check_read_data']).optional(),
});

const restoreBody = idempotencyBody.extend({
  targetVolumeName: volumeNameField,
  /**
   * Only `new_volume` is implemented in this release. The other two shapes are
   * named so a client asking for one is refused as `invalid_request` instead of
   * having its request silently treated as a new volume.
   */
  targetMode: z.enum(['new_volume', 'new_path', 'staged_overwrite']).optional(),
});

const repositoryBody = idempotencyBody.extend({
  replace: z.boolean().optional(),
});

/**
 * The overwrite confirmation: the token the preview answered with and the volume
 * name typed back. A 255-character bound matches the name Docker accepts, so a
 * pasted sentence is refused here rather than compared against a real name.
 */
const overwriteBody = idempotencyBody.extend({
  confirmationToken: z.string().trim().regex(/^[0-9a-f]{64}$/),
  confirmVolumeName: volumeNameField,
});

const resolveBody = z.object({
  action: z.enum(['retry', 'release_fence']),
});

const lockReleaseBody = z.object({
  scope: z.enum(['storage', 'repository']),
  resourceKey: z.string().trim().min(1).max(200),
});

/** Parse a body with zod, answering `invalid_request` on anything malformed. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new RecoveryError('invalid_request');
  return parsed.data;
}

/** One route parameter, narrowed. Express types a param as string or string[]. */
function paramOf(req: Request, name: string): string {
  const value: unknown = req.params[name];
  return typeof value === 'string' ? value : '';
}

/** The engine service for the node this request runs on. */
function engineService(req: Request): RecoveryEngineService {
  return RecoveryEngineService.getInstance(req.nodeId);
}

/** The one authorization shape every route uses. */
function authorizeWith(req: Request, access: RecoveryAccess) {
  return (context: { storageKey: string | null; dependents: readonly StorageDependent[] }): boolean =>
    authorizeStorageAccess(
      req,
      access,
      context.storageKey === null ? null : { storageKey: context.storageKey, liveDependents: context.dependents },
    ).allowed;
}

/** The actor a proxied request carries, or the signed-in user. */
function actorOf(req: Request): string {
  return req.deployContext?.actor ?? req.user?.username ?? 'unknown';
}

// --- Descriptor -------------------------------------------------------------

/**
 * This node's recovery descriptor: the contract version it speaks and whether it
 * can protect volumes. The hub reads it over the node proxy or the Pilot tunnel to
 * resolve version skew; a node that predates the route answers 404, which the hub
 * reads as "update required".
 *
 * Guarded by `stack:read`, like the other node-local slices the hub fans out to:
 * the payload is metadata about this node's capability and names no stack, path,
 * repository or key. The operation id a dispatch sent is echoed back so the hub
 * can tell this answer belongs to its request.
 */
recoveryRouter.get('/node', (req: Request, res: Response): void => {
  if (!requireRecoveryPermission(req, res, 'stack:read')) return;
  try {
    res.json({ ...buildLocalRecoveryNodeDescriptor(), operationId: operationIdFromRequest(req) });
  } catch (error) {
    console.error('Recovery: node descriptor failed:', errorMessageForLog(error));
    sendRecoveryError(res, 'internal', {}, 'Could not read this node\'s recovery status.');
  }
});

// --- Repository -------------------------------------------------------------

/**
 * The repository this node writes points to.
 *
 * A caller with only `stack:read` learns whether protection works and why not.
 * The locator, fingerprint and last check are configuration facts and need
 * `system:settings`, because they name a volume and an engine-side identity that
 * a read-only stack user has no business seeing. The password is never returned
 * by any shape.
 */
recoveryRouter.get('/repository', handle(async (req, res) => {
  if (!requireRecoveryPermission(req, res, 'stack:read')) return;
  const status = getLocalVolumeProtectionStatus();
  const active = RecoveryRepositoryStore.getInstance().getActive();
  const configured = authorizeStorageAccess(req, 'configure', null).allowed;
  const body: Record<string, unknown> = {
    health: status.state,
    reason: status.reason,
    failureDomain: active?.failureDomain ?? RECOVERY_FAILURE_DOMAIN,
    warning: SAME_FAILURE_DOMAIN_WARNING,
    initialized: active !== null,
  };
  if (configured) {
    body.repository = active
      ? {
          // The id is what `POST /locks/release` takes for a repository lock, so
          // the caller that may release one has to be able to read it.
          id: active.id,
          locator: active.locator,
          fingerprint: active.repositoryFingerprint,
          secretState: active.secretState,
          createdAt: active.createdAt,
          lastCheck: RecoveryPointStore.getInstance().latestRepositoryCheck(active.id),
        }
      : null;
  }
  res.json(body);
}));

/**
 * Provision this node's repository, or replace it.
 *
 * `system:settings` because it creates infrastructure every stack's data will
 * depend on. Idempotent: the same request may be repeated after a crash at any
 * step and continues instead of starting over.
 */
recoveryRouter.post('/repository', handle(async (req, res) => {
  if (!requireRecoveryPermission(req, res, 'system:settings')) return;
  const body = parseBody(repositoryBody, req.body);
  const result = await engineService(req).admitRepositoryInit({
    actor: actorOf(req),
    idempotencyKey: body.idempotencyKey,
    replace: body.replace === true,
    transport: req.machineAuthScope ?? 'local',
  });
  res.status(result.replayed ? 200 : 202).json({
    operation: result.operation,
    failureDomain: RECOVERY_FAILURE_DOMAIN,
    warning: SAME_FAILURE_DOMAIN_WARNING,
  });
}));

// --- Storage ----------------------------------------------------------------

/**
 * Which roots this node can protect, and whether each one is covered.
 *
 * With `?stack=`, the roots are that stack's declared volumes and the caller
 * needs `stack:read` on it. Without it, every volume on the node is considered
 * and each root is authorized against its own dependents.
 *
 * A root the caller may not read is reported as `inaccessible` with its name
 * withheld, and it still counts against the verdict: an unreadable root must
 * never make a partially protected stack read as protected.
 */
recoveryRouter.get('/storage', handle(async (req, res) => {
  // `?stack=` is one stack name. A repeated parameter (an array), a non-string
  // and a name that is not a stack directory name are refused instead of being
  // ignored, which would list every volume, or sent on to Compose, which would
  // fail with a `500`.
  const rawStack: unknown = req.query.stack;
  if (rawStack !== undefined && typeof rawStack !== 'string') throw new RecoveryError('invalid_request');
  const stackName = typeof rawStack === 'string' ? rawStack.trim() : '';
  if (stackName && !isValidStackName(stackName)) throw new RecoveryError('invalid_request');
  if (stackName) {
    if (!requireRecoveryPermission(req, res, 'stack:read', 'stack', stackName)) return;
  } else if (!requireRecoveryPermission(req, res, 'stack:read')) {
    return;
  }

  const nodeId = req.nodeId;
  const docker = DockerController.getInstance(nodeId).getDocker();
  const ownerNodeKey = await ownerNodeKeyFor(nodeId, docker);
  const knownStackNames = await knownStacksFor(nodeId);
  const status = getLocalVolumeProtectionStatus();

  // A stack that does not exist declares nothing: an empty answer, not an error.
  const names = stackName
    ? (knownStackNames.includes(stackName) ? await declaredVolumeNames(nodeId, stackName) : [])
    : (await listVolumeSources(docker)).map((source) => source.volumeName);

  const roots: unknown[] = [];
  const coverageInputs: RootCoverageInput[] = [];
  const now = Date.now();

  for (const name of names) {
    const source = await inspectVolumeSource(docker, name).catch(() => null);
    // A declared volume that does not exist yet is not storage.
    if (!source) continue;
    const resolution = await resolveVolumeDependents({
      nodeId,
      ownerNodeKey,
      knownStackNames,
      volumeName: name,
      volumeLabels: source.labels,
      // Listing never renders: a read may not pay for one Compose call per stack.
      render: false,
      docker,
    });
    const storageKey = deriveStorageKey(getRecoveryAuthorityId(), ownerNodeKey, 'named_volume', name);
    const authorized = authorizeStorageAccess(
      req,
      'read',
      resolution.kind === 'unrenderable' ? null : { storageKey, liveDependents: resolution.dependents },
    ).allowed;
    if (!authorized) {
      roots.push({ access: 'inaccessible' });
      coverageInputs.push({ storage: null, access: 'inaccessible', points: [], verifications: new Map() });
      continue;
    }
    if (!source.eligible) {
      roots.push({
        volumeName: name,
        eligible: false,
        ineligibleReason: source.ineligibleReason,
        reason: describeIneligible(source.ineligibleReason),
        coverage: 'unsupported' satisfies RootCoverageReason,
      });
      coverageInputs.push({ storage: null, access: 'unsupported', points: [], verifications: new Map() });
      continue;
    }

    const current = StorageIdentityStore.getInstance().getCurrent(storageKey);
    const activeRepositoryId = RecoveryRepositoryStore.getInstance().getActive()?.id ?? null;
    // Only the active repository counts: a replaced repository keeps its points
    // as evidence, and they stop describing what this node can restore.
    const points = current
      ? RecoveryPointStore.getInstance().listForStorageKey(storageKey)
        .filter((point) => activeRepositoryId !== null && point.repositoryId === activeRepositoryId)
      : [];
    const verifications = RecoveryPointStore.getInstance().verificationsForPoints(points.map((p) => p.id));
    // The listing never starts a helper, so it cannot re-read the volume's inode;
    // Docker's creation time is enough to see a volume that was deleted and
    // recreated, and its old points stop covering it at once instead of at the
    // next capture.
    const input: RootCoverageInput = {
      storage: current,
      access: 'supported',
      points,
      verifications,
      liveGenerationChanged: current !== null && !generationTokenMatchesVolume(current.generationToken, source.createdAt),
    };
    const evaluated = evaluateRootCoverage(input, now, ROOT_COVERAGE_FRESHNESS_MS);
    coverageInputs.push(input);
    roots.push({
      volumeName: name,
      storageId: current?.id ?? null,
      eligible: true,
      ineligibleReason: null,
      coverage: evaluated.reason,
      coveringPointId: evaluated.coveringPointId,
    });
  }

  const verdict = evaluateCoverage({ volumeProtection: status.state, roots: coverageInputs, now });
  res.json({ roots, verdict, capability: status });
}));

/** The volume names a stack's rendered model declares. */
async function declaredVolumeNames(nodeId: number, stackName: string): Promise<string[]> {
  const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
  if (result.rendered === null) return [];
  try {
    const model = parseEffectiveModel(JSON.parse(result.rendered), stackName);
    return [...new Set(Object.values(model.volumes).map((resource) => resource.name).filter(Boolean))];
  } catch {
    return [];
  }
}

/** The points of one storage, with their verifications, newest first. */
recoveryRouter.get('/storage/:storageId/points', handle(async (req, res) => {
  const storageId = paramOf(req, 'storageId');
  const storage = StorageIdentityStore.getInstance().getById(storageId);
  if (!storage) {
    if (!mayLearnIdIsUnknown(req, 'read')) {
      sendRecoveryError(res, 'permission_denied');
      return;
    }
    throw new RecoveryError('invalid_request');
  }
  const nodeId = req.nodeId;
  const docker = DockerController.getInstance(nodeId).getDocker();
  const ownerNodeKey = await ownerNodeKeyFor(nodeId, docker);
  const knownStackNames = await knownStacksFor(nodeId);
  // The volume may be gone (`down -v`, a prune): its points are still listable.
  const described = await describeStoredLocator({ docker, ownerNodeKey, locator: storage.locator });
  const resolution = await resolveVolumeDependents({
    nodeId,
    ownerNodeKey,
    knownStackNames,
    volumeName: storage.locator,
    volumeLabels: described.labels,
    render: false,
    docker,
  });
  const target = resolution.kind === 'unrenderable'
    ? null
    : { storageKey: storage.storageKey, liveDependents: resolution.dependents };
  if (!authorizeStorageAccess(req, 'read', target).allowed) {
    sendRecoveryError(res, 'permission_denied');
    return;
  }
  const points = RecoveryPointStore.getInstance().listForStorageKey(storage.storageKey);
  const verifications = RecoveryPointStore.getInstance().verificationsForPoints(points.map((p) => p.id));
  res.json({
    storage: {
      id: storage.id,
      locator: storage.locator,
      generation: storage.generation,
      state: storage.state,
    },
    points: points.map((point) => ({
      point,
      verifications: verifications.get(point.id) ?? [],
    })),
  });
}));

/**
 * Create a root point of one volume.
 *
 * Everything except the capture happens before the answer: eligibility,
 * readiness, dependents, authorization, the generation probe, the operation row
 * and the locks. A held or stale lock is a `409` here, not a background failure.
 */
recoveryRouter.post('/storage/points', handle(async (req, res) => {
  const body = parseBody(createPointBody, req.body);
  const result = await engineService(req).admitCreatePoint({
    nodeId: req.nodeId,
    volumeName: body.volumeName,
    actor: actorOf(req),
    idempotencyKey: body.idempotencyKey,
    requestDigest: sha256Digest(['create_point', body.volumeName]),
    transport: req.machineAuthScope ?? 'local',
    authorize: (context) => authorizeWith(req, 'protect')(context),
  });
  res.status(result.replayed ? 200 : 202).json({
    operation: result.operation,
    failureDomain: RECOVERY_FAILURE_DOMAIN,
    warning: SAME_FAILURE_DOMAIN_WARNING,
  });
}));

// --- Points -----------------------------------------------------------------

/** Verify a point. The check is repository-wide, and its result covers every point. */
recoveryRouter.post('/points/:pointId/verify', handle(async (req, res) => {
  const body = parseBody(verifyBody, req.body);
  const pointId = paramOf(req, 'pointId');
  const result = await engineService(req).admitVerify({
    nodeId: req.nodeId,
    pointId,
    actor: actorOf(req),
    idempotencyKey: body.idempotencyKey,
    requestDigest: sha256Digest(['verify_point', pointId, body.method ?? 'engine_check_metadata']),
    transport: req.machineAuthScope ?? 'local',
    method: body.method ?? 'engine_check_metadata',
    authorize: (context) => authorizeWith(req, 'protect')(context),
  });
  res.status(result.replayed ? 200 : 202).json({ operation: result.operation });
}));

/**
 * Restore a point into a new volume.
 *
 * The target must not exist, must not be Sencho's own, and must not use the
 * reserved recovery prefix. A name that starts with a known stack's Compose
 * project name would put data under that stack's own volume naming, so it also
 * needs `restore` access on that stack.
 *
 * Restoring over the point's own volume is a different operation with its own
 * confirmation, and it lives on `/overwrite` below.
 */
recoveryRouter.post('/points/:pointId/restore', handle(async (req, res) => {
  const body = parseBody(restoreBody, req.body);
  if (body.targetMode !== undefined && body.targetMode !== 'new_volume') {
    throw new RecoveryError('invalid_request', {
      reason: 'wrong_route',
      detail: body.targetMode === 'staged_overwrite'
        ? 'Restoring over a point\'s own volume needs the overwrite route, where you can review what stops first.'
        : 'Restoring to a host path is not available on this route.',
    });
  }
  const pointId = paramOf(req, 'pointId');
  const digest = sha256Digest(['restore', pointId, body.targetVolumeName, 'new_volume']);
  // A retry after a lost response has to reach this answer before the target
  // check below: by then the first attempt has created the volume it is about to
  // restore into, and reporting that as a new invalid request would leave the
  // caller with no way to find the operation that is actually running.
  const replay = RecoveryOperationStore.getInstance().findReplay({
    idempotencyKey: body.idempotencyKey,
    kind: 'restore',
    actor: actorOf(req),
    transport: req.machineAuthScope ?? 'local',
    requestDigest: digest,
    pointId,
  });
  if (replay) {
    res.status(200).json({ operation: replay });
    return;
  }
  // A reserved name would let a restore overwrite Sencho's own infrastructure,
  // and a name it never created is not a target it may write.
  if (body.targetVolumeName.startsWith(RECOVERY_RESERVED_PREFIX)
    || body.targetVolumeName.startsWith(RECOVERY_RESERVED_TARGET_PREFIX)) {
    throw new RecoveryError('invalid_request');
  }
  const result = await engineService(req).admitRestore({
    nodeId: req.nodeId,
    pointId,
    targetVolumeName: body.targetVolumeName,
    actor: actorOf(req),
    idempotencyKey: body.idempotencyKey,
    requestDigest: digest,
    transport: req.machineAuthScope ?? 'local',
    authorize: (context) => authorizeWith(req, 'restore')(context),
    authorizeCrossStack: (stackName) =>
      checkPermission(req, RECOVERY_ACCESS_ACTION.restore, 'stack', stackName),
    assertTargetAvailable: async () => {
      const docker = DockerController.getInstance(req.nodeId).getDocker();
      const existing = await inspectVolumeSource(docker, body.targetVolumeName).catch(() => null);
      if (existing) throw new RecoveryError('invalid_request');
    },
  });
  res.status(result.replayed ? 200 : 202).json({ operation: result.operation });
}));

// --- Browsing a saved point -------------------------------------------------

/**
 * Test seam: how long a download body may stall before it is stopped. Production
 * never sets this; the fixed bound is the documented one.
 */
let downloadIdleMsOverride: number | null = null;
export function setDownloadIdleMsForTests(ms: number | null): void {
  downloadIdleMsOverride = ms;
}

/**
 * A download's file name: an ASCII-only quoted fallback for old clients and the
 * RFC 5987 form for every other one. Node refuses a header value with a
 * character above Latin-1, so the fallback replaces anything outside printable
 * ASCII rather than throwing the whole answer away.
 */
function contentDisposition(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '');
  // `encodeURIComponent` leaves `'()*` alone; RFC 5987 does not allow them.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

/** The read input both routes give the engine, with the content-read rule. */
function pointReadInput(req: Request, path: string, signal: AbortSignal) {
  return {
    pointId: paramOf(req, 'pointId'),
    path,
    authorize: (target: PointContentReadTarget) => authorizePointContentRead(req, target),
    // An unknown id could have needed either access: the stack read of a live
    // volume or the floor of a detached one.
    mayLearnIdIsUnknown: () => mayLearnIdIsUnknown(req, 'read', 'configure'),
    signal,
  };
}

/** An abort controller tied to the client: closing the response stops the read. */
function abortOnClose(res: Response): { controller: AbortController; detach: () => void } {
  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', onClose);
  return { controller, detach: () => res.off('close', onClose) };
}

/**
 * One page of one directory of a saved point.
 *
 * Read-only and node-local: the node that owns the storage answers, so a hub
 * proxying the request authorizes nothing itself. `?path=` is absolute within
 * the point (`/` is the root) and `?offset=` pages through a large directory.
 * The answer carries the point's own evidence beside the entries, so a point
 * that skipped data, or whose check did not verify, is never shown as a clean
 * copy.
 */
recoveryRouter.get('/points/:pointId/browse', handle(async (req, res) => {
  const path = parsePointPath(req.query.path ?? '/');
  const offset = parsePageOffset(req.query.offset);
  const { controller, detach } = abortOnClose(res);
  try {
    res.json(await engineService(req).browsePoint({ ...pointReadInput(req, path, controller.signal), offset }));
  } finally {
    detach();
  }
}));

/**
 * Download one regular file out of a saved point.
 *
 * The bytes stream from the helper through this node to the caller, at the
 * caller's pace: memory stays flat however large the file is. A symlink, a
 * directory and a special file are refused before any byte moves. Headers are
 * sent with the first byte, so a dump that fails before it answers its own JSON
 * error. A client that disconnects cancels the helper, and a body that stops
 * moving for the idle bound is stopped. A run that ends after the headers for
 * any other reason breaks the connection, so a partial body is never read as a
 * whole one.
 */
recoveryRouter.get('/points/:pointId/download', handle(async (req, res) => {
  if (req.query.path === undefined) throw new RecoveryError('invalid_request');
  const path = parsePointPath(req.query.path);
  const { controller, detach } = abortOnClose(res);
  let abandoned = false;
  const abandon = (): void => {
    abandoned = true;
    controller.abort();
  };
  let idleTimer: NodeJS.Timeout | undefined;
  const stopIdleWatch = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const watchIdle = (): void => {
    stopIdleWatch();
    idleTimer = setTimeout(() => {
      console.warn('[Recovery] Download from point %s stopped: no byte moved within the idle bound', sanitizeForLog(paramOf(req, 'pointId')));
      abandon();
      if (!res.destroyed && !res.writableEnded) res.destroy();
    }, downloadIdleMsOverride ?? POINT_DOWNLOAD_IDLE_MS);
    idleTimer.unref?.();
  };
  let download: PointContentDownload | null = null;
  try {
    download = await engineService(req).prepareDownload(pointReadInput(req, path, controller.signal));
    const fileHeaders: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(download.entry.size),
      'Content-Disposition': contentDisposition(download.entry.name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'none',
    };
    // A HEAD answers the same headers and reads nothing: Node discards a body
    // for HEAD, so running the dump would read the whole file for no output.
    if (req.method === 'HEAD') {
      res.set(fileHeaders).end();
      return;
    }
    const commitHeaders = (): void => {
      if (!res.headersSent) res.set(fileHeaders);
    };

    watchIdle();
    let waitingForDrain = false;
    const result = await download.stream((chunk, control) => {
      // Nobody reads this response any more. The chunk is dropped rather than
      // the stream paused: a pause nobody resumes would keep the helper's
      // stream from ending, and the run, its container and its slot with it.
      if (abandoned || res.writableEnded || res.destroyed) return;
      commitHeaders();
      watchIdle();
      // One drain listener at a time: after the helper exits the runner ignores
      // pauses, so the tail can meet a full buffer several times in a row.
      if (!res.write(chunk) && !waitingForDrain) {
        waitingForDrain = true;
        control.pause();
        res.once('drain', () => {
          waitingForDrain = false;
          if (abandoned) return;
          watchIdle();
          control.resume();
        });
      }
    });
    if (abandoned) return;
    if (!result.ok) {
      // Nothing of the body was written, so the failure is answered as itself
      // (409 integrity_mismatch, 503 repository_unavailable). Once a byte is on
      // the wire, the handler breaks the connection instead.
      throw new RecoveryError(result.errorClass);
    }
    commitHeaders();
    res.end();
  } finally {
    stopIdleWatch();
    download?.release();
    detach();
  }
}));

// --- Restore over the existing volume ---------------------------------------

/**
 * What an overwrite would do, before anything is stopped.
 *
 * No side effects: no row, no Docker mutation, no helper container that writes.
 * The token in the answer is bound to the exact state described, so the overwrite
 * can only run against what the operator actually saw. Authorized like the
 * overwrite itself, because the answer names the stacks and containers it would
 * stop.
 */
recoveryRouter.post('/points/:pointId/overwrite/preview', handle(async (req, res) => {
  const preview = await engineService(req).previewOverwrite({
    pointId: paramOf(req, 'pointId'),
    actor: actorOf(req),
    transport: req.machineAuthScope ?? 'local',
    // A hub names the node it knows; a direct caller gets this instance's own.
    hubNode: req.hubNode,
    authorizeStack: (stackName) => checkPermission(req, RECOVERY_ACCESS_ACTION.restore, 'stack', stackName),
    authorizeGlobal: () => authorizeNodeWide(req, 'restore'),
  });
  res.json(preview);
}));

/**
 * Restore a point over its own volume.
 *
 * Three things gate the destructive part: the confirmation token recomputed from
 * the current state, the volume name typed back exactly, and `restore` access on
 * every dependent. A refusal writes nothing, so the same idempotency key can be
 * sent again once the operator has previewed and confirmed again.
 */
recoveryRouter.post('/points/:pointId/overwrite', handle(async (req, res) => {
  const body = parseBody(overwriteBody, req.body);
  const pointId = paramOf(req, 'pointId');
  const result = await engineService(req).admitOverwrite({
    pointId,
    confirmationToken: body.confirmationToken,
    confirmVolumeName: body.confirmVolumeName,
    actor: actorOf(req),
    idempotencyKey: body.idempotencyKey,
    // The token is part of the request identity: a re-confirmation after the
    // state moved is a different request, not a replay of the refused one.
    requestDigest: sha256Digest(['staged_overwrite', pointId, body.confirmationToken, body.confirmVolumeName]),
    transport: req.machineAuthScope ?? 'local',
    authorizeStack: (stackName) => checkPermission(req, RECOVERY_ACCESS_ACTION.restore, 'stack', stackName),
    authorizeGlobal: () => authorizeNodeWide(req, 'restore'),
  });
  res.status(result.replayed ? 200 : 202).json({
    operation: result.operation,
    intentId: result.intentId ?? null,
  });
}));

/**
 * Resolve a restore that did not settle.
 *
 * `retry` re-runs the reconciler, which reads the swap journal and is idempotent.
 * `release_fence` accepts the volume as it now is: it restores the recorded
 * restart policies, starts nothing, and is logged with the actor, because the
 * next thing that happens to that data is the operator's decision.
 */
recoveryRouter.post('/restores/:intentId/resolve', handle(async (req, res) => {
  const body = parseBody(resolveBody, req.body);
  const intentId = paramOf(req, 'intentId');
  const result = await engineService(req).resolveOverwrite({
    intentId,
    action: body.action,
    actor: actorOf(req),
    authorizeStack: (stackName) => checkPermission(req, RECOVERY_ACCESS_ACTION.restore, 'stack', stackName),
    authorizeGlobal: () => authorizeNodeWide(req, 'restore'),
  });
  res.json(result);
}));

// --- Operations -------------------------------------------------------------
/**
 * Boot parks every operation a dead process left as `completion_unknown`, then an
 * overwrite's own reconciler proves the volume committed or rolled back and the
 * operation takes that ending. Until boot has finished, the parked ending of an
 * overwrite is provisional, and reporting it would tell a client that a volume the
 * reconciler is about to prove is unprovable. Such a read answers like the routes
 * that wait for boot: `503`, ask again.
 */
function holdProvisionalEnding(req: Request, operation: RecoveryOperation): void {
  if (operation.kind !== 'restore' || operation.state !== 'completion_unknown' || operation.errorClass !== 'interrupted') return;
  if (!engineService(req).isSettlingAtBoot()) return;
  const intent = RestoreIntentStore.getInstance().getByOperation(operation.id);
  if (intent && intent.targetMode === 'staged_overwrite') {
    throw new RecoveryError('capability_unavailable', { reason: 'engine_starting' });
  }
}

/** The operation with its progress and whatever evidence it produced. */
recoveryRouter.get('/operations/:id', handle(async (req, res) => {
  const operation = RecoveryOperationStore.getInstance().get(paramOf(req, 'id'));
  if (!operation) {
    // A repository operation needs `configure`, so an unknown id is only reported
    // to a caller who could read every kind.
    if (!mayLearnIdIsUnknown(req, 'read', 'configure')) {
      sendRecoveryError(res, 'permission_denied');
      return;
    }
    throw new RecoveryError('invalid_request');
  }
  if (!authorizeOperation(req, operation, 'read')) {
    sendRecoveryError(res, 'permission_denied');
    return;
  }
  holdProvisionalEnding(req, operation);
  const progress = engineService(req).progressFor(operation.id);
  res.json({ operation, progress, result: operationResult(operation) });
}));

/** Ask a running operation to stop. Its point is settled first, then the operation. */
recoveryRouter.post('/operations/:id/cancel', handle(async (req, res) => {
  const operation = RecoveryOperationStore.getInstance().get(paramOf(req, 'id'));
  if (!operation) {
    if (!mayLearnIdIsUnknown(req, 'protect', 'restore', 'configure')) {
      sendRecoveryError(res, 'permission_denied');
      return;
    }
    throw new RecoveryError('invalid_request');
  }
  // Access first: the state of an operation is not reported to a caller who may not
  // touch it. A repository operation is held to `configure` by `authorizeOperation`.
  const access: RecoveryAccess = operation.kind === 'restore' ? 'restore' : 'protect';
  if (!authorizeOperation(req, operation, access)) {
    sendRecoveryError(res, 'permission_denied');
    return;
  }
  if (operation.kind === 'repository_init') {
    // A half-provisioned repository is settled by the next provision attempt, not
    // by an abort in the middle of volume creation.
    sendRecoveryError(res, 'not_cancellable', {}, 'A repository provisioning operation cannot be cancelled once it has started. The next provision request settles it.');
    return;
  }
  holdProvisionalEnding(req, operation);
  if (operation.kind === 'restore') {
    // An overwrite is cancellable while the live volume has not started to
    // change. From `swapping` on, the originals have begun moving and the only
    // safe outcomes are roll forward or reconciliation, never a stop.
    const intent = RestoreIntentStore.getInstance().getByOperation(operation.id);
    if (intent && intent.targetMode === 'staged_overwrite'
      && (intent.phase === 'swapping' || intent.phase === 'swapped')) {
      sendRecoveryError(res, 'not_cancellable', {}, 'This restore has passed the point where it can be rolled back safely and cannot be cancelled.');
      return;
    }
  }
  engineService(req).cancel(operation.id);
  res.status(202).json({ operation: RecoveryOperationStore.getInstance().get(operation.id) ?? operation });
}));

function operationResult(operation: RecoveryOperation): unknown {
  switch (operation.kind) {
    case 'create_point': {
      const point = RecoveryPointStore.getInstance().findBySourceOperation(operation.id);
      return { point };
    }
    case 'verify_point': {
      const point = operation.pointId ? RecoveryPointStore.getInstance().get(operation.pointId) : null;
      return {
        point: point ?? null,
        verifications: point ? RecoveryPointStore.getInstance().listVerifications(point.id) : [],
      };
    }
    case 'restore': {
      const intent = RestoreIntentStore.getInstance().getByOperation(operation.id);
      return {
        intent: intent
          ? {
              phase: intent.phase,
              targetVolume: intent.targetVolume,
              filesRestored: intent.filesRestored,
              bytesRestored: intent.bytesRestored,
              verified: intent.verified,
              xattrWarnings: intent.xattrWarnings,
            }
          : null,
        // An overwrite reports the durable facts a client needs to describe it
        // without reading a host path or the contents of the volume.
        restore: intent && intent.targetMode === 'staged_overwrite'
          ? {
              intentId: intent.id,
              mode: intent.targetMode,
              phase: intent.phase,
              fenceState: intent.fenceState,
              preRestorePointId: intent.preRestorePointId,
              stagedVerified: intent.verified,
              filesRestored: intent.filesRestored,
              bytesRestored: intent.bytesRestored,
              outcomeClass: intent.outcomeClass,
            }
          : null,
      };
    }
    case 'repository_init': {
      const active = RecoveryRepositoryStore.getInstance().getActive();
      return {
        repository: active
          ? {
              locator: active.locator,
              fingerprint: active.repositoryFingerprint,
              lastCheck: RecoveryPointStore.getInstance().latestRepositoryCheck(active.id),
            }
          : null,
      };
    }
  }
}

/** The access an operation's kind requires, checked against its storage. */
function authorizeOperation(req: Request, operation: RecoveryOperation, access: RecoveryAccess): boolean {
  if (operation.kind === 'repository_init') return authorizeStorageAccess(req, 'configure', null).allowed;
  if (!operation.storageId) return authorizeStorageAccess(req, access, null).allowed;
  const storage = StorageIdentityStore.getInstance().getById(operation.storageId);
  if (!storage) return authorizeStorageAccess(req, access, null).allowed;
  // The stored dependent set, without a Compose render: this is a read of work
  // already recorded, not a decision to change data.
  const dependents = [...StorageIdentityStore.getInstance().listDependents(storage.storageKey)];
  // An overwrite is also held to the stacks its fence stopped: cancelling it
  // rolls back and starts those containers, and a stack that has since dropped
  // the volume is no longer in the stored set.
  const intent = operation.kind === 'restore' ? RestoreIntentStore.getInstance().getByOperation(operation.id) : null;
  if (intent && intent.targetMode === 'staged_overwrite') {
    const scope = overwriteIntentScope(intent, RestoreFenceStore.getInstance());
    if (scope.unowned && !authorizeNodeWide(req, access)) return false;
    for (const stackName of scope.stacks) dependents.push({ stackName, serviceName: null });
  }
  return authorizeStorageAccess(req, access, { storageKey: storage.storageKey, liveDependents: dependents }).allowed;
}

// --- Locks ------------------------------------------------------------------

/**
 * Release a stale lock after review.
 *
 * A stale lock means an interrupted operation may have left a restore half
 * written. Releasing it is a reviewed act, so it is not automatic for a storage
 * lock, except that a restore over an existing volume releases its own once its
 * reconciliation has proven the volume (boot releases the repository lock of
 * interrupted work once the previous helpers are gone). A live lock belongs to
 * its owner and cannot be released here. The storage key resolves to its
 * dependents, so the same access that could restore is the access that may
 * reopen the storage.
 */
recoveryRouter.post('/locks/release', handle(async (req, res) => {
  const body = parseBody(lockReleaseBody, req.body);
  if (body.scope === 'repository') {
    if (!requireRecoveryPermission(req, res, 'system:settings')) return;
  } else {
    const current = StorageIdentityStore.getInstance().getCurrent(body.resourceKey);
    if (!current) {
      if (!mayLearnIdIsUnknown(req, 'restore')) {
        sendRecoveryError(res, 'permission_denied');
        return;
      }
      throw new RecoveryError('invalid_request');
    }
    const nodeId = req.nodeId;
    const docker = DockerController.getInstance(nodeId).getDocker();
    const ownerNodeKey = await ownerNodeKeyFor(nodeId, docker);
    const knownStackNames = await knownStacksFor(nodeId);
    const described = await describeStoredLocator({ docker, ownerNodeKey, locator: current.locator });
    const resolution = await resolveVolumeDependents({
      nodeId,
      ownerNodeKey,
      knownStackNames,
      volumeName: current.locator,
      volumeLabels: described.labels,
      render: true,
      docker,
    });
    const target = resolution.kind === 'unrenderable'
      ? null
      : { storageKey: current.storageKey, liveDependents: resolution.dependents };
    if (!authorizeStorageAccess(req, 'restore', target).allowed) {
      sendRecoveryError(res, 'permission_denied');
      return;
    }
  }

  // The lock of an interrupted overwrite is stale only until the reconciler that is
  // still running proves the volume, and it releases the lock itself when it does.
  if (engineService(req).isSettlingAtBoot()) throw new RecoveryError('capability_unavailable', { reason: 'engine_starting' });

  try {
    const released = RecoveryOperationStore.getInstance().releaseStaleLock(
      body.scope,
      body.resourceKey,
      actorOf(req),
    );
    res.json({ released });
  } catch (err) {
    const errorClass = classifyRecoveryError(err);
    if (errorClass === 'invalid_request') {
      // Distinguish "no lock at all" from "the lock is live and owned".
      const live = RecoveryOperationStore.getInstance().getLock(body.scope, body.resourceKey);
      sendRecoveryError(res, live && live.staleSince === null ? 'lock_held' : 'invalid_request');
      return;
    }
    throw err;
  }
}));

/** Exported for the tests that assert the error contract. */
export { isRecoveryErrorClass };

import { randomUUID } from 'crypto';
import { readNodeProxyJson } from '../../helpers/nodeProxyJson';
import { sanitizeForLog } from '../../utils/safeLog';
import { resolveRemoteRecoveryRead } from './capability';
import { RECOVERY_OPERATION_HEADER } from './dispatcher';
import {
  VOLUME_PROTECTION_CAPABILITY,
  VOLUME_PROTECTION_CAPABILITY_VERSION,
} from './types';
import type { PointReadKind, RecoveryErrorClass, RestoreMode, VolumeProtectionStatus } from './types';

/**
 * One answer to "can this remote node run recovery work", used by everything
 * that needs it: the proxy preflight on a mutating request and the hub's own
 * descriptor read. Two call sites asking the same question with two code paths
 * is how a node ends up described one way in the UI and refused another way on
 * the wire.
 *
 * The answer is cached for 30 seconds per node, so a poll that reads several
 * recovery surfaces does not pay a descriptor round trip each time, and a node
 * that just came up is picked up quickly.
 *
 * A node reporting `unavailable / engine_not_installed` is an older build: every
 * build that can answer this question has the engine. It reads as
 * `update_required / node_contract_older` here, so the operator is told to update
 * the node rather than told the feature does not exist.
 */

export const RECOVERY_SUPPORT_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  expiresAt: number;
  status: VolumeProtectionStatus;
  /** What the node says it can execute, or null when the read did not say. */
  restoreModes: RestoreMode[] | null;
  /** The point reads the node serves, or null when the read did not say. */
  pointReads: PointReadKind[] | null;
}

const cache = new Map<number, CacheEntry>();

/** Test seam: forget every cached answer. */
export function resetRemoteRecoverySupportCacheForTests(): void {
  cache.clear();
}

const KEY = { capability: VOLUME_PROTECTION_CAPABILITY, version: VOLUME_PROTECTION_CAPABILITY_VERSION } as const;

const UPDATE_REQUIRED: VolumeProtectionStatus = { ...KEY, state: 'update_required', reason: 'node_contract_older' };

/**
 * The status the hub acts on. Same as the descriptor resolution, with the one
 * addition that a node with no engine is an older build.
 */
function normalizeRemoteStatus(status: VolumeProtectionStatus): VolumeProtectionStatus {
  if (status.state === 'unavailable' && status.reason === 'engine_not_installed') return UPDATE_REQUIRED;
  return status;
}

export interface RecoverySupportRead {
  operationId: string;
  status: VolumeProtectionStatus;
  /** The restore shapes the node advertised, or null when the read did not say. */
  restoreModes: RestoreMode[] | null;
  /** The point reads the node advertised, or null when the read did not say. */
  pointReads: PointReadKind[] | null;
  fetchedAt: number;
}

/**
 * Resolve a remote node's recovery support, from cache when it is fresh. Never
 * throws: a transport failure is an answer, because every caller is deciding what
 * to tell an operator rather than what to do to data.
 */
export async function resolveRemoteRecoverySupport(
  nodeId: number,
  now: () => number = Date.now,
): Promise<RecoverySupportRead> {
  const cached = cache.get(nodeId);
  const at = now();
  if (cached && cached.expiresAt > at) {
    return {
      operationId: randomUUID(),
      status: cached.status,
      restoreModes: cached.restoreModes,
      pointReads: cached.pointReads,
      fetchedAt: at,
    };
  }
  const operationId = randomUUID();
  const read = await readNodeProxyJson({
    nodeId,
    path: '/api/recovery/node',
    timeoutMs: 5_000,
    logLabel: 'recovery node descriptor',
    headers: { [RECOVERY_OPERATION_HEADER]: operationId },
  });
  const echoed = read.kind === 'ok' && read.data && typeof read.data === 'object'
    ? (read.data as Record<string, unknown>).operationId
    : undefined;
  let status: VolumeProtectionStatus;
  let restoreModes: RestoreMode[] | null;
  let pointReads: PointReadKind[] | null;
  if (read.kind === 'ok' && echoed !== operationId) {
    // An answer to some other dispatch, or from a hop that drops the header, is
    // not evidence about this one.
    console.warn(
      '[Recovery] Node %s answered the descriptor read without this dispatch\'s operation id (sent %s, got %s)',
      nodeId, operationId, typeof echoed === 'string' ? sanitizeForLog(echoed).slice(0, 64) : String(echoed),
    );
    status = { ...KEY, state: 'unknown', reason: 'descriptor_mismatch' };
    restoreModes = null;
    pointReads = null;
  } else {
    const resolved = resolveRemoteRecoveryRead(read);
    status = normalizeRemoteStatus(resolved.status);
    // A node reported as an older build is not asked what it can execute.
    restoreModes = status === resolved.status ? resolved.restoreModes : null;
    pointReads = status === resolved.status ? resolved.pointReads : null;
  }
  cache.set(nodeId, { expiresAt: at + RECOVERY_SUPPORT_CACHE_TTL_MS, status, restoreModes, pointReads });
  return { operationId, status, restoreModes, pointReads, fetchedAt: at };
}

export type RecoveryPreflight =
  | { ok: true; status: VolumeProtectionStatus }
  | { ok: false; httpStatus: 409 | 503; code: string; errorClass: RecoveryErrorClass; message: string };

/**
 * The preflight a mutating recovery request must pass before it reaches a remote
 * node. It can only refuse: a node that says it is available is trusted to answer
 * for itself, including answering `503` while its engine is still starting.
 *
 * `requiredMode` narrows the question to one restore shape. A node that is
 * otherwise healthy but never advertised that shape is an older build for this
 * request, and `409 UPDATE_REQUIRED` is what the operator is told instead of a
 * destructive request the node would refuse halfway through.
 *
 * `requiredRead` does the same for a point read: a node that never advertised
 * it has no such route, and would answer a browse with a bare 404.
 */
export async function preflightRecoveryRequest(
  nodeId: number,
  requiredMode?: RestoreMode,
  requiredRead?: PointReadKind,
): Promise<RecoveryPreflight> {
  const { status, restoreModes, pointReads } = await resolveRemoteRecoverySupport(nodeId);
  if (requiredRead !== undefined && pointReads !== null && !pointReads.includes(requiredRead)) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'UPDATE_REQUIRED',
      errorClass: 'update_required',
      message: 'This node needs an update before it can browse or download the contents of a recovery point.',
    };
  }
  if (requiredMode !== undefined && restoreModes !== null && !restoreModes.includes(requiredMode)) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'UPDATE_REQUIRED',
      errorClass: 'update_required',
      message: requiredMode === 'staged_overwrite'
        ? 'This node needs an update before it can restore over an existing volume.'
        : 'This node needs an update before it can run this restore.',
    };
  }
  if (status.state === 'available') return { ok: true, status };
  if (status.state === 'unavailable') {
    // The node has the engine and will answer with its own reason, which the
    // operator can act on. Never pre-empted here.
    return { ok: true, status };
  }
  if (status.state === 'update_required') {
    return {
      ok: false,
      httpStatus: 409,
      code: 'UPDATE_REQUIRED',
      errorClass: 'update_required',
      message: 'This node needs an update before it can protect volumes.',
    };
  }
  switch (status.reason) {
    case 'node_unreachable':
      return {
        ok: false,
        httpStatus: 503,
        code: 'TRANSPORT_UNREACHABLE',
        errorClass: 'transport_unreachable',
        message: 'The node could not be reached.',
      };
    case 'node_refused':
      return {
        ok: false,
        httpStatus: 503,
        code: 'NODE_REFUSED',
        errorClass: 'node_refused',
        message: 'The node refused the request.',
      };
    case 'node_error':
      return {
        ok: false,
        httpStatus: 503,
        code: 'NODE_ERROR',
        errorClass: 'node_error',
        message: 'The node could not answer the request.',
      };
    default:
      return {
        ok: false,
        httpStatus: 503,
        code: 'NODE_DESCRIPTOR_INVALID',
        errorClass: 'internal',
        message: 'The node answered with a recovery status this build cannot read.',
      };
  }
}

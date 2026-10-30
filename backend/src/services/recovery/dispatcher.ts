import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { DatabaseService, type Node } from '../DatabaseService';
import { readNodeProxyJson } from '../../helpers/nodeProxyJson';
import {
  buildLocalRecoveryNodeDescriptor,
  resolveRemoteVolumeProtection,
} from './capability';
import { sanitizeForLog } from '../../utils/safeLog';
import { VOLUME_PROTECTION_CAPABILITY, VOLUME_PROTECTION_CAPABILITY_VERSION } from './types';
import type { RecoveryErrorClass, RecoveryTransport, VolumeProtectionStatus } from './types';

const descriptorMismatch: VolumeProtectionStatus = {
  capability: VOLUME_PROTECTION_CAPABILITY,
  version: VOLUME_PROTECTION_CAPABILITY_VERSION,
  state: 'unknown',
  reason: 'descriptor_mismatch',
};

/** Why a status is not the node's own answer, read from the state first. */
function errorClassFor(status: VolumeProtectionStatus): RecoveryErrorClass | null {
  switch (status.state) {
    case 'available':
    case 'unavailable':
      return null;
    case 'update_required':
      return 'update_required';
    case 'unknown':
      switch (status.reason) {
        case 'node_unreachable': return 'transport_unreachable';
        case 'node_refused': return 'node_refused';
        case 'node_error': return 'node_error';
        case 'descriptor_invalid':
        case 'descriptor_mismatch': return 'internal';
      }
  }
}

/**
 * Where recovery work for a node runs, and how the hub learns about it.
 *
 * Recovery executes on the node that owns the data. A user request for a
 * remote node reaches that node's own `/api/recovery/*` routes through the
 * transparent proxy (direct API or Pilot tunnel), where the node authorizes and
 * runs it. The hub's own reads about a node go through here: in process for the
 * local node, and over the same proxy target for a remote one, so the direct
 * API and Pilot paths share one code path. Only parsed, whitelisted metadata
 * comes back; bytes never transit the hub.
 */

/** Header carrying the dispatch's operation id to the node, which echoes it back. */
export const RECOVERY_OPERATION_HEADER = 'x-sencho-recovery-operation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function transportForNode(node: Pick<Node, 'type' | 'mode'>): RecoveryTransport {
  if (node.type !== 'remote') return 'local';
  return node.mode === 'pilot_agent' ? 'pilot_tunnel' : 'node_proxy';
}

/** The transport a request arrived over, as the executing node sees it. */
export function transportOfRequest(req: Pick<Request, 'machineAuthScope'>): RecoveryTransport {
  return req.machineAuthScope ?? 'local';
}

/** The operation id a dispatch sent, when it is a well-formed one. */
export function operationIdFromRequest(req: Pick<Request, 'get'>): string | null {
  const value = req.get(RECOVERY_OPERATION_HEADER);
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

export interface RecoveryNodeStatusResult {
  operationId: string;
  nodeId: number;
  /** Null when the node is not known to this instance. */
  transport: RecoveryTransport | null;
  volumeProtection: VolumeProtectionStatus;
  /** Why the status is not the node's own answer, or null when it is. */
  errorClass: RecoveryErrorClass | null;
  observedAt: number;
}

const DESCRIPTOR_TIMEOUT_MS = 5_000;

/** The volume-protection status of one node, as this instance can establish it. */
export async function readRecoveryNodeStatus(nodeId: number, now: () => number = Date.now): Promise<RecoveryNodeStatusResult> {
  const operationId = randomUUID();
  const node = DatabaseService.getInstance().getNode(nodeId);
  if (!node) {
    return {
      operationId, nodeId, transport: null, errorClass: 'invalid_request', observedAt: now(),
      volumeProtection: resolveRemoteVolumeProtection({ kind: 'no_target' }),
    };
  }
  const transport = transportForNode(node);
  if (transport === 'local') {
    return {
      operationId, nodeId, transport, errorClass: null, observedAt: now(),
      volumeProtection: buildLocalRecoveryNodeDescriptor().volumeProtection,
    };
  }

  const read = await readNodeProxyJson({
    nodeId,
    path: '/api/recovery/node',
    timeoutMs: DESCRIPTOR_TIMEOUT_MS,
    logLabel: 'recovery node descriptor',
    headers: { [RECOVERY_OPERATION_HEADER]: operationId },
  });
  let volumeProtection: VolumeProtectionStatus;
  const echoed = read.kind === 'ok' && read.data && typeof read.data === 'object'
    ? (read.data as Record<string, unknown>).operationId
    : undefined;
  if (read.kind === 'ok' && echoed !== operationId) {
    // An answer to some other dispatch (crossed or replayed), or from a hop that
    // drops the header, is not evidence about this one. Logged, because a hop
    // that always strips the header would otherwise fail without a trace.
    console.warn(
      '[Recovery] Node %d answered the descriptor read without this dispatch\'s operation id (sent %s, got %s)',
      nodeId, operationId, typeof echoed === 'string' ? sanitizeForLog(echoed).slice(0, 64) : String(echoed),
    );
    volumeProtection = { ...descriptorMismatch };
  } else {
    volumeProtection = resolveRemoteVolumeProtection(read);
  }
  const errorClass = errorClassFor(volumeProtection);
  return { operationId, nodeId, transport, volumeProtection, errorClass, observedAt: now() };
}

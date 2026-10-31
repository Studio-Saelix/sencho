import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { DatabaseService, type Node } from '../DatabaseService';
import { buildLocalRecoveryNodeDescriptor, resolveRemoteVolumeProtection } from './capability';
import { resolveRemoteRecoverySupport } from './remoteSupport';
import type { RecoveryErrorClass, RecoveryTransport, VolumeProtectionStatus } from './types';

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
export { RECOVERY_OPERATION_HEADER, operationIdFromRequest } from './operationHeader';

export function transportForNode(node: Pick<Node, 'type' | 'mode'>): RecoveryTransport {
  if (node.type !== 'remote') return 'local';
  return node.mode === 'pilot_agent' ? 'pilot_tunnel' : 'node_proxy';
}

/** The transport a request arrived over, as the executing node sees it. */
export function transportOfRequest(req: Pick<Request, 'machineAuthScope'>): RecoveryTransport {
  return req.machineAuthScope ?? 'local';
}

/** The operation id a dispatch sent, when it is a well-formed one. */

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

  // The same resolution the proxy preflight uses, so the hub cannot describe a
  // node one way and refuse it another. Cached per node for 30 s.
  const support = await resolveRemoteRecoverySupport(nodeId, now);
  return {
    operationId: support.operationId,
    nodeId,
    transport,
    volumeProtection: support.status,
    errorClass: errorClassFor(support.status),
    observedAt: support.fetchedAt,
  };
}

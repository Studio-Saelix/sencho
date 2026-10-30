import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { DatabaseService, type Node } from '../DatabaseService';
import { readNodeProxyJson } from '../../helpers/nodeProxyJson';
import {
  buildLocalRecoveryNodeDescriptor,
  resolveRemoteVolumeProtection,
} from './capability';
import type { RecoveryErrorClass, RecoveryTransport, VolumeProtectionStatus } from './types';

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
  // An answer to some other dispatch (a replayed or crossed response) is not
  // evidence about this one.
  const echoed = read.kind === 'ok' && read.data && typeof read.data === 'object'
    ? (read.data as Record<string, unknown>).operationId
    : undefined;
  const checked = read.kind === 'ok' && echoed !== operationId
    ? { kind: 'ok' as const, data: null }
    : read;
  const volumeProtection = resolveRemoteVolumeProtection(checked);
  let errorClass: RecoveryErrorClass | null = null;
  if (volumeProtection.reason === 'node_unreachable') errorClass = 'transport_unreachable';
  else if (volumeProtection.state === 'update_required') errorClass = 'update_required';
  else if (volumeProtection.reason === 'descriptor_invalid') errorClass = 'internal';
  return { operationId, nodeId, transport, volumeProtection, errorClass, observedAt: now() };
}

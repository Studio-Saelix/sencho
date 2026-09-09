import { NodeRegistry } from '../services/NodeRegistry';
import { CROSS_NODE_RBAC_CAPABILITY, type RemoteMetaProbe } from '../services/CapabilityRegistry';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

// In-flight probes deduped per node+capability so concurrent checks for
// different capabilities on the same node cannot share the wrong boolean.
const inFlight = new Map<string, Promise<boolean>>();

function probeKey(nodeId: number, capability: string): string {
  return `${nodeId}:${capability}`;
}

/**
 * Whether a remote node advertises a given capability. Probes the remote's live
 * /api/meta on every call (concurrent calls for the same node+capability share
 * one probe).
 *
 * Fails closed: unsupported, offline, or unreachable remotes return false.
 */
export async function remoteAdvertisesCapability(nodeId: number, capability: string): Promise<boolean> {
  const key = probeKey(nodeId, capability);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const probe = (async (): Promise<boolean> => {
    try {
      const meta = await NodeRegistry.getInstance().fetchMetaForNode(nodeId);
      return meta.capabilities.includes(capability);
    } catch (err) {
      console.warn(
        `[RemoteCapability] Could not verify "${capability}" for node ${nodeId}; treating as unsupported:`,
        getErrorMessage(err, 'unknown'),
      );
      return false;
    }
  })();

  inFlight.set(key, probe);
  try {
    return await probe;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Whether a remote node advertises cross-node RBAC enforcement for proxied
 * requests. Thin wrapper over {@link remoteAdvertisesCapability}.
 */
export async function remoteSupportsCrossNodeRbac(nodeId: number): Promise<boolean> {
  return remoteAdvertisesCapability(nodeId, CROSS_NODE_RBAC_CAPABILITY);
}

export type RemoteCapabilityProbe =
  | { kind: 'supported' }
  | { kind: 'unsupported' }
  | { kind: 'unreachable'; detail: Exclude<RemoteMetaProbe['kind'], 'ok'> };

/**
 * Tri-state capability check for a remote node: whether it advertises a given
 * capability, is reachable but does not advertise it, or is unreachable.
 * Both unsupported and unreachable pass delivery through, but the skip is
 * logged under a different structured code (CAPABILITY_UNSUPPORTED vs
 * REGISTRY_DELIVERY_TARGET_UNREACHABLE), so the tri-state keeps an operator
 * from misreading an outage as a missing capability. The unreachable detail
 * carries the raw probe kind (no_target, transport_failure, http_failure,
 * malformed) so an operator can tell a missing proxy target from a network
 * outage. Only a reachable remote that does not advertise the capability is
 * unsupported.
 */
export async function probeRemoteCapability(
  nodeId: number,
  capability: string,
): Promise<RemoteCapabilityProbe> {
  try {
    const probe = await NodeRegistry.getInstance().probeRemoteMeta(nodeId);
    if (probe.kind !== 'ok') {
      return { kind: 'unreachable', detail: probe.kind };
    }
    return probe.meta.capabilities.includes(capability)
      ? { kind: 'supported' }
      : { kind: 'unsupported' };
  } catch (error) {
    // Fail closed to unreachable. probeRemoteMeta classifies network failures
    // internally, but an unexpected throw must not escape and 500 a deploy;
    // the delivery refusal matrix treats this as a no-attempt passthrough.
    console.warn(
      '[RemoteCapability] Could not probe capability for node; treating as unreachable:',
      sanitizeForLog(nodeId),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return { kind: 'unreachable', detail: 'transport_failure' };
  }
}

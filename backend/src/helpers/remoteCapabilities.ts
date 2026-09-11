import { NodeRegistry } from '../services/NodeRegistry';
import { CROSS_NODE_RBAC_CAPABILITY, type RemoteMeta } from '../services/CapabilityRegistry';
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

/**
 * Fetch the raw typed meta for a remote node, or null when the node cannot be
 * reached (no proxy target, or the /api/meta request failed). Callers that need
 * only a boolean and accept fail-closed semantics should prefer
 * {@link remoteAdvertisesCapability}.
 */
async function probeRemoteMeta(nodeId: number): Promise<RemoteMeta | null> {
  try {
    const meta = await NodeRegistry.getInstance().fetchMetaForNode(nodeId);
    return meta.online ? meta : null;
  } catch (error) {
    // Fail closed to unreachable. fetchMetaForNode already returns offline meta
    // for a network failure, but an unexpected throw must not escape and 500 a
    // deploy; the delivery refusal matrix treats this as a no-attempt passthrough.
    console.warn(
      '[RemoteCapability] Could not probe meta for node; treating as unreachable:',
      sanitizeForLog(nodeId),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return null;
  }
}

export type RemoteCapabilityProbe = 'supported' | 'unsupported' | 'unreachable';

/**
 * Tri-state capability check for a remote node: whether it advertises a given
 * capability, is reachable but does not advertise it, or is unreachable.
 * Both unsupported and unreachable pass delivery through, but the skip is
 * logged under a different structured code (CAPABILITY_UNSUPPORTED vs
 * REGISTRY_DELIVERY_TARGET_UNREACHABLE), so the tri-state keeps an operator
 * from misreading an outage as a missing capability.
 */
export async function probeRemoteCapability(
  nodeId: number,
  capability: string,
): Promise<RemoteCapabilityProbe> {
  const meta = await probeRemoteMeta(nodeId);
  if (!meta) return 'unreachable';
  return meta.capabilities.includes(capability) ? 'supported' : 'unsupported';
}

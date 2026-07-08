import { NodeRegistry } from '../services/NodeRegistry';
import { CROSS_NODE_RBAC_CAPABILITY } from '../services/CapabilityRegistry';
import { getErrorMessage } from '../utils/errors';

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

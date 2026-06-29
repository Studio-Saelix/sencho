import { NodeRegistry } from '../services/NodeRegistry';
import { CROSS_NODE_RBAC_CAPABILITY } from '../services/CapabilityRegistry';
import { getErrorMessage } from '../utils/errors';

// In-flight probes deduped per node so a burst of concurrent gated requests
// shares one /api/meta round-trip. The entry is dropped as soon as it settles,
// so the NEXT request re-probes. The verdict is deliberately NOT cached across
// requests: a remote can be replaced by older code at the same URL (a rollback
// or image pin), and a stale "supported" verdict would reopen the cross-node
// escalation, so each gated action re-verifies against the live remote.
const inFlight = new Map<number, Promise<boolean>>();

/**
 * Whether a remote node advertises that it enforces cross-node RBAC: the
 * forwarded actor role on HTTP requests and the exact-stack allowlist on
 * stop-by-label. Probes the remote's live /api/meta on every call (concurrent
 * calls for the same node share one probe).
 *
 * Fails closed: a remote that does not advertise the capability, that cannot be
 * read (offline/unreachable, which yields empty capabilities), or that errors
 * is treated as unsupported, so the caller denies rather than risk escalating a
 * non-admin request or over-stopping. Because the probe is live, a remote
 * downgraded to older code is detected on the next gated action rather than
 * trusted until a cache expires.
 */
export async function remoteSupportsCrossNodeRbac(nodeId: number): Promise<boolean> {
  const existing = inFlight.get(nodeId);
  if (existing) return existing;

  const probe = (async (): Promise<boolean> => {
    try {
      const meta = await NodeRegistry.getInstance().fetchMetaForNode(nodeId);
      // Check the advertised capability directly. An offline/unreadable remote
      // yields OFFLINE_META with empty capabilities, so this already fails
      // closed; keying off the capability (not the version) also correctly
      // trusts a reachable remote whose version string is non-semver, e.g. a
      // 0.0.0-dev image, but that genuinely advertises the capability.
      return meta.capabilities.includes(CROSS_NODE_RBAC_CAPABILITY);
    } catch (err) {
      console.warn(
        `[CrossNodeRBAC] Could not verify capability for node ${nodeId}; treating as unsupported:`,
        getErrorMessage(err, 'unknown'),
      );
      return false;
    }
  })();

  inFlight.set(nodeId, probe);
  try {
    return await probe;
  } finally {
    inFlight.delete(nodeId);
  }
}

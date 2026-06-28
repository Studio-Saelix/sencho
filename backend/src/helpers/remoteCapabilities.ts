import { CacheService } from '../services/CacheService';
import { NodeRegistry } from '../services/NodeRegistry';
import { CROSS_NODE_RBAC_CAPABILITY, type RemoteMeta } from '../services/CapabilityRegistry';
import { REMOTE_META_NAMESPACE } from './cacheInvalidation';
import { getErrorMessage } from '../utils/errors';

// Mirrors the node-meta endpoint's TTL and shares its `remote-meta:<id>` cache
// key, so a recent /api/nodes/:id/meta read warms this check and vice versa.
const REMOTE_META_CACHE_TTL = 3 * 60 * 1000;

/**
 * Whether a remote node advertises that it enforces cross-node RBAC: the
 * forwarded actor role on HTTP requests and the exact-stack allowlist on
 * stop-by-label. Reads the shared remote-meta cache, fetching once on a cold
 * miss.
 *
 * Fails closed: when the capability cannot be established (an un-upgraded
 * remote, or a cold cache whose meta fetch fails) it returns false, so the
 * caller denies rather than risk escalating a non-admin request or over-stopping
 * on an un-upgraded node. A node previously cached as supported may be served
 * that value while a later refresh is failing (getOrFetch serves stale on
 * error); that is safe because capabilities are append-only and a request to an
 * unreachable node fails at the transport regardless.
 */
export async function remoteSupportsCrossNodeRbac(nodeId: number): Promise<boolean> {
  try {
    const meta = await CacheService.getInstance().getOrFetch<RemoteMeta>(
      `${REMOTE_META_NAMESPACE}:${nodeId}`,
      REMOTE_META_CACHE_TTL,
      async () => {
        const fetched = await NodeRegistry.getInstance().fetchMetaForNode(nodeId);
        if (fetched.version === null) throw new Error('Remote meta fetch returned null version');
        return fetched;
      },
    );
    return meta.capabilities.includes(CROSS_NODE_RBAC_CAPABILITY);
  } catch (err) {
    console.warn(
      `[CrossNodeRBAC] Could not determine capability for node ${nodeId}; treating as unsupported:`,
      getErrorMessage(err, 'unknown'),
    );
    return false;
  }
}

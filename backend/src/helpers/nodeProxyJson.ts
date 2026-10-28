import axios from 'axios';
import { NodeRegistry } from '../services/NodeRegistry';
import { LicenseService } from '../services/LicenseService';
import { PROXY_TIER_HEADER } from '../services/license-headers';
import { safeAxiosTransport } from '../utils/outboundTarget';
import { sanitizeForLog } from '../utils/safeLog';

/**
 * A JSON read from another Sencho instance, over the node's proxy target.
 *
 * A remote node's Docker daemon and compose directory are not reachable from
 * here, so every fact about what a remote node is running comes from the node's
 * own routes. This is that one read: resolve the target (a direct API URL for a
 * proxied node, the tunnel's loopback bridge for a pilot), authenticate the way
 * node-to-node reads do, and classify the answer so a caller can tell an old
 * node that does not serve the route from one that could not answer right now.
 *
 * Never throws: a transport failure is an outcome, because every caller here is
 * reading evidence and must degrade rather than fail the operation it observes.
 */
export type NodeProxyJsonRead =
  | { kind: 'ok'; data: unknown }
  /** No proxy target exists for this node (proxy mode without credentials, or no live tunnel). */
  | { kind: 'no_target' }
  /** The node answered 404: it does not serve this route, so it is an older build. */
  | { kind: 'route_missing' }
  | { kind: 'http'; status: number }
  | { kind: 'transport'; detail: string };

export async function readNodeProxyJson(args: {
  nodeId: number;
  /** Absolute path on the node, including the `/api` prefix. */
  path: string;
  timeoutMs: number;
  /** Names the read in warnings, e.g. 'remote platform read'. */
  logLabel: string;
  headers?: Record<string, string>;
}): Promise<NodeProxyJsonRead> {
  try {
    const target = NodeRegistry.getInstance().getProxyTarget(args.nodeId);
    if (!target) {
      console.warn(
        '[NodeProxyRead] No proxy target for %s on node %s',
        args.logLabel,
        args.nodeId,
      );
      return { kind: 'no_target' };
    }
    const proxy = LicenseService.getInstance().getProxyHeaders();
    const url = `${target.apiUrl.replace(/\/$/, '')}${args.path}`;
    const res = await axios.get(url, {
      ...safeAxiosTransport(target.trustedLoopback),
      headers: {
        Authorization: `Bearer ${target.apiToken}`,
        [PROXY_TIER_HEADER]: proxy.tier,
        'Content-Type': 'application/json',
        ...args.headers,
      },
      timeout: args.timeoutMs,
      validateStatus: () => true,
    });
    if (res.status === 200) return { kind: 'ok', data: res.data };
    if (res.status === 404) return { kind: 'route_missing' };
    console.warn(
      '[NodeProxyRead] %s returned %s on node %s',
      args.logLabel,
      res.status,
      args.nodeId,
    );
    return { kind: 'http', status: res.status };
  } catch (err) {
    // Everything above is inside this catch on purpose: callers are poll timers
    // and observers, where an escaping rejection is an unhandled rejection
    // rather than a verdict.
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      '[NodeProxyRead] %s failed on node %s: %s',
      args.logLabel,
      args.nodeId,
      sanitizeForLog(detail),
    );
    return { kind: 'transport', detail };
  }
}

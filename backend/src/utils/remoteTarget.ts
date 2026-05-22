import type { Node } from '../services/DatabaseService';

/**
 * Returns the operator-facing error message for a remote node that has
 * no reachable proxy target. Pilot-mode rows get a tunnel-aware message;
 * proxy-mode rows fall back to the historical credentials-missing copy.
 *
 * Use whenever `NodeRegistry.getProxyTarget(node.id)` returns null and
 * the caller needs to surface why the dispatch was skipped.
 */
export function formatNoTargetError(node: Pick<Node, 'mode' | 'name'>): string {
  return node.mode === 'pilot_agent'
    ? `Pilot tunnel to "${node.name}" is disconnected. Operations resume when the agent reconnects.`
    : 'Remote node not configured';
}

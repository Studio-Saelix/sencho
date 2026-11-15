import { DatabaseService, type Node, type NodeBootstrapOperationState, type NodeReadinessState } from '../services/DatabaseService';

/**
 * Node shape safe to send to a browser or API-token client. The stored
 * `api_token` (a long-lived node_proxy Bearer credential) is never serialized;
 * callers that need to know whether a token is configured read `has_token`
 * instead. The plaintext credential stays server-side, read via
 * `DatabaseService.getNode` by the components that genuinely need it (for
 * example the remote proxy, the connection test, and the mesh dialer).
 */
export type PublicNode = Omit<Node, 'api_token'> & {
  has_token: boolean;
  /** Hub-pinned registry sealing-key fingerprint, or null when unset. */
  sealingKeyFingerprint: string | null;
  /**
   * Set only for a node the bootstrap registered: whether the hub verified it
   * is ready for deployments, and the state of the run that registered it.
   * Null for every other node, whose status keeps its usual meaning.
   */
  readiness: {
    state: NodeReadinessState;
    checkedAt: number | null;
    operationId: string | null;
    operationState: NodeBootstrapOperationState | null;
  } | null;
};

/** Project a stored Node into its client-safe form, dropping the api_token. */
export function toPublicNode(node: Node): PublicNode {
  const { api_token, ...rest } = node;
  const db = DatabaseService.getInstance();
  const pin = db.getNodeSealingKey(node.id);
  const readiness = db.getNodeReadiness(node.id);
  const operationState = readiness?.operation_id ? db.getNodeBootstrapOperationState(readiness.operation_id) : undefined;
  return {
    ...rest,
    has_token: typeof api_token === 'string' && api_token.length > 0,
    sealingKeyFingerprint: pin?.fingerprint ?? null,
    readiness: readiness ? {
      state: readiness.state,
      checkedAt: readiness.checked_at,
      operationId: readiness.operation_id,
      operationState: operationState ?? null,
    } : null,
  };
}

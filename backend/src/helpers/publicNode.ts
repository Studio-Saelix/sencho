import type { Node } from '../services/DatabaseService';

/**
 * Node shape safe to send to a browser or API-token client. The stored
 * `api_token` (a long-lived node_proxy Bearer credential) is never serialized;
 * callers that need to know whether a token is configured read `has_token`
 * instead. The plaintext credential stays server-side, read via
 * `DatabaseService.getNode` by the components that genuinely need it (for
 * example the remote proxy, the connection test, and the mesh dialer).
 */
export type PublicNode = Omit<Node, 'api_token'> & { has_token: boolean };

/** Project a stored Node into its client-safe form, dropping the api_token. */
export function toPublicNode(node: Node): PublicNode {
  const { api_token, ...rest } = node;
  return { ...rest, has_token: typeof api_token === 'string' && api_token.length > 0 };
}

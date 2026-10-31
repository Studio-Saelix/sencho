/**
 * Why a node-scoped read failed.
 *
 * The gateway bounds an interactive read against a remote node, so a node that
 * accepts the connection and then goes silent now answers 504 with a marker
 * header instead of holding the page. That answer has to stay distinguishable
 * from every other way a read can fail, because the pages treat them
 * differently: a timeout is retryable and says the node is not answering, an
 * authorization failure is the operator's permissions, a 404 from an older node
 * means the surface does not exist there, and a confirmed empty answer is not a
 * failure at all.
 */
export type RemoteReadFailure =
  | 'timeout'
  | 'unreachable'
  | 'unauthorized'
  | 'unsupported'
  | 'http'
  | 'error';

/**
 * Set by the gateway on the 504 it synthesizes when an interactive read misses
 * its deadline. Kept in sync with `REMOTE_READ_TIMEOUT_HEADER` in
 * `backend/src/proxy/interactiveRemoteRead.ts`.
 */
export const REMOTE_READ_TIMEOUT_HEADER = 'x-sencho-read-timeout';

/** Classify a failed read, or return null when the response is a success. */
export function classifyRemoteReadFailure(res: Response): RemoteReadFailure | null {
  if (res.ok) return null;
  if (res.status === 504 && res.headers.get(REMOTE_READ_TIMEOUT_HEADER) === '1') return 'timeout';
  if (res.status === 502 || res.status === 503) return 'unreachable';
  if (res.status === 401 || res.status === 403) return 'unauthorized';
  if (res.status === 404) return 'unsupported';
  return 'http';
}

/**
 * One plain sentence for a failed read, naming the node the operator selected.
 * `http` keeps the status so an unexpected answer is still visible; every other
 * kind is a state the operator can act on.
 */
export function remoteReadFailureMessage(
  failure: RemoteReadFailure,
  options: { nodeName?: string | null; status?: number } = {},
): string {
  const name = options.nodeName?.trim();
  switch (failure) {
    case 'timeout':
      return `${name ? `"${name}"` : 'This node'} did not answer in time. It is unreachable or still starting.`;
    case 'unreachable':
      return `${name ? `"${name}"` : 'This node'} is unreachable. Check that Sencho is running on that host.`;
    case 'unauthorized':
      return `You do not have access to this data on ${name ? `"${name}"` : 'this node'}.`;
    case 'unsupported':
      return 'This node does not serve this data. Update the node to see it.';
    case 'http':
      return `The node answered with ${options.status ?? 'an error'}.`;
    case 'error':
      return 'The request failed before the node answered.';
  }
}

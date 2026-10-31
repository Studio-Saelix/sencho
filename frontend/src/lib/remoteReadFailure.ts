/**
 * Why a node-scoped read failed.
 *
 * The gateway bounds an interactive read against a remote node, so a node that
 * accepts the connection and then goes silent now answers 504 with a marker
 * header instead of holding the page. That answer has to stay distinguishable
 * from every other way a read can fail, because the pages treat them
 * differently: a timeout is retryable and says the node did not answer in time,
 * an authorization failure is the operator's grants, a rejected node credential
 * is the hub's stored token rather than the operator's session, a 404 from an
 * older node means the surface does not exist there, and a confirmed empty
 * answer is not a failure at all.
 *
 * The gateway marks the cause it established on answers whose status alone
 * would mislead (a 503 for a node that answered but could not be verified). A
 * marked cause is used as-is; unmarked answers fall back to the status.
 */
export type RemoteReadFailure =
  | 'timeout'
  | 'unreachable'
  | 'unauthorized'
  | 'node-credential'
  | 'unverified'
  | 'not-configured'
  | 'pilot-disconnected'
  | 'refused'
  | 'unsupported'
  | 'http'
  | 'error';

/**
 * Set by the gateway on the 504 it synthesizes when an interactive read misses
 * its deadline. Kept in sync with `REMOTE_READ_TIMEOUT_HEADER` in
 * `backend/src/proxy/interactiveRemoteRead.ts`.
 */
export const REMOTE_READ_TIMEOUT_HEADER = 'x-sencho-read-timeout';

/**
 * Set by the gateway on a synthesized answer whose status alone would name the
 * wrong cause. Kept in sync with `REMOTE_READ_FAILURE_HEADER` in
 * `backend/src/proxy/interactiveRemoteRead.ts`.
 */
export const REMOTE_READ_FAILURE_HEADER = 'x-sencho-read-failure';

const MARKED_FAILURES: ReadonlySet<string> = new Set<RemoteReadFailure>([
  'timeout',
  'unreachable',
  'unauthorized',
  'node-credential',
  'unverified',
  'not-configured',
  'pilot-disconnected',
  'refused',
  'unsupported',
]);

/** Classify a failed read, or return null when the response is a success. */
export function classifyRemoteReadFailure(res: Response): RemoteReadFailure | null {
  if (res.ok) return null;
  if (res.status === 504 && res.headers.get(REMOTE_READ_TIMEOUT_HEADER) === '1') return 'timeout';
  const marked = res.headers.get(REMOTE_READ_FAILURE_HEADER);
  if (marked !== null && MARKED_FAILURES.has(marked)) return marked as RemoteReadFailure;
  // A 401 forwarded from a remote carries the proxy sentinel: the remote
  // rejected the hub's stored node token, not the operator's own session.
  if (res.status === 401 && res.headers.get('x-sencho-proxy') === '1') return 'node-credential';
  // A 502/503 that carries the sentinel came from the remote itself, so the
  // node answered with an error; one without it is the hub failing to reach
  // the node. Only the latter is unreachable.
  if ((res.status === 502 || res.status === 503) && res.headers.get('x-sencho-proxy') === '1') return 'http';
  if (res.status === 502 || res.status === 503) return 'unreachable';
  if (res.status === 401 || res.status === 403) return 'unauthorized';
  if (res.status === 404) return 'unsupported';
  return 'http';
}

/**
 * A failure that means the node itself could not be read: it missed the
 * gateway deadline or could not be reached. These are the two causes a page
 * names outright and retries, as opposed to an answer the node did give.
 */
export function isUnreadableNode(failure: RemoteReadFailure | 'auth-abort' | undefined | null): boolean {
  return failure === 'timeout' || failure === 'unreachable';
}

/**
 * Classify a read that threw instead of returning. `apiFetch` throws on 401
 * before the caller sees the response, so the response it attached to the error
 * is the only way to keep an authorization failure distinct from a transport
 * failure.
 */
export function classifyRemoteReadError(error: unknown): RemoteReadFailure {
  const response = (error as { response?: unknown } | null | undefined)?.response;
  if (response instanceof Response) return classifyRemoteReadFailure(response) ?? 'error';
  return 'error';
}

/**
 * One plain sentence for a failed read, naming the node the operator selected.
 * Each cause gets the fix it actually needs: a timeout states only that the
 * read did not answer in time, a rejected node credential points at the stored
 * token, and an unverified capability does not claim the node was silent.
 * `http` keeps the status so an unexpected answer is still visible.
 */
export function remoteReadFailureMessage(
  failure: RemoteReadFailure,
  options: { nodeName?: string | null; status?: number } = {},
): string {
  const name = options.nodeName?.trim();
  const subject = name ? `"${name}"` : 'This node';
  switch (failure) {
    case 'timeout':
      return `${subject} did not answer in time. Try again in a moment.`;
    case 'unreachable':
      return `${subject} is unreachable. Check that Sencho is running on that host.`;
    case 'unauthorized':
      return `You do not have access to this data on ${name ? `"${name}"` : 'this node'}.`;
    case 'node-credential':
      return `The stored credential for ${subject} was rejected. Update the node's API token in Settings → Nodes.`;
    case 'unverified':
      return `${subject}'s permission model could not be verified. Try again shortly.`;
    case 'not-configured':
      return `${subject} has no API URL or token configured. Update it in Settings → Nodes.`;
    case 'pilot-disconnected':
      return `The Pilot tunnel to ${subject} is disconnected. It resumes when the agent reconnects.`;
    case 'refused':
      return `The hub refused ${subject}'s address. Check the node's API URL.`;
    case 'unsupported':
      return 'This node does not serve this data. Update the node to see it.';
    case 'http':
      return `The node answered with ${options.status ?? 'an error'}.`;
    case 'error':
      return 'The request failed before it completed. Try again.';
  }
}

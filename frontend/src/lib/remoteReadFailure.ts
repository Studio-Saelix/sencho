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
 * A failure that means the hub has no readable path to the node: it missed the
 * gateway deadline, could not be reached, its Pilot tunnel is down, it has no
 * target configured, or the hub refused its address. These are the causes a
 * page names outright and retries, as opposed to an answer the node did give.
 *
 * Every surface that reports whether a node is readable (Home, the stack list,
 * the Resources sibling fallback) asks this one question. A page that words a
 * region's own failure uses `isNamedReadFailure` instead, which also covers the
 * causes about access and credentials. `unverified` is deliberately absent: that node answered, and its
 * permission model is the thing that could not be read.
 */
export type UnreadableNodeFailure =
  | 'timeout'
  | 'unreachable'
  | 'pilot-disconnected'
  | 'not-configured'
  | 'refused';

export function isUnreadableNode(
  failure: RemoteReadFailure | 'auth-abort' | undefined | null,
): failure is UnreadableNodeFailure {
  return failure === 'timeout'
    || failure === 'unreachable'
    || failure === 'pilot-disconnected'
    || failure === 'not-configured'
    || failure === 'refused';
}

/** A cause that has its own operator-facing copy, as opposed to the two
 *  catch-alls (`http` and `error`) that fall back to a status or a retry line. */
export function isNamedReadFailure(
  failure: RemoteReadFailure | null | undefined,
): failure is Exclude<RemoteReadFailure, 'http' | 'error'> {
  return failure != null && failure !== 'http' && failure !== 'error';
}

/**
 * One line for a Home headline that has no health to report. The two silent
 * causes keep the dashboard's own sentence, which is what the phone and desktop
 * bars already promise; every other cause the gateway established about the
 * node gets its own copy, so a disconnected Pilot or an unconfigured node is
 * never described as a node that did not answer.
 */
export function unreadableNodeHeadline(
  failure: RemoteReadFailure | null | undefined,
  nodeName?: string | null,
): string {
  if (failure == null || failure === 'timeout' || failure === 'unreachable') {
    return 'This node is not answering.';
  }
  return remoteReadFailureMessage(failure, { nodeName });
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
 * A node-scoped read that answered with a non-2xx status, carrying the cause
 * the gateway established. A region loader throws this so the page that owns
 * the region can name why the read failed instead of only that it did.
 */
export class RemoteReadHttpError extends Error {
  readonly endpoint: string;
  readonly status: number;
  readonly failure: RemoteReadFailure;

  constructor(endpoint: string, status: number, failure: RemoteReadFailure) {
    super(`${endpoint} responded ${status}`);
    this.name = 'RemoteReadHttpError';
    this.endpoint = endpoint;
    this.status = status;
    this.failure = failure;
  }
}

/** Throw a `RemoteReadHttpError` for a non-2xx answer; return for a success. */
export function assertReadOk(res: Response, endpoint: string): void {
  if (res.ok) return;
  throw new RemoteReadHttpError(endpoint, res.status, classifyRemoteReadFailure(res) ?? 'http');
}

/** The cause behind any error a node-scoped read rejected with. */
export function remoteReadFailureOf(error: unknown): RemoteReadFailure {
  return error instanceof RemoteReadHttpError ? error.failure : classifyRemoteReadError(error);
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
  // Mid-sentence copy cannot start with a capital when the node is unnamed.
  const target = name ? `"${name}"` : 'this node';
  switch (failure) {
    case 'timeout':
      return `${subject} did not answer in time. Try again in a moment.`;
    case 'unreachable':
      return `${subject} is unreachable. Check that Sencho is running on that host.`;
    case 'unauthorized':
      return `You do not have access to this data on ${target}.`;
    case 'node-credential':
      return `The stored credential for ${target} was rejected. Update the node's API token in Settings → Nodes.`;
    case 'unverified':
      return `${subject}'s permission model could not be verified. Try again shortly.`;
    case 'not-configured':
      return `${subject} has no API URL or token configured. Update it in Settings → Nodes.`;
    case 'pilot-disconnected':
      return `The Pilot tunnel to ${target} is disconnected. It resumes when the agent reconnects.`;
    case 'refused':
      return `The hub refused ${target}'s address. Check the node's API URL.`;
    case 'unsupported':
      return 'This node does not serve this data. Update the node to see it.';
    case 'http':
      return `The node answered with ${options.status ?? 'an error'}.`;
    case 'error':
      return 'The request failed before it completed. Try again.';
  }
}

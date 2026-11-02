/**
 * Bounded lifetime for an interactive read against a remote node.
 *
 * A remote node the operator selected can accept a TCP connection and then
 * never answer: a dropped route, a hung kernel, a half-open network path. Node
 * http keeps that socket open, so without a deadline the hop stays pending for
 * as long as the transport allows and the page that awaited it stays on its
 * loading state with no error to show.
 *
 * Five seconds is the point where an operator stops trusting a loading page. It
 * sits under the client-side backstop the stack list and dashboard already
 * carry (eight seconds), so the gateway's answer is normally the one the page
 * sees. The budget bounds the time to the remote's response headers, not the
 * whole transfer: once the headers land the deadline is released and a separate
 * idle-stall bound takes over, so a healthy remote that is slow to finish a body
 * is never cut off.
 *
 * Routes the codebase already knows are slow to answer (a df over a large image
 * store, a volume-browser helper-image pull, a full resources inventory) get a
 * longer time-to-headers budget instead of the five-second one. Cutting those
 * off would label a healthy node as silent. A node that never answers is still
 * bounded by the longer budget.
 *
 * This is a read deadline only. Deploys, updates, pulls, restores, exports,
 * event streams, and log tails keep their own lifetimes: they are work, not
 * hydration, and the page is not waiting on them to draw itself. The verb check
 * and the exclusions below are what keep them out.
 */
export const INTERACTIVE_REMOTE_READ_TIMEOUT_MS = 5_000;

/**
 * Time-to-headers budget for a read the codebase knows can legitimately take
 * longer than the interactive default. It still bounds a black-holed node, just
 * at the scale of the work the route does.
 */
export const SLOW_REMOTE_READ_TIMEOUT_MS = 30_000;

/**
 * How long a response body may go without a byte once its headers have arrived.
 * This is an idle bound, not a total-time cap: a large body trickling over a
 * slow link keeps resetting it, while a transfer that stopped mid-flight is
 * ended instead of holding both sockets open forever.
 */
export const REMOTE_READ_BODY_IDLE_TIMEOUT_MS = 15_000;

/**
 * Marks a gateway-synthesized answer that replaced a read which hit the
 * deadline. The body also carries `code`, but the frontend classifies from the
 * header so it can tell a timeout from a plain 504 without consuming the body a
 * caller still has to read.
 */
export const REMOTE_READ_TIMEOUT_HEADER = 'x-sencho-read-timeout';

export const REMOTE_READ_TIMEOUT_CODE = 'remote_read_timeout';

/**
 * Machine-readable cause on a gateway-synthesized answer whose status alone
 * would be misread (a 503 for a node that answered but could not be verified,
 * a 503 for a node with no configured target). The frontend maps the value to
 * copy, so a reachable node is never described as unreachable. Values are kept
 * in sync with `RemoteReadFailure` in `frontend/src/lib/remoteReadFailure.ts`.
 */
export const REMOTE_READ_FAILURE_HEADER = 'x-sencho-read-failure';

/**
 * Reads that are not hydration and must keep their own lifetime even though
 * they are GETs.
 *
 * Two families:
 *  - streams, which are meant to stay open (log tails and activity feeds);
 *  - downloads, which do real work (enumerate a tree, pack a tarball, fetch an
 *    object) before the first byte and then copy a file body.
 *
 * This list is the first of two guards, not the only one: the hop also releases
 * the deadline as soon as the remote's response headers say the answer is a
 * stream or an attachment, so a route this list does not name is still exempt
 * from the moment its headers land. Naming the known ones here means a slow
 * first byte on a log tail or a large export is never cut short either. Paths
 * here are post-`/api` strip, matching the dispatcher.
 */
const LONG_LIVED_READS: ReadonlyArray<RegExp> = [
  // Server-sent events.
  /^\/metrics\/logs\/global\/stream\/?$/,
  /^\/mesh\/activity\/stream\/?$/,
  /^\/containers\/[^/]+\/logs\/?$/,
  // Downloads and exports.
  /^\/audit-log\/export\/?$/,
  /^\/cloud-backup\/object\/[^/]+\/download\/?$/,
  /^\/scheduled-tasks\/[^/]+\/runs\/export\/?$/,
  /^\/security\/vex\/export\/?$/,
  /^\/security\/scans\/[^/]+\/sarif\/?$/,
  /^\/stacks\/[^/]+\/files\/download\/?$/,
  /^\/stacks\/[^/]+\/files\/bulk-download\/?$/,
];

/**
 * Interactive reads that are slow by design and get the longer budget above.
 * Each one shells out to Docker or pulls a helper image before it can answer,
 * which can legitimately take tens of seconds on a large host. The longer
 * budget still bounds a node that never answers; it does not replace the
 * route's own work, so this list is about how long the page may wait, not about
 * cancelling the operation.
 */
const SLOW_READS: ReadonlyArray<RegExp> = [
  // `docker system df`, which can take many seconds on a large containerd store.
  /^\/system\/docker-df\/?$/,
  // The full resources inventory, including the volume df section.
  /^\/system\/resources\/?$/,
  // The volume browser: may pull a helper image on first use.
  /^\/volumes\/[^/]+\/(?:list|stat|read)\/?$/,
  // Import scan and update preview walk a repository / inspect images.
  /^\/stacks\/import\/scan\/?$/,
  /^\/stacks\/[^/]+\/update-preview\/?$/,
];

/**
 * True when this request is an ordinary interactive read: a GET whose answer the
 * UI needs to draw a page, and not one of the long-lived reads above.
 */
export function isInteractiveRemoteRead(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const pathname = path.split('?')[0];
  return !LONG_LIVED_READS.some(pattern => pattern.test(pathname));
}

/**
 * The time-to-headers budget for this read, or null when it is not bounded
 * (a non-read verb or a long-lived stream/download).
 */
export function remoteReadTimeoutMs(method: string, path: string): number | null {
  if (!isInteractiveRemoteRead(method, path)) return null;
  const pathname = path.split('?')[0];
  return SLOW_READS.some(pattern => pattern.test(pathname))
    ? SLOW_REMOTE_READ_TIMEOUT_MS
    : INTERACTIVE_REMOTE_READ_TIMEOUT_MS;
}

/**
 * True when the remote's own response says it is a stream or a download. Used to
 * release the deadline at the first byte, so a read that turned out to be a
 * stream or a file body is never cut short.
 */
export function isStreamingOrDownloadResponse(headers: {
  'content-type'?: string | string[];
  'content-disposition'?: string | string[];
}): boolean {
  const contentType = headers['content-type'];
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  if (typeof type === 'string' && type.toLowerCase().includes('text/event-stream')) return true;
  const disposition = headers['content-disposition'];
  const value = Array.isArray(disposition) ? disposition[0] : disposition;
  return typeof value === 'string' && value.toLowerCase().includes('attachment');
}

/**
 * The answer the gateway sends when an interactive read misses its deadline.
 * It states only what the gateway knows: the read did not answer inside the
 * budget. Whether the node is down, still starting, or slower than the budget
 * is not established here, so the copy does not claim one.
 */
export function remoteReadTimeoutBody(
  nodeName: string | undefined,
  timeoutMs: number = INTERACTIVE_REMOTE_READ_TIMEOUT_MS,
): {
  error: string;
  code: string;
  retryable: true;
} {
  const subject = nodeName ? `"${nodeName}"` : 'The selected node';
  return {
    error: `${subject} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
    code: REMOTE_READ_TIMEOUT_CODE,
    retryable: true,
  };
}

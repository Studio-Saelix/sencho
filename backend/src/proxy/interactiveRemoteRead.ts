/**
 * Bounded lifetime for an interactive read against a remote node.
 *
 * A remote node the operator selected can accept a TCP connection and then
 * never answer: a dropped route, a hung kernel, a half-open network path. Node
 * http keeps that socket open, so without a deadline the hop stays pending for
 * as long as the transport allows and the page that awaited it stays on its
 * loading state with no error to show.
 *
 * Five seconds is the point where an operator stops trusting the page. It sits
 * under the client-side backstop the stack list and dashboard already carry
 * (eight seconds), so the gateway's answer is normally the one the page sees,
 * and it matches the per-node budget the fleet reads use for the same reason, so
 * one product decision covers both.
 *
 * This is a read deadline only. Deploys, updates, pulls, restores, exports,
 * event streams, and log tails keep their own lifetimes: they are work, not
 * hydration, and the page is not waiting on them to draw itself. The verb check
 * and the exclusions below are what keep them out.
 */
export const INTERACTIVE_REMOTE_READ_TIMEOUT_MS = 5_000;

/**
 * Marks a gateway-synthesized answer that replaced a read which hit the
 * deadline. The body also carries `code`, but the frontend classifies from the
 * header so it can tell a timeout from a plain 504 without consuming the body a
 * caller still has to read.
 */
export const REMOTE_READ_TIMEOUT_HEADER = 'x-sencho-read-timeout';

export const REMOTE_READ_TIMEOUT_CODE = 'remote_read_timeout';

/**
 * Reads that are not hydration and must keep their own lifetime even though
 * they are GETs.
 *
 * Two families:
 *  - streams, which are meant to stay open (log tails and activity feeds);
 *  - downloads, which do real work (enumerate a tree, pack a tarball, fetch an
 *    object) before the first byte and then copy a file body.
 *
 * The last item is a safety net rather than a route list: the hop also clears
 * the deadline as soon as the remote's response headers arrive, so any stream
 * or attachment this list does not name is still exempt from the moment its
 * headers land. Paths here are post-`/api` strip, matching the dispatcher.
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
 * True when this request is an ordinary interactive read: a GET whose answer the
 * UI needs to draw a page, and not one of the long-lived reads above.
 */
export function isInteractiveRemoteRead(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const pathname = path.split('?')[0];
  return !LONG_LIVED_READS.some(pattern => pattern.test(pathname));
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
  if (typeof type === 'string' && type.includes('text/event-stream')) return true;
  const disposition = headers['content-disposition'];
  const value = Array.isArray(disposition) ? disposition[0] : disposition;
  return typeof value === 'string' && value.includes('attachment');
}

/** The answer the gateway sends when an interactive read misses its deadline. */
export function remoteReadTimeoutBody(nodeName: string | undefined): {
  error: string;
  code: string;
  retryable: true;
} {
  const subject = nodeName ? `"${nodeName}"` : 'The selected node';
  return {
    error: `${subject} did not answer within ${Math.round(INTERACTIVE_REMOTE_READ_TIMEOUT_MS / 1000)} seconds. The node is unreachable or still starting.`,
    code: REMOTE_READ_TIMEOUT_CODE,
    retryable: true,
  };
}

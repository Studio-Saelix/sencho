import type { Request } from 'express';
import { NodeRegistry } from '../services/NodeRegistry';
import { sanitizeForLog } from '../utils/safeLog';

/** The subset of `Request` this module actually reads, so callers (and tests)
 * can pass a plain `{ headers, query }` object without a compiler-silencing
 * cast to the full Express `Request` shape. */
type NodeIdSourceRequest = Pick<Request, 'headers' | 'query'>;

function parseNodeId(raw: unknown, warnOnMalformed: boolean): number | null {
  if (raw === undefined || raw === null || raw === '') return null;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const n = parseInt(trimmed, 10);
    // The round-trip check rejects what parseInt would otherwise accept as a
    // numeric prefix: a trailing suffix ("5abc"), and a duplicate header,
    // which Node folds into one comma-joined string ("1, 2").
    if (Number.isInteger(n) && n > 0 && String(n) === trimmed) return n;
  }

  // Present but malformed (or an array-style `?nodeId=1&nodeId=2`) is a client
  // bug: warn so the fall-back to the default node is observable instead of a
  // request silently landing on the wrong node during debugging.
  if (warnOnMalformed) {
    console.warn(`[ResolveNodeId] Ignoring malformed node id "${sanitizeForLog(raw)}"; using the default node.`);
  }
  return null;
}

/**
 * Resolve the effective node id for a request from the `x-node-id` header,
 * `?nodeId=` query param, or the default node, in that order. This is the
 * single source of truth for "which node does this request target": every
 * middleware that needs to know must call this rather than re-deriving the
 * answer from a subset of the same inputs.
 *
 * `warnOnMalformed` logs malformed header/query ids. Callers that resolve
 * purely to make an internal decision (e.g. whether to skip JSON parsing)
 * should leave it off so the warning fires once, from the middleware that
 * owns `req.nodeId`.
 */
export function resolveNodeId(
  req: NodeIdSourceRequest,
  opts: { warnOnMalformed?: boolean } = {},
): number {
  const warn = opts.warnOnMalformed === true;
  return (
    parseNodeId(req.headers['x-node-id'], warn) ??
    parseNodeId(req.query.nodeId, warn) ??
    NodeRegistry.getInstance().getDefaultNodeId()
  );
}

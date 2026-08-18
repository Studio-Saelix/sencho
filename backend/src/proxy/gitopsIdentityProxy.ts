import type { IncomingMessage } from 'http';
import type { Readable } from 'stream';
import zlib from 'zlib';
import type { Request } from 'express';
import { isRecord } from '../services/gitops/json';
import { classifyHistoryRow, classifySourceRow } from '../services/gitops/readAuth';
import type { GitOpsReadRequirement } from '../services/gitops/readAuth';
import { sanitizeForLog } from '../utils/safeLog';

/**
 * Ceiling on one decompressed identity response, in bytes.
 *
 * These four routes return configuration and audit pages, not payloads. A
 * remote answering with more than this is either misbehaving or not the
 * endpoint we think it is, and buffering it whole to rewrite node ids would
 * hand a remote instance a way to exhaust hub memory.
 */
export const IDENTITY_PROXY_MAX_BYTES = 1048576;

/**
 * How long this hop waits on a remote before giving up, in milliseconds.
 *
 * A remote that sends response headers and then stalls emits no end, no error,
 * and no abort, so without a bound the hop would never settle and would pin the
 * buffered body and both sockets for as long as the connection stayed open.
 */
export const IDENTITY_PROXY_TIMEOUT_MS = 30000;

const HISTORY_ROUTES = [
  /^\/git-sources\/history\/?$/,
  /^\/stacks\/[^/]+\/git-source\/history\/?$/,
];

/**
 * Paths whose JSON carries node identities this hub has to correct.
 *
 * The history pair is spread in rather than repeated, so the two lists
 * cannot drift into disagreeing about what counts as history.
 */
const IDENTITY_ROUTES = [
  /^\/git-sources\/?$/,
  /^\/stacks\/[^/]+\/git-source\/?$/,
  ...HISTORY_ROUTES,
];

/**
 * Whether this request is one of the four GETs the hub rewrites.
 *
 * Deliberately narrow. Logs, downloads, and event streams must keep flowing
 * through the streaming hop: buffering them to rewrite identities they do not
 * carry would break streaming and cap responses that are legitimately large.
 */
export function isGitOpsIdentityJsonRoute(pathname: string, method: string): boolean {
  if (method !== 'GET') return false;
  return IDENTITY_ROUTES.some(pattern => pattern.test(pathname));
}

export function isGitOpsHistoryRoute(pathname: string): boolean {
  return HISTORY_ROUTES.some(pattern => pattern.test(pathname));
}

/**
 * Replace a remote's node id with the id this hub knows it by.
 *
 * A remote instance numbers its own nodes from one and has never heard of the
 * hub's numbering, so every id it reports is a statement in its own namespace.
 * Left alone, a hub joining two nodes would show two different machines as the
 * same node.
 *
 * Only JSON numbers are replaced. A null is preserved, because "no node" is a
 * fact the remote is entitled to state and inventing a node there would claim a
 * placement that does not exist. Non-enumerated keys and every string field
 * (application ids, stack names) are left exactly as received.
 */
function rewriteNodeId(container: unknown, nodeId: number): void {
  if (!isRecord(container)) return;
  if (typeof container.nodeId === 'number') container.nodeId = nodeId;
}

function rewriteTargets(container: unknown, nodeId: number): void {
  if (!isRecord(container)) return;
  const targets = container.targets;
  if (Array.isArray(targets)) {
    for (const target of targets) rewriteNodeId(target, nodeId);
  }
  const drift = container.drift;
  if (Array.isArray(drift)) {
    for (const item of drift) {
      if (!isRecord(item)) continue;
      const affected = item.affectedTargets;
      if (Array.isArray(affected)) {
        for (const entry of affected) rewriteNodeId(entry, nodeId);
      }
    }
  }
}

/**
 * Rewrite every node id inside one revision projection or recorded delta.
 *
 * The top-level id is rewritten too. A projection does not carry one, but the
 * `before`/`after` deltas this also walks are an open record shape, so a delta
 * naming a node would otherwise reach the client in the remote's numbering.
 */
function rewriteRevision(revision: unknown, nodeId: number): void {
  if (!isRecord(revision)) return;
  rewriteNodeId(revision, nodeId);
  rewriteTargets(revision, nodeId);
}

/**
 * Rewrite the enumerated node-id positions in one parsed identity response.
 *
 * `gitopsRevisions` should not appear on these Direct Git routes; it is walked
 * anyway so a response that nests one is corrected rather than passed through
 * carrying a foreign node id.
 */
export function rewriteIdentityPayload(payload: unknown, nodeId: number): void {
  if (Array.isArray(payload)) {
    for (const row of payload) rewriteIdentityObject(row, nodeId);
    return;
  }
  if (!isRecord(payload)) return;
  const items = payload.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      rewriteIdentityObject(item, nodeId);
      if (!isRecord(item)) continue;
      rewriteRevision(item.before, nodeId);
      rewriteRevision(item.after, nodeId);
    }
    return;
  }
  rewriteIdentityObject(payload, nodeId);
}

function rewriteIdentityObject(row: unknown, nodeId: number): void {
  if (!isRecord(row)) return;
  rewriteNodeId(row, nodeId);
  rewriteTargets(row, nodeId);
  rewriteRevision(row.gitopsRevision, nodeId);
  const revisions = row.gitopsRevisions;
  if (Array.isArray(revisions)) {
    for (const revision of revisions) rewriteRevision(revision, nodeId);
  }
}

/**
 * Rework an identity request's query before it leaves the hub.
 *
 * Returns the query string to forward, or a refusal the hub answers itself.
 *
 * `gitopsLocalTarget` is synthesized here and nowhere else, so a caller-supplied
 * one is always stripped first: it instructs the remote to filter to its own
 * node, and a client that could set it would be steering another instance's
 * query.
 *
 * A history request naming the node being proxied to is asking for that node's
 * rows, which the remote can only express about itself, so the hub translates
 * it. A request naming a different node is refused rather than forwarded: the
 * remote would answer about itself and the page would look like an answer to a
 * question nobody asked.
 */
export function prepareIdentityQuery(
  search: URLSearchParams,
  pathname: string,
  hubNodeId: number | undefined,
): { kind: 'forward'; search: URLSearchParams } | { kind: 'refuse'; error: string } {
  const forwarded = new URLSearchParams(search);
  forwarded.delete('gitopsLocalTarget');
  const requestedNodeId = forwarded.get('nodeId');
  forwarded.delete('nodeId');

  if (!isGitOpsHistoryRoute(pathname)) return { kind: 'forward', search: forwarded };

  if (requestedNodeId !== null && (hubNodeId === undefined || requestedNodeId !== String(hubNodeId))) {
    return {
      kind: 'refuse',
      error: 'History for another node cannot be read through this node. Select that node instead.',
    };
  }
  // Set even when the caller named no node. A request routed to this node is a
  // question about this node, and the hub stamps one node id across every row
  // it rewrites: without the filter the remote would answer with rows from all
  // of its own nodes and they would come back claiming to belong to this one.
  forwarded.set('gitopsLocalTarget', '1');
  return { kind: 'forward', search: forwarded };
}

/**
 * Drop rows the caller may not read from an already-rewritten remote payload.
 *
 * Runs after the rewrite so the classifier sees this hub's node ids. Relative
 * order is preserved, and a page filtered down to nothing still returns its
 * envelope: `nextCursor` is the remote's own last examined row, so a caller
 * whose grants reject a whole window keeps paging rather than concluding the
 * history is empty.
 */
export function filterIdentityCollection(
  payload: unknown,
  keepRow: (row: unknown) => boolean,
  keepItem: (item: unknown) => boolean,
): unknown {
  if (Array.isArray(payload)) return payload.filter(keepRow);
  if (isRecord(payload) && Array.isArray(payload.items)) {
    return { ...payload, items: payload.items.filter(keepItem) };
  }
  return payload;
}

/** The hub's own node id for this hop, when one is set. */
export function hubNodeIdFor(req: Request): number | undefined {
  return typeof req.nodeId === 'number' ? req.nodeId : undefined;
}

/**
 * Apply this hub's read rules to a remote collection.
 *
 * The remote authorized its own rows for the machine account the hub proxies
 * with, which says nothing about the person behind the request. So the hub
 * re-decides every row against the signed-in user, using the same classifiers
 * the local routes use.
 *
 * It classifies from what the owning instance stated (`stackResourcePresent`,
 * `applicationLifecycleStatus`) because the hub has no application row for
 * another instance's stacks. Both are validated fail-closed, and any
 * `historyAuth`-style verdict a remote might volunteer is ignored.
 *
 * The honest limit: this catches a peer that is outdated, misconfigured, or
 * simply not filtering, because anything it omits or malforms degrades to the
 * Admin or audit bucket. It is not a defense against a hostile peer, which
 * could state evidence that downgrades a row to a stack read on a name it
 * chooses. A peer that far gone can fabricate the row contents anyway.
 *
 * Per-stack routes are not filtered here. Those were authorized by name before
 * the hop, and re-filtering their rows would hide a stack's own entries from
 * the operator who just proved they may read it.
 */
export function filterRemoteIdentityPayload(
  pathname: string,
  payload: unknown,
  canRead: (requirement: GitOpsReadRequirement) => boolean,
  nodeId: number,
): unknown {
  // Only the two cross-stack collections are filtered here.
  if (!/^\/git-sources(\/history)?\/?$/.test(pathname)) return payload;

  const filtered = filterRows(canRead, payload);
  const received = countRows(payload);
  const kept = countRows(filtered);
  // Keeping nothing from a page that had rows is the signature of a remote
  // whose response predates the evidence fields this classification needs.
  // The client is told nothing (a withheld count discloses what it may not
  // read), but an operator staring at an empty page needs the reason.
  if (received > 0 && kept === 0) {
    console.warn(
      `[Proxy] GitOps identity filter kept 0 of ${received} rows from node ${nodeId}. `
      + 'Either the caller may read none of them, or that node is too old to report '
      + 'stackResourcePresent and applicationLifecycleStatus.',
    );
  }
  return filtered;
}

function countRows(payload: unknown): number {
  if (Array.isArray(payload)) return payload.length;
  if (isRecord(payload) && Array.isArray(payload.items)) return payload.items.length;
  return 0;
}

function filterRows(
  canRead: (requirement: GitOpsReadRequirement) => boolean,
  payload: unknown,
): unknown {
  return filterIdentityCollection(
    payload,
    (row) => isRecord(row) && canRead(classifySourceRow({
      stackName: row.stack_name,
      gitopsRevision: row.gitopsRevision,
      stackResourcePresent: row.stackResourcePresent,
    })),
    (item) => isRecord(item) && canRead(classifyHistoryRow({
      stackName: item.stackName,
      applicationLifecycleStatus: item.applicationLifecycleStatus,
      stackResourcePresent: item.stackResourcePresent,
    })),
  );
}

/**
 * Headers that describe one connection's framing and must not be replayed.
 *
 * The hub decodes and rewrites the body, so the upstream's length and encoding
 * describe bytes that no longer exist. Forwarding them would frame the response
 * as something it is not.
 */
const HOP_BY_HOP_HEADERS = [
  'content-length', 'content-encoding', 'transfer-encoding', 'connection',
  'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade',
];

/** End-to-end headers that stay meaningful after the body is rewritten. */
const FORWARDED_HEADERS = [
  'cache-control', 'etag', 'last-modified', 'expires', 'vary',
  'location', 'retry-after', 'x-sencho-proxy',
];

export type IdentityTerminalKind =
  | 'rewrite'
  | 'passthrough'
  | 'too_large'
  | 'decompress_error'
  | 'parse_error'
  | 'rewrite_failed'
  | 'upstream_failed'
  | 'downstream_close';

/**
 * What each terminal does: answer with the remote's status, answer with one the
 * hub generates, or write nothing at all.
 *
 * Total rather than partial, and the single source for all three decisions this
 * hop makes per terminal (log, timing outcome, response). A partial table meant
 * a missing entry silently read as "use the upstream status", so a ninth kind
 * added later would inherit the remote's 200 for a body the hub could not read.
 * Here the compiler demands the answer.
 *
 * `rewrite_failed` is a 500 rather than a 502 on purpose: everything it covers
 * runs on this instance, so blaming the remote would send an operator to check
 * a node that did nothing wrong.
 */
type IdentityDisposition =
  | { respond: 'silent' }
  | { respond: 'upstream' }
  | { respond: 'generated'; status: number; body: { error: string; code: string } };

const TERMINALS: Record<IdentityTerminalKind, IdentityDisposition> = {
  rewrite: { respond: 'upstream' },
  passthrough: { respond: 'upstream' },
  downstream_close: { respond: 'silent' },
  too_large: {
    respond: 'generated',
    status: 502,
    body: { error: 'Remote GitOps response too large', code: 'gitops_proxy_too_large' },
  },
  decompress_error: {
    respond: 'generated',
    status: 502,
    body: { error: 'Remote GitOps response could not be decoded', code: 'gitops_proxy_decompress_failed' },
  },
  parse_error: {
    respond: 'generated',
    status: 502,
    body: { error: 'Remote GitOps response was not valid JSON', code: 'gitops_proxy_unparseable' },
  },
  rewrite_failed: {
    respond: 'generated',
    status: 500,
    body: { error: 'This instance could not process the GitOps response', code: 'gitops_proxy_rewrite_failed' },
  },
  upstream_failed: {
    respond: 'generated',
    status: 502,
    body: { error: 'Remote GitOps response failed', code: 'gitops_proxy_upstream_failed' },
  },
};

/** Whether a terminal represents a failure worth reporting to the operator. */
export function isIdentityFailure(kind: IdentityTerminalKind): boolean {
  return TERMINALS[kind].respond === 'generated';
}

/** Decode one upstream body according to its declared encoding. */
function decodeStream(proxyRes: IncomingMessage): Readable {
  const encoding = String(proxyRes.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return proxyRes.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return proxyRes.pipe(zlib.createInflate());
  if (encoding === 'br') return proxyRes.pipe(zlib.createBrotliDecompress());
  return proxyRes;
}

export type IdentityResponseHooks = {
  /** Rewrite and optionally filter a parsed 200/201 body. Returns what to send. */
  transform: (payload: unknown) => unknown;
  /** Runs exactly once, whatever the outcome. */
  finalizeTiming: (kind: IdentityTerminalKind) => void;
};

/**
 * The downstream response, as this handler actually uses it.
 *
 * Structural rather than the Express type so the terminal rules can be tested
 * against a plain object. An Express response satisfies it as-is.
 */
export type IdentityResponseSink = {
  headersSent: boolean;
  writableEnded: boolean;
  statusCode: number;
  removeHeader(name: string): void;
  setHeader(name: string, value: number | string | readonly string[]): unknown;
  end(body?: Buffer): unknown;
  on(event: 'close', listener: () => void): unknown;
};

/**
 * Write the one answer a terminal calls for.
 *
 * Split from the settling logic so the response rules can be read, and tested,
 * without a stream in the picture. Everything it needs is passed in.
 */
export function writeTerminal(
  res: IdentityResponseSink,
  proxyRes: IncomingMessage,
  kind: IdentityTerminalKind,
  body?: Buffer,
): void {
  const disposition = TERMINALS[kind];
  if (disposition.respond === 'silent') return;
  if (res.headersSent || res.writableEnded) {
    // Unreachable while this hop owns the response, so if it ever fires the
    // client is left with a half-written body and no other trace.
    console.warn(`[Proxy] GitOps identity hop could not answer (kind=${kind}): the response was already sent.`);
    return;
  }

  for (const header of HOP_BY_HOP_HEADERS) res.removeHeader(header);
  for (const header of FORWARDED_HEADERS) {
    const value = proxyRes.headers[header];
    if (value !== undefined) res.setHeader(header, value);
  }

  if (disposition.respond === 'generated') {
    // A hub-generated failure never borrows the upstream status: reporting our
    // own inability to read the response as the remote's 200 would call a
    // truncated or undecodable body a successful answer.
    const generatedBody = Buffer.from(JSON.stringify(disposition.body));
    res.statusCode = disposition.status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', String(generatedBody.length));
    res.end(generatedBody);
    return;
  }

  const status = proxyRes.statusCode ?? 502;
  res.statusCode = status;
  // 204 and 304 carry no body by definition, and 304 keeps the validators
  // copied above so a conditional request still revalidates correctly.
  if (status === 204 || status === 304 || body === undefined || body.length === 0) {
    res.end();
    return;
  }
  if (kind === 'rewrite') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
  } else {
    const upstreamType = proxyRes.headers['content-type'];
    if (upstreamType !== undefined) res.setHeader('content-type', upstreamType);
  }
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

/**
 * Buffer, rewrite, and answer one identity response.
 *
 * The hub has to hold the whole body to correct node ids inside it, which is
 * why this hop exists separately from the streaming one. Everything here is
 * arranged so exactly one terminal answer is written: a response that is too
 * large, fails to decode, dies upstream, or loses its client all converge on
 * the same single-shot responder, and duplicate events are dropped rather than
 * writing a second time onto a finished response.
 */
export function handleIdentityResponse(
  proxyRes: IncomingMessage,
  res: IdentityResponseSink,
  hooks: IdentityResponseHooks,
): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  let decoded: Readable | undefined;

  const finish = (kind: IdentityTerminalKind, body?: Buffer, cause?: unknown): void => {
    if (settled) return;
    settled = true;
    if (proxyRes.readable) proxyRes.destroy();
    // The decompressor holds a native zlib context that piping alone does not
    // release, and the buffered chunks are dead once a terminal is chosen.
    // Both matter most on `too_large`, the one path a remote can trigger at
    // will.
    if (decoded !== undefined && decoded !== proxyRes) decoded.destroy();
    if (kind !== 'rewrite') chunks.length = 0;

    // Reported unconditionally. The timing hook below is a developer-mode
    // diagnostic that carries no error detail and does not arm for these
    // routes, so without this an operator sees a 502 in the browser and finds
    // nothing whatsoever in the hub's log to explain it.
    if (isIdentityFailure(kind)) {
      console.error(
        `[Proxy] GitOps identity hop failed: kind=${kind} upstreamStatus=${proxyRes.statusCode ?? 'none'} `
        + `bytes=${total} encoding=${sanitizeForLog(String(proxyRes.headers['content-encoding'] ?? 'identity'))}`,
        cause === undefined ? '' : cause,
      );
    }
    // Guarded because it runs after the response is marked settled but before
    // anything is written: a throw here would leave the client waiting on a
    // response no later terminal can produce.
    try {
      hooks.finalizeTiming(kind);
    } catch (timingError) {
      console.error('[Proxy] GitOps identity timing hook threw:', timingError);
    }

    writeTerminal(res, proxyRes, kind, body);
  };

  // A client that hangs up mid-flight ends the hop without an answer: there is
  // nobody left to write to, and the upstream is dropped rather than left
  // filling a buffer nobody will read.
  res.on('close', () => {
    if (!res.writableEnded) finish('downstream_close');
  });

  // The cause is threaded through rather than discarded: a certificate error,
  // a reset connection, and a timeout each need a different fix and would
  // otherwise collapse into one indistinguishable message.
  proxyRes.on('error', (error) => finish('upstream_failed', undefined, error));
  // A premature close is an upstream failure, not an empty success: answering
  // 200 with a truncated body would report a partial page as a whole one.
  proxyRes.on('aborted', () => finish('upstream_failed', undefined, 'upstream closed before the body ended'));

  try {
    decoded = decodeStream(proxyRes);
  } catch (error) {
    finish('decompress_error', undefined, error);
    return;
  }

  decoded.on('error', (error) => finish('decompress_error', undefined, error));
  decoded.on('data', (chunk: Buffer) => {
    if (settled) return;
    total += chunk.length;
    if (total > IDENTITY_PROXY_MAX_BYTES) {
      finish('too_large');
      return;
    }
    chunks.push(chunk);
  });
  decoded.on('end', () => {
    if (settled) return;
    // Checked rather than waiting for `aborted`, which races the end of the
    // decoded stream. Without this a body that stopped early parses as broken
    // JSON and gets reported as a malformed response, sending an operator to
    // inspect the remote's output when the connection is what failed.
    if (!proxyRes.complete) {
      finish('upstream_failed', undefined, 'upstream ended before the body was complete');
      return;
    }
    const raw = Buffer.concat(chunks);
    const status = proxyRes.statusCode ?? 502;
    // Only a successful JSON body is rewritten. Redirects keep their Location,
    // and anything else is returned as the bytes the remote sent.
    if (status !== 200 && status !== 201) {
      finish('passthrough', raw);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      // Not passed through. These four routes answer with JSON on success, so a
      // 200 that will not parse is a body the hub could not read, exactly like
      // one it could not decompress. Relaying it under the remote's success
      // status would hand the client an unrewritten, unauthorized payload and
      // call it an answer. A captive portal or an error page served at 200 is
      // the usual cause.
      finish('parse_error', undefined, error);
      return;
    }
    // Only the rewrite itself is guarded. `finish` must stay outside, because
    // it marks the response settled on its first line: a throw from writing the
    // response would otherwise be "recovered" by a second finish that returns
    // immediately, leaving the client hanging with nothing logged.
    let rewritten: Buffer;
    try {
      rewritten = Buffer.from(JSON.stringify(hooks.transform(parsed)));
    } catch (error) {
      // Everything in transform runs on this instance, so this is a hub fault
      // and is reported as one. The error object is logged whole; for a bug on
      // our own side the stack is the diagnostic.
      finish('rewrite_failed', undefined, error);
      return;
    }
    finish('rewrite', rewritten);
  });
}

import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { NodeRegistry } from '../services/NodeRegistry';
import { isProxyExemptPath } from '../helpers/proxyExemptPaths';
import { SYNC_BODY_LIMIT, SYNC_ERROR_CODES, SYNC_PATH_PREFIX } from '../services/fleetSyncConstants';

// JSON body parser that also captures the raw bytes for HMAC verification.
// `rawBody` is part of the Express.Request augmentation (see types/express.ts);
// the cast is required because body-parser's `verify` signature types `req` as
// Node's IncomingMessage, not Express's Request.
const jsonParser = express.json({
  verify: (req, _res, buf) => {
    (req as unknown as Request).rawBody = buf;
  },
});

// Larger-limit parser for the fleet sync receive endpoint. A control instance
// can push up to MAX_SYNC_ROWS rows in a single payload; the default 100 KB
// limit is too tight for that.
const fleetSyncJsonParser = express.json({
  limit: SYNC_BODY_LIMIT,
  verify: (req, _res, buf) => {
    (req as unknown as Request).rawBody = buf;
  },
});

/**
 * Parse JSON on local requests but preserve the raw stream for remote proxy
 * forwarding.
 *
 * `express.json()` drains the IncomingMessage into `req.body`. `http-proxy`
 * then tries to pipe the already-ended stream to the upstream Sencho; Node
 * schedules the destination `.end()` on `process.nextTick`, which fires before
 * the `proxyReq` socket event, so any attempt to write the body later errors
 * with "write after end" and the request hangs. Skipping JSON parsing for
 * remote-targeted `/api/` paths keeps the stream intact.
 */
export const conditionalJsonParser: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const nodeIdHeader = req.headers['x-node-id'];
  if (nodeIdHeader) {
    const nodeId = parseInt(nodeIdHeader as string, 10);
    const node = NodeRegistry.getInstance().getNode(nodeId);
    if (node?.type === 'remote' && req.path.startsWith('/api/') && !isProxyExemptPath(req.path)) {
      next();
      return;
    }
  }
  // Fleet sync receive endpoint accepts larger payloads (up to MAX_SYNC_ROWS).
  // The 100 KB default would 413 long before the row-count check runs. Translate
  // body-parser's PayloadTooLargeError into a structured response with a
  // sync-specific code so the control's retry logic can distinguish it from
  // generic 413s.
  if (req.path.startsWith(SYNC_PATH_PREFIX)) {
    fleetSyncJsonParser(req, res, (err?: unknown) => {
      if (err && (err as { type?: string })?.type === 'entity.too.large') {
        res.status(413).json({
          error: 'Sync payload too large. Reduce policy or suppression count and retry.',
          code: SYNC_ERROR_CODES.payloadTooLarge,
        });
        return;
      }
      next(err);
    });
    return;
  }
  jsonParser(req, res, next);
};

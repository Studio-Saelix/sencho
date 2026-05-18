import type { RequestHandler } from 'express';

// compression@1.8.1's encoding negotiation (via negotiator@1.0.0) silently
// breaks when Accept-Encoding carries an unknown token such as `zstd`, which
// Chromium 123+ sends by default and which Playwright's bundled Chromium sends
// even over plain HTTP. In that path the response body is still compressed
// (brotli) but the Content-Encoding response header is never set, so the
// browser decode-fails with ERR_CONTENT_DECODING_FAILED and the Sencho UI
// renders blank. Drop the offending token before compression sees it so the
// negotiator falls back to a supported encoding and the header is written.
export const normalizeAcceptEncoding: RequestHandler = (req, _res, next) => {
  const raw = req.headers['accept-encoding'];
  if (typeof raw !== 'string' || !/\bzstd\b/i.test(raw)) {
    next();
    return;
  }
  const filtered = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^zstd(\s*;\s*q\s*=.*)?$/i.test(s))
    .join(', ');
  req.headers['accept-encoding'] = filtered || 'identity';
  next();
};

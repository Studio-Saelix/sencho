import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { getErrorMessage } from '../utils/errors';
import { errorMessageForLog, redactSensitiveText, sanitizeForLog } from '../utils/safeLog';

interface HttpError {
  type?: string;
  status?: number;
  statusCode?: number;
  expose?: boolean;
  message?: string;
}

/**
 * Central Express error handler. Preserves the status + message of HTTP errors
 * thrown by upstream middleware (body-parser's 413 `PayloadTooLargeError`,
 * CORS 403s, etc.) when the error is safe to expose; otherwise returns a
 * generic 500. Mounted last so Express recognises the 4-argument signature.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
  const e = (err ?? {}) as HttpError;
  const status = e.statusCode ?? e.status ?? 500;
  // Never log the error object or, for a body that failed to parse, even its
  // message: body-parser attaches the raw body to the error, and V8 quotes a
  // slice of the input in a JSON parse message, so either could carry a
  // secret the request held. Unexpected server errors keep a redacted stack.
  // body-parser marks its errors with an `entity.*` type and attaches the raw body to them.
  const bodyParseFailure = typeof e.type === 'string' && e.type.startsWith('entity.');
  const logged = bodyParseFailure
    ? 'request body could not be parsed'
    : status >= 500 && err instanceof Error && err.stack
      ? sanitizeForLog(redactSensitiveText(err.stack))
      : errorMessageForLog(err);
  console.error('[Error]', logged, `type=${sanitizeForLog(e.type ?? 'unknown')}`, `status=${status}`);
  if (res.headersSent) {
    next(err);
    return;
  }
  const expose = e.expose === true || status < 500;
  const message = expose ? getErrorMessage(err, 'Request failed') : 'Internal server error';
  res.status(status).json({ error: message });
};

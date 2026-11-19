/**
 * The central error handler logs the message, type and status of an error,
 * never the error object: body-parser attaches the raw request body to a parse
 * error, and that body can carry a secret. The response is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { errorHandler } from '../middleware/errorHandler';

const SECRET = 'body-secret-value-0123456789';

function mockResponse() {
  const state: { statusCode: number; payload: unknown } = { statusCode: 0, payload: undefined };
  const res = {
    headersSent: false,
    status(code: number) { state.statusCode = code; return res; },
    json(body: unknown) { state.payload = body; return res; },
  };
  return { res: res as unknown as Response, state };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHandler', () => {
  it('logs neither the parse error object nor its body, and answers as before', () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
    const err = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      type: 'entity.parse.failed', status: 400, statusCode: 400, expose: true, body: `{"token":"${SECRET}"`,
    });
    const { res, state } = mockResponse();
    errorHandler(err, {} as Request, res, vi.fn() as unknown as NextFunction);

    expect(state.statusCode).toBe(400);
    expect(state.payload).toEqual({ error: 'Unexpected end of JSON input' });
    expect(logged).toHaveLength(1);
    expect(logged[0].every((arg) => typeof arg === 'string')).toBe(true);
    expect(logged[0].join(' ')).not.toContain(SECRET);
    expect(logged[0].join(' ')).toContain('type=entity.parse.failed');
    expect(logged[0].join(' ')).toContain('status=400');
  });

  it('still hides the message of an unexpected 500', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { res, state } = mockResponse();
    errorHandler(new Error('internal detail'), {} as Request, res, vi.fn() as unknown as NextFunction);
    expect(state.statusCode).toBe(500);
    expect(state.payload).toEqual({ error: 'Internal server error' });
  });
});

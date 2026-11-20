/**
 * The central error handler keeps a request body out of its log line and out
 * of its response. It logs the message, type and status of an error, never the
 * error object, and answers a body-parser parse or verify failure with a fixed
 * sentence: body-parser attaches the raw body to the error and V8 quotes a
 * slice of the input in a JSON parse message, so either could carry a secret
 * the request held. Other errors keep their status and message.
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
  it('logs neither the parse error object nor its body, and answers with a fixed sentence', () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
    const err = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      type: 'entity.parse.failed', status: 400, statusCode: 400, expose: true, body: `{"token":"${SECRET}"`,
    });
    const { res, state } = mockResponse();
    errorHandler(err, {} as Request, res, vi.fn() as unknown as NextFunction);

    expect(state.statusCode).toBe(400);
    expect(state.payload).toEqual({ error: 'The request body could not be parsed.' });
    expect(logged).toHaveLength(1);
    expect(logged[0].every((arg) => typeof arg === 'string')).toBe(true);
    expect(logged[0].join(' ')).not.toContain(SECRET);
    expect(logged[0].join(' ')).toContain('type=entity.parse.failed');
    expect(logged[0].join(' ')).toContain('status=400');
  });

  it('never logs the parse message, which quotes a slice of the body', () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
    let parseError: unknown;
    try {
      JSON.parse(`{"token": ${SECRET}}`);
    } catch (error: unknown) {
      parseError = error;
    }
    expect(String((parseError as Error).message)).toContain(SECRET.slice(0, 8));
    const err = Object.assign(parseError as Error, { type: 'entity.parse.failed', status: 400, expose: true });
    const { res, state } = mockResponse();
    errorHandler(err, {} as Request, res, vi.fn() as unknown as NextFunction);
    expect(logged[0].join(' ')).not.toContain(SECRET.slice(0, 8));
    expect(logged[0].join(' ')).toContain('request body could not be parsed');
    // The response is checked as text: the parse message quotes the body's first characters.
    expect(state.statusCode).toBe(400);
    expect(JSON.stringify(state.payload)).not.toContain(SECRET.slice(0, 8));
    expect(state.payload).toEqual({ error: 'The request body could not be parsed.' });
  });

  it('answers a body that failed verification with a fixed sentence too', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = Object.assign(new Error(`bad signature for ${SECRET}`), { type: 'entity.verify.failed', status: 403, expose: true });
    const { res, state } = mockResponse();
    errorHandler(err, {} as Request, res, vi.fn() as unknown as NextFunction);
    expect(state.statusCode).toBe(403);
    expect(JSON.stringify(state.payload)).not.toContain(SECRET);
    expect(state.payload).toEqual({ error: 'The request body could not be verified.' });
  });

  it('still tells the client a body is too large, and keeps the message of an unrelated 4xx', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tooLarge = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413, expose: true });
    const first = mockResponse();
    errorHandler(tooLarge, {} as Request, first.res, vi.fn() as unknown as NextFunction);
    expect(first.state.statusCode).toBe(413);
    expect(first.state.payload).toEqual({ error: 'request entity too large' });
    const other = mockResponse();
    errorHandler(Object.assign(new Error('Not allowed by CORS'), { status: 403 }), {} as Request, other.res, vi.fn() as unknown as NextFunction);
    expect(other.state.payload).toEqual({ error: 'Not allowed by CORS' });
  });

  it('keeps the message of an unrelated error that happens to carry a body', () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
    const err = Object.assign(new Error('upstream refused the call'), { status: 502, body: 'upstream page' });
    errorHandler(err, {} as Request, mockResponse().res, vi.fn() as unknown as NextFunction);
    expect(logged[0].join(' ')).toContain('upstream refused the call');
  });

  it('keeps a redacted stack for an unexpected 500', () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
    errorHandler(new Error('boom in handler'), {} as Request, mockResponse().res, vi.fn() as unknown as NextFunction);
    expect(logged[0].join(' ')).toContain('boom in handler');
    expect(logged[0].join(' ')).toContain('error-handler.test');
  });

  it('still hides the message of an unexpected 500', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { res, state } = mockResponse();
    errorHandler(new Error('internal detail'), {} as Request, res, vi.fn() as unknown as NextFunction);
    expect(state.statusCode).toBe(500);
    expect(state.payload).toEqual({ error: 'Internal server error' });
  });
});

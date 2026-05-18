/**
 * Regression guard for `normalizeAcceptEncoding`.
 *
 * Background: `compression@1.8.1` (via `negotiator@1.0.0`) misbehaves when
 * `Accept-Encoding` carries an unknown token such as `zstd`. The library
 * compresses the response body but fails to set a `Content-Encoding` header,
 * so the browser decode-fails with `ERR_CONTENT_DECODING_FAILED` and the
 * page renders blank. Chromium 123+ sends `Accept-Encoding: zstd, gzip, br`
 * by default, including Playwright's bundled Chromium even on plain HTTP.
 *
 * The middleware drops `zstd` tokens before `compression` negotiates so the
 * negotiator falls back to `br` or `gzip` and writes the matching response
 * header. These tests cover the unit-level transform and an end-to-end pass
 * through `compression` + a route that returns a 2 KB body (above the
 * compression threshold).
 */
import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import compression from 'compression';
import request from 'supertest';
import { normalizeAcceptEncoding } from '../middleware/normalizeAcceptEncoding';

function runNormalize(accept: string | undefined): string | undefined {
  const headers: Record<string, string | undefined> = {};
  if (accept !== undefined) headers['accept-encoding'] = accept;
  const req = { headers } as unknown as Parameters<typeof normalizeAcceptEncoding>[0];
  const res = {} as Parameters<typeof normalizeAcceptEncoding>[1];
  normalizeAcceptEncoding(req, res, () => { /* noop */ });
  const after = req.headers['accept-encoding'];
  return typeof after === 'string' ? after : undefined;
}

function makeApp(): express.Express {
  const app = express();
  app.use(normalizeAcceptEncoding);
  app.use(compression());
  // Payload large enough to be compressed (default threshold is 1 KB).
  const body = 'abcdefghij'.repeat(300);
  app.get('/text', (_req: Request, res: Response) => {
    res.type('text/plain').send(body);
  });
  return app;
}

describe('normalizeAcceptEncoding (unit)', () => {
  it('passes through when Accept-Encoding is missing', () => {
    expect(runNormalize(undefined)).toBeUndefined();
  });

  it('passes through gzip/deflate/br untouched', () => {
    expect(runNormalize('gzip')).toBe('gzip');
    expect(runNormalize('gzip, deflate, br')).toBe('gzip, deflate, br');
    expect(runNormalize('br;q=0.5, gzip;q=1.0')).toBe('br;q=0.5, gzip;q=1.0');
  });

  it('strips a bare zstd token while preserving order', () => {
    expect(runNormalize('zstd, gzip, br')).toBe('gzip, br');
    expect(runNormalize('gzip, zstd, br')).toBe('gzip, br');
    expect(runNormalize('gzip, br, zstd')).toBe('gzip, br');
  });

  it('strips zstd with a q-value', () => {
    expect(runNormalize('zstd;q=1.0, gzip;q=0.8')).toBe('gzip;q=0.8');
    expect(runNormalize('gzip, zstd;q=0.5, br')).toBe('gzip, br');
  });

  it('strips zstd case-insensitively', () => {
    expect(runNormalize('ZSTD, gzip')).toBe('gzip');
    expect(runNormalize('Zstd;q=1.0, br')).toBe('br');
  });

  it('falls back to identity when only zstd was offered', () => {
    expect(runNormalize('zstd')).toBe('identity');
    expect(runNormalize('zstd;q=1.0')).toBe('identity');
  });

  it('leaves the wildcard token alone', () => {
    expect(runNormalize('*')).toBe('*');
  });

  it('does not strip tokens that merely contain "zstd" as a substring', () => {
    // Should not match the zstd-only regex even though it starts with "zstd-".
    expect(runNormalize('zstd-future, gzip')).toBe('zstd-future, gzip');
  });
});

describe('normalizeAcceptEncoding (integration with compression)', () => {
  // supertest (via superagent) auto-decompresses gzip/br response bodies, so
  // these tests assert the Content-Encoding response header and that the
  // decoded body matches the original payload. The header is what the browser
  // checks to decide whether to decompress; the F-3 bug was specifically that
  // it was absent.

  it('sets Content-Encoding (br or gzip) when zstd, gzip, br is offered', async () => {
    const res = await request(makeApp())
      .get('/text')
      .set('Accept-Encoding', 'zstd, gzip, br');
    expect(res.status).toBe(200);
    expect(['br', 'gzip']).toContain(res.headers['content-encoding']);
    expect(res.text.startsWith('abcdefghij')).toBe(true);
  });

  it('still serves gzip when only gzip is offered (regression baseline)', async () => {
    const res = await request(makeApp())
      .get('/text')
      .set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.text.startsWith('abcdefghij')).toBe(true);
  });

  it('omits Content-Encoding when only zstd is offered (identity fallback)', async () => {
    const res = await request(makeApp())
      .get('/text')
      .set('Accept-Encoding', 'zstd');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.text.startsWith('abcdefghij')).toBe(true);
  });
});

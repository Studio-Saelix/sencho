/**
 * Regression guard for the multipart-body forwarding path through the
 * remote-node HTTP proxy.
 *
 * `middleware/jsonParser.ts::conditionalJsonParser` skips
 * `express.json()` for requests with an `x-node-id` pointing at a remote
 * node, leaving the raw body stream untouched so `createRemoteProxyMiddleware`
 * can pipe it upstream. No existing test pins that the skip also applies to
 * multipart payloads, not just JSON. A regression that re-enabled body-parser
 * on multipart would silently strand `POST /api/stacks/<name>/files/upload`
 * to remote nodes: the proxy would forward an already-drained stream, the
 * upstream multer would see an empty body, and the user would get a 400
 * from a successful-looking request.
 *
 * The test starts an in-process HTTP capture server, registers it as a
 * remote node, and POSTs a multipart upload through the central. The
 * capture server reads the raw bytes off the wire and asserts both the
 * multipart boundary and the file's exact bytes survived the hop.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import http from 'http';
import type { AddressInfo } from 'net';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

describe('remote-node proxy: multipart upload pass-through', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let captureServer: http.Server;
  let remoteNodeId: number;
  let authHeader: string;

  // Per-request capture slot. The test mutates this between requests.
  let captured: {
    contentType: string | undefined;
    contentLength: string | undefined;
    auth: string | undefined;
    bodyRaw: Buffer;
  } | null = null;

  beforeAll(async () => {
    tmpDir = await setupTestDb();

    // Build the capture server first so we can address-resolve it before the
    // app boots and reads the node row.
    captureServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        captured = {
          contentType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
          auth: req.headers['authorization'] as string | undefined,
          bodyRaw: Buffer.concat(chunks),
        };
        res.statusCode = 204;
        res.end();
      });
      req.on('error', () => {
        res.statusCode = 500;
        res.end();
      });
    });

    await new Promise<void>((resolve) => captureServer.listen(0, '127.0.0.1', resolve));
    const port = (captureServer.address() as AddressInfo).port;

    ({ app } = await import('../index'));
    const { DatabaseService } = await import('../services/DatabaseService');

    remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'multipart-capture',
      type: 'remote',
      compose_dir: '/tmp',
      is_default: false,
      api_url: `http://127.0.0.1:${port}`,
      api_token: 'multipart-test-token',
    });

    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' });
    authHeader = `Bearer ${token}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => captureServer.close(() => resolve()));
    cleanupTestDb(tmpDir);
  });

  it('forwards a multipart upload payload intact to the remote node', async () => {
    // Use a payload with a recognisable byte pattern (mix of printable and
    // non-printable bytes) so any silent re-parsing or stream consumption is
    // visible in the captured raw body.
    const fileBytes = Buffer.concat([
      Buffer.from('SENCHO-MULTIPART-MARKER\n', 'utf-8'),
      Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xff]),
      Buffer.from('END\n', 'utf-8'),
    ]);

    captured = null;
    const res = await request(app)
      .post(`/api/stacks/anystack/files/upload`)
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId))
      .attach('file', fileBytes, 'multipart-fixture.bin');

    expect(res.status).toBe(204);
    expect(captured).not.toBeNull();
    expect(captured!.contentType).toMatch(/^multipart\/form-data;.*boundary=/);
    // Content-Length must be carried through unchanged so the upstream
    // multipart parser does not stall waiting for more bytes.
    expect(captured!.contentLength).toBeDefined();
    expect(Number(captured!.contentLength)).toBe(captured!.bodyRaw.length);

    // The raw bytes captured by the upstream must contain the file fixture
    // unchanged; any silent re-parse or partial drain would break this.
    // The lower bound on bodyRaw.length is a defence-in-depth check against
    // a half-drained stream where the file bytes happen to land in the head
    // chunk: a real multipart envelope adds at least one boundary line, the
    // Content-Disposition header, a blank line, and a trailing boundary, so
    // the wire bytes must exceed the raw fixture by a non-trivial margin.
    expect(captured!.bodyRaw.length).toBeGreaterThan(fileBytes.length + 60);
    expect(captured!.bodyRaw.includes(fileBytes)).toBe(true);

    // Bearer auth must be rewritten by the proxy to the remote node's api_token
    // (not the central's user JWT). This protects against a regression that
    // leaks the originating user's token to the peer.
    expect(captured!.auth).toBe('Bearer multipart-test-token');
  });

  it('preserves the multipart boundary and original filename across the proxy', async () => {
    const fileBytes = Buffer.from('boundary-pass-through-check', 'utf-8');

    captured = null;
    const res = await request(app)
      .post(`/api/stacks/anystack/files/upload`)
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId))
      .attach('file', fileBytes, 'boundary-check.txt');

    expect(res.status).toBe(204);
    expect(captured).not.toBeNull();

    // The boundary must appear in both the Content-Type header and the body
    // bytes; a body-parser that consumed and re-serialised the stream would
    // break this association.
    const boundaryMatch = captured!.contentType?.match(/boundary=([^;]+)/);
    expect(boundaryMatch).toBeTruthy();
    const boundary = boundaryMatch![1];
    expect(captured!.bodyRaw.includes(Buffer.from(`--${boundary}`, 'utf-8'))).toBe(true);
    expect(captured!.bodyRaw.includes(Buffer.from('boundary-check.txt', 'utf-8'))).toBe(true);
  });
});

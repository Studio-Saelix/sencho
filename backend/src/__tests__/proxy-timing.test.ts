/**
 * Gateway hop timing for proxied critical hydration GETs ([Proxy:debug]).
 *
 * Verifies the exactly-once finalization contract:
 *   - a normal proxied request fires downstream finish then close but logs once
 *     (outcome ok, with upstreamStatus / ttfbMs / elapsedMs),
 *   - a client abort after headers finalizes as not-success (aborted/error),
 *     never ok, and still exactly once,
 *   - path templates never carry the real stack name or a query string,
 *   - nothing is logged when the gateway's developer_mode is off.
 *
 * The "remote" node is a loopback capture server; the gateway is exercised both
 * via supertest (finish/close, templates, off) and via a raw client against a
 * real listener (abort) so the downstream socket can be destroyed mid-body.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminBearer: string;
let remoteNodeId: number;

let captureServer: http.Server;
let appServer: http.Server;
let appPort: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ app } = await import('../index'));

  // authMiddleware resolves the role from the DB row, so a bearer for the
  // seeded admin proxies with admin privileges (skips the cross-node RBAC probe).
  adminBearer = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;

  // Loopback "remote": returns [] for GETs; hangs mid-body for the abort path.
  captureServer = http.createServer((req, res) => {
    if (req.url?.includes('/containers') && req.url.includes('hangstack')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('['); // partial body, intentionally never ended
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((resolve) => captureServer.listen(0, '127.0.0.1', resolve));
  const capturePort = (captureServer.address() as AddressInfo).port;

  remoteNodeId = DatabaseService.getInstance().addNode({
    name: 'timing-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${capturePort}`,
    api_token: 'timing-node-token',
  });

  appServer = http.createServer(app);
  await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  appPort = (appServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => captureServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
});

function setDeveloperMode(on: boolean): void {
  DatabaseService.getInstance().updateGlobalSetting('developer_mode', on ? '1' : '0');
}

/** Run `fn` while capturing console.debug lines; returns lines before restore. */
async function captureDebug(fn: () => Promise<void>): Promise<string[]> {
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  let lines: string[];
  try {
    await fn();
    lines = spy.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  } finally {
    spy.mockRestore();
  }
  return lines;
}

const proxyLinesFrom = (lines: string[]): string[] => lines.filter((l) => l.startsWith('[Proxy:debug]'));

describe('[Proxy:debug] downstream finish/close finalization', () => {
  it('logs exactly one line on a normal proxied GET (finish wins over close)', async () => {
    setDeveloperMode(true);
    const lines = await captureDebug(async () => {
      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', adminBearer)
        .set('x-node-id', String(remoteNodeId));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
    });

    const proxyLines = proxyLinesFrom(lines);
    expect(proxyLines).toHaveLength(1);
    expect(proxyLines[0]).toContain('route=/api/stacks');
    expect(proxyLines[0]).toMatch(/outcome=ok/);
    expect(proxyLines[0]).toMatch(/upstreamStatus=200/);
    expect(proxyLines[0]).toMatch(/ttfbMs=\d+/);
    expect(proxyLines[0]).toMatch(/elapsedMs=\d+/);
  });

  it('templates the path and never logs the real stack name or query string', async () => {
    setDeveloperMode(true);
    const lines = await captureDebug(async () => {
      await request(app)
        .get('/api/stacks/supersecretstack/containers?token=leak')
        .set('Authorization', adminBearer)
        .set('x-node-id', String(remoteNodeId));
      await new Promise((r) => setTimeout(r, 50));
    });

    const proxyLines = proxyLinesFrom(lines);
    expect(proxyLines).toHaveLength(1);
    expect(proxyLines[0]).toContain('route=/api/stacks/:stack/containers');
    expect(proxyLines[0]).not.toContain('supersecretstack');
    expect(proxyLines[0]).not.toContain('token=leak');
  });

  it('logs nothing when the gateway developer_mode is off', async () => {
    setDeveloperMode(false);
    const lines = await captureDebug(async () => {
      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', adminBearer)
        .set('x-node-id', String(remoteNodeId));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(proxyLinesFrom(lines)).toHaveLength(0);
  });
});

describe('[Proxy:debug] client abort after headers', () => {
  it('finalizes as not-success exactly once when the client aborts mid-body', async () => {
    setDeveloperMode(true);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    // The proxy logs a [Proxy] error on the aborted upstream; keep it quiet.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await new Promise<void>((resolve) => {
        const clientReq = http.request(
          {
            host: '127.0.0.1',
            port: appPort,
            path: '/api/stacks/hangstack/containers',
            method: 'GET',
            headers: { Authorization: adminBearer, 'x-node-id': String(remoteNodeId) },
          },
          (resp) => {
            // Headers have arrived from the gateway (upstream status + ttfb are
            // already captured). Abort before the body finishes.
            resp.destroy();
            clientReq.destroy();
            resolve();
          },
        );
        clientReq.on('error', () => resolve());
        clientReq.end();
      });

      // Let the downstream 'close' / proxy 'error' fire and finalize.
      await new Promise((r) => setTimeout(r, 200));

      const proxyLines = debugSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('[Proxy:debug]') && l.includes('/:stack/containers'));

      expect(proxyLines).toHaveLength(1);
      expect(proxyLines[0]).not.toMatch(/outcome=ok/);
      expect(proxyLines[0]).toMatch(/outcome=(aborted|error)/);
    } finally {
      debugSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

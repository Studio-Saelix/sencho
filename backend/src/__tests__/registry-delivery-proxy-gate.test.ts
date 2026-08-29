/**
 * Production proxy orchestration for registry credential delivery: abort must
 * stop forwarding, compressed bodies pass through when delivery is unavailable,
 * and return 415 only when delivery would run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import zlib from 'zlib';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { REMOTE_REGISTRY_CREDENTIALS_CAPABILITY } from '../services/CapabilityRegistry';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let remoteWithCapabilityId: number;
let remoteWithoutCapabilityId: number;

const capturedHops: Array<{ method: string; url: string }> = [];
let metaDelayMs = 0;

function createRemoteServer(capabilities: string[]): http.Server {
  return http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.97.1', capabilities }));
      };
      if (metaDelayMs > 0) {
        setTimeout(respond, metaDelayMs);
        return;
      }
      respond();
      return;
    }
    capturedHops.push({ method: req.method ?? '', url: req.url ?? '' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as import('net').AddressInfo).port;
}

let capableServer: http.Server;
let incapableServer: http.Server;
let capablePort: number;
let incapablePort: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));

  const { DatabaseService } = await import('../services/DatabaseService');
  const { RegistryDeliveryService } = await import('../services/RegistryDeliveryService');
  vi.spyOn(RegistryDeliveryService.getInstance(), 'isProxyTransportConfidential').mockReturnValue(true);

  capableServer = createRemoteServer([REMOTE_REGISTRY_CREDENTIALS_CAPABILITY]);
  incapableServer = createRemoteServer([]);
  capablePort = await listen(capableServer);
  incapablePort = await listen(incapableServer);

  remoteWithCapabilityId = DatabaseService.getInstance().addNode({
    name: 'regdelivery-capable',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${capablePort}`,
    api_token: 'capable-token',
  });

  remoteWithoutCapabilityId = DatabaseService.getInstance().addNode({
    name: 'regdelivery-incapable',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${incapablePort}`,
    api_token: 'incapable-token',
  });

  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1h' });
  authHeader = `Bearer ${token}`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => capableServer.close(() => resolve())),
    new Promise<void>((resolve) => incapableServer.close(() => resolve())),
  ]);
  cleanupTestDb(tmpDir);
  vi.restoreAllMocks();
});

beforeEach(() => {
  capturedHops.length = 0;
  metaDelayMs = 0;
});

describe('remoteNodeProxy registry delivery gate', () => {
  const deployPath = '/api/stacks/reg-proxy-gate/deploy';
  const gzipBody = zlib.gzipSync(Buffer.from('{}', 'utf-8'));

  it('rejects gzip-encoded deploy when delivery would run', async () => {
    const res = await request(app)
      .post(deployPath)
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteWithCapabilityId))
      .set('Content-Encoding', 'gzip')
      .send(gzipBody);

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('encoding_unsupported');
    expect(capturedHops.some((h) => h.url.includes('/deploy'))).toBe(false);
  });

  it('forwards gzip-encoded deploy unchanged when delivery is unavailable', async () => {
    const res = await request(app)
      .post(deployPath)
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteWithoutCapabilityId))
      .set('Content-Encoding', 'gzip')
      .send(gzipBody);

    expect(res.status).toBe(200);
    expect(capturedHops.some((h) => h.url.includes('/deploy'))).toBe(true);
  });

  it('does not forward deploy after client abort during capability probing', async () => {
    metaDelayMs = 800;
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as import('net').AddressInfo).port;

    const outcome = await new Promise<{ aborted: boolean }>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: deployPath,
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'x-node-id': String(remoteWithCapabilityId),
            'Content-Type': 'application/json',
            'Content-Length': '2',
          },
        },
        () => resolve({ aborted: false }),
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET' || err.message === 'aborted') {
          resolve({ aborted: true });
          return;
        }
        resolve({ aborted: false });
      });
      req.write('{}');
      req.end();
      setTimeout(() => req.destroy(), 50);
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(outcome.aborted).toBe(true);
    expect(capturedHops.some((h) => h.url.includes('/deploy'))).toBe(false);
  });
});

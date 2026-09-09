/**
 * Production proxy orchestration for registry credential delivery: abort must
 * stop forwarding, compressed bodies pass through when delivery is unavailable,
 * return 415 only when delivery would run, and a delivery refusal surfaces its
 * status, code, and message to the client without forwarding.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import zlib from 'zlib';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY } from '../services/CapabilityRegistry';

// Pass-through spy: lets a test queue a one-time refusal without
// changing any other behavior.
vi.mock('../helpers/registryDeliveryOutbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpers/registryDeliveryOutbound')>();
  return {
    ...actual,
    augmentJsonBodyForRegistryDelivery: vi.fn(
      (...args: Parameters<typeof actual.augmentJsonBodyForRegistryDelivery>) =>
        actual.augmentJsonBodyForRegistryDelivery(...args),
    ),
  };
});

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
    if (req.url?.startsWith('/api/registry-delivery/discover')) {
      // Shape-valid scripted discover: the exact ref list points at a
      // link-local host, which the real safe-probe boundary always refuses
      // before any connection, so the probe path is deterministic on every
      // runner and the hub lands on passthrough and forwards the deploy.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contractVersion: 1,
        referencedHosts: ['169.254.169.254'],
        referencedPullRefs: ['169.254.169.254/acme/app:1.0.0'],
        coveredHosts: [],
        sourceHash: 'abc',
        actionSetHash: 'def',
        deliverySourceId: 'src',
        attestation: 'att',
      }));
      return;
    }
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

  capableServer = createRemoteServer([REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY]);
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

  it('runs discover end to end and forwards the deploy when every probed host is unsafe', async () => {
    const res = await request(app)
      .post(deployPath)
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteWithCapabilityId))
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(200);
    expect(capturedHops.some((h) => h.url === '/api/registry-delivery/discover')).toBe(true);
    expect(capturedHops.some((h) => h.url.includes('/deploy'))).toBe(true);
  });
  it('surfaces the delivery refusal code and message when augment refuses', async () => {
    const { augmentJsonBodyForRegistryDelivery } = await import('../helpers/registryDeliveryOutbound');
    vi.mocked(augmentJsonBodyForRegistryDelivery).mockResolvedValueOnce({
      ok: false as const,
      status: 409,
      code: 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE',
      error: 'Registry credentials unavailable for challenged image hosts',
    });

    const res = await request(app)
      .post(deployPath)
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteWithCapabilityId))
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Registry credentials unavailable for challenged image hosts',
      code: 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE',
    });
    expect(capturedHops.some((h) => h.url.includes('/deploy'))).toBe(false);
  });
});

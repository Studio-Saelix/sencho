/**
 * Transport parity for the detected exposure: GET /api/stacks/:name/networking
 * is computed on the owning node, so a direct-proxy node and a Pilot node must
 * both forward the request and return the body unchanged. The browser never
 * infers a detection locally.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';

const STACK = 'exposure-remote';

/** The body the owning node computes, including both evidence paths. */
const REMOTE_BODY = {
  stack: STACK,
  renderable: true,
  renderError: null,
  runtime: 'available',
  networks: [{ key: 'default', name: `${STACK}_default`, external: false, internal: false, createdByStack: false }],
  services: [{
    name: 'app',
    networks: [{ key: 'default', aliases: [] }],
    publishedPorts: [],
    extraHosts: [],
    detected: {
      status: 'paths',
      paths: [
        { kind: 'tunnel', scope: 'public-edge', provider: 'cloudflared', connector: 'cf', path: 'shared-network', certain: false },
        { kind: 'host-port', scope: 'host-published', bind: 'all-interfaces', hostIp: '0.0.0.0', startPort: 8080, endPort: 8080, protocol: 'tcp' },
      ],
      incomplete: [],
      externalNetworks: [],
      runtimeChecked: true,
      conflicts: {
        internal: [{ level: 'possible', reason: 'tunnel', paths: [0] }, { level: 'conflict', reason: 'host-port', paths: [1] }],
        'same-node': [{ level: 'possible', reason: 'tunnel', paths: [0] }, { level: 'conflict', reason: 'host-port', paths: [1] }],
        lan: [],
        'reverse-proxy': [],
        public: [],
        temporary: [],
        unknown: [],
      },
      suggestedIntent: null,
      answer: 'public edge (unverified) + host-published',
    },
  }],
  drift: { runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [] },
  missingExternalNetworks: [],
  tunnels: [],
};

describe('detected exposure over the remote transports', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let authHeader: string;
  let directServer: http.Server;
  let pilotServer: http.Server;
  let directNodeId: number;
  let pilotNodeId: number;
  const directPaths: string[] = [];
  const pilotPaths: string[] = [];

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;

    const remote = (paths: string[]) => http.createServer((req, res) => {
      if (req.url?.startsWith('/api/meta')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.99.0', capabilities: ['cross-node-rbac'] }));
        return;
      }
      paths.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(REMOTE_BODY));
    });
    directServer = remote(directPaths);
    pilotServer = remote(pilotPaths);
    await new Promise<void>((resolve) => directServer.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => pilotServer.listen(0, '127.0.0.1', resolve));
    const directPort = (directServer.address() as import('net').AddressInfo).port;
    const pilotPort = (pilotServer.address() as import('net').AddressInfo).port;

    const db = DatabaseService.getInstance();
    directNodeId = db.addNode({
      name: 'direct-exposure-node', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
      is_default: false, api_url: `http://127.0.0.1:${directPort}`, api_token: 'direct-token',
    });
    pilotNodeId = db.addNode({
      name: 'pilot-exposure-node', type: 'remote', mode: 'pilot_agent', compose_dir: '/tmp',
      is_default: false, api_url: '', api_token: '',
    });

    // A pilot node only reaches the hub through a live bridge; return the shape
    // the bridge produces at runtime.
    const registry = NodeRegistry.getInstance();
    const original = registry.getProxyTarget.bind(registry);
    vi.spyOn(registry, 'getProxyTarget').mockImplementation((nodeId: number) => {
      if (nodeId === pilotNodeId) return { apiUrl: `http://127.0.0.1:${pilotPort}`, apiToken: '', trustedLoopback: true };
      return original(nodeId);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => directServer.close(() => resolve()));
    await new Promise<void>((resolve) => pilotServer.close(() => resolve()));
    cleanupTestDb(tmpDir);
  });

  it.each([
    ['direct-proxy', () => directNodeId, directPaths],
    ['Pilot', () => pilotNodeId, pilotPaths],
  ])('forwards the request to a %s node and returns detected unchanged', async (_label, nodeId, paths) => {
    paths.length = 0;
    const res = await request(app)
      .get(`/api/stacks/${STACK}/networking`)
      .set('Authorization', authHeader)
      .set('x-node-id', String(nodeId()));
    expect(res.status).toBe(200);
    expect(paths.some(p => p.includes(`/api/stacks/${STACK}/networking`))).toBe(true);
    expect(res.body).toEqual(REMOTE_BODY);
    expect(res.body.services[0].detected.answer).toBe('public edge (unverified) + host-published');
    expect(res.body.services[0].detected.paths).toHaveLength(2);
  });
});

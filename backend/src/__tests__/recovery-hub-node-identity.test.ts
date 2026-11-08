/**
 * The node an overwrite preview names.
 *
 * A remote instance numbers its nodes from one and calls itself `Local`, so the
 * preview it serves for a hub node would tell the operator that the restore
 * targets the control node. The hub therefore forwards its own record of the node
 * on every proxied hop (over a direct proxy and over a Pilot tunnel alike), the
 * remote trusts it only under machine auth, and the preview names it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import {
  PROXY_HUB_NODE_ID_HEADER,
  PROXY_HUB_NODE_NAME_HEADER,
  hubNodeHeaderValues,
  parseHubNodeHeaders,
} from '../services/license-headers';
import { seedPersonas } from './fixtures/personas';

vi.mock('../services/recovery/remoteSupport', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/recovery/remoteSupport')>();
  return {
    ...original,
    preflightRecoveryRequest: async () => ({ ok: true, status: { state: 'available' } }),
  };
});

let tmpDir: string;
let app: import('express').Express;
let server: http.Server;
let captured: http.IncomingHttpHeaders | null = null;
let proxyNodeId: number;
let pilotNodeId: number;
let adminBearer: string;
const PROXY_NAME = 'sencho test 01 é';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const { NodeRegistry } = await import('../services/NodeRegistry');
  adminBearer = seedPersonas(DatabaseService.getInstance()).admin.bearer;

  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.99.0', capabilities: ['cross-node-rbac'] }));
      return;
    }
    captured = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  const db = DatabaseService.getInstance();
  proxyNodeId = db.addNode({
    name: PROXY_NAME, type: 'remote', mode: 'proxy', compose_dir: '/tmp', is_default: false,
    api_url: `http://127.0.0.1:${port}`, api_token: 't',
  });
  pilotNodeId = db.addNode({
    name: 'sencho-test-02', type: 'remote', mode: 'pilot_agent', compose_dir: '/tmp', is_default: false, api_url: '', api_token: '',
  });
  const registry = NodeRegistry.getInstance();
  const original = registry.getProxyTarget.bind(registry);
  vi.spyOn(registry, 'getProxyTarget').mockImplementation((nid: number) => {
    if (nid === pilotNodeId) return { apiUrl: `http://127.0.0.1:${port}`, apiToken: '', trustedLoopback: true };
    return original(nid);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  captured = null;
});

describe('the header pair', () => {
  it('round-trips an id and a name that is not a header-safe string', () => {
    const values = hubNodeHeaderValues({ id: 12, name: 'node 12 "é"\r\nx' })!;
    expect(values.name).not.toMatch(/[\r\n ]/);
    expect(parseHubNodeHeaders(values.id, values.name)).toEqual({ id: 12, name: 'node 12 "é"\r\nx' });
  });

  it('cuts a long name by character, so an emoji at the boundary is kept whole or dropped whole', () => {
    const name = `${'a'.repeat(127)}\u{1F600}tail`;
    const values = hubNodeHeaderValues({ id: 3, name });
    expect(values).not.toBeNull();
    const parsed = parseHubNodeHeaders(values!.id, values!.name);
    expect(Array.from(parsed!.name)).toHaveLength(128);
    expect(parsed!.name.endsWith('\u{1F600}')).toBe(true);
  });

  it('sends no pair, and does not throw, for a name no URL encoding can carry', () => {
    expect(hubNodeHeaderValues({ id: 3, name: `a\uD800b` })).toBeNull();
    expect(hubNodeHeaderValues({ id: 3, name: '\uDFFF' })).toBeNull();
  });

  it.each([
    [undefined, 'a'], ['12', undefined], ['0', 'a'], ['-1', 'a'], ['1.5', 'a'], ['12abc', 'a'], ['99999999999', 'a'],
    ['12', ''], ['12', '%E0%A4%A'], ['12', 'a'.repeat(129)],
  ])('treats %j / %j as no hub node', (id, name) => {
    expect(parseHubNodeHeaders(id, name)).toBeNull();
  });
});

describe('what the hub forwards', () => {
  it.each([
    ['a direct proxy node', () => proxyNodeId, PROXY_NAME],
    ['a Pilot node', () => pilotNodeId, 'sencho-test-02'],
  ])('sends its own id and name for %s, replacing a forged pair', async (_label, nodeId, name) => {
    const res = await request(app)
      .post('/api/recovery/points/p1/overwrite/preview')
      .set('Authorization', adminBearer)
      .set('x-node-id', String(nodeId()))
      .set(PROXY_HUB_NODE_ID_HEADER, '1')
      .set(PROXY_HUB_NODE_NAME_HEADER, 'Local')
      .send({});
    expect(res.status).toBe(200);
    expect(captured?.[PROXY_HUB_NODE_ID_HEADER]).toBe(String(nodeId()));
    expect(decodeURIComponent(String(captured?.[PROXY_HUB_NODE_NAME_HEADER]))).toBe(name);
  });
});

describe('a node whose name sits on a character boundary', () => {
  it('still answers through the hub, with the name kept whole, instead of failing the hop', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const name = `${'b'.repeat(127)}\u{1F600}`;
    const nodeId = DatabaseService.getInstance().addNode({
      name, type: 'remote', mode: 'proxy', compose_dir: '/tmp', is_default: false,
      api_url: `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`, api_token: 't',
    });
    const res = await request(app)
      .post('/api/recovery/points/p1/overwrite/preview')
      .set('Authorization', adminBearer)
      .set('x-node-id', String(nodeId))
      .send({});
    expect(res.status).toBe(200);
    expect(decodeURIComponent(String(captured?.[PROXY_HUB_NODE_NAME_HEADER]))).toBe(name);
  });
});

describe('a node whose name cannot be sent', () => {
  it('is still reached, with no pair sent and a forged one stripped', async () => {
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const registry = NodeRegistry.getInstance();
    const real = registry.getNode.bind(registry);
    vi.spyOn(registry, 'getNode').mockImplementation((nid: number) => {
      const node = real(nid);
      return node && nid === proxyNodeId ? { ...node, name: `${'d'.repeat(127)}\uD83D` } : node;
    });
    try {
      const res = await request(app)
        .post('/api/recovery/points/p1/overwrite/preview')
        .set('Authorization', adminBearer)
        .set('x-node-id', String(proxyNodeId))
        .set(PROXY_HUB_NODE_ID_HEADER, '1')
        .set(PROXY_HUB_NODE_NAME_HEADER, 'Local')
        .send({});
      expect(res.status).toBe(200);
      expect(captured?.[PROXY_HUB_NODE_ID_HEADER]).toBeUndefined();
      expect(captured?.[PROXY_HUB_NODE_NAME_HEADER]).toBeUndefined();
    } finally {
      vi.mocked(registry.getNode).mockRestore();
    }
  });
});

describe('what the remote does with it', () => {
  const machineToken = (scope: 'node_proxy' | 'pilot_tunnel') =>
    jwt.sign({ scope }, TEST_JWT_SECRET, { expiresIn: '1m' });

  async function previewInput(headers: Record<string, string>, auth: { bearer?: string; machine?: 'node_proxy' | 'pilot_tunnel' }) {
    const { RecoveryEngineService } = await import('../services/recovery/operationRunner');
    const spy = vi.spyOn(RecoveryEngineService.prototype, 'previewOverwrite').mockResolvedValue({} as never);
    try {
      const req = request(app).post('/api/recovery/points/p1/overwrite/preview')
        .set('Authorization', auth.machine ? `Bearer ${machineToken(auth.machine)}` : (auth.bearer as string));
      for (const [name, value] of Object.entries(headers)) req.set(name, value);
      const res = await req.send({});
      expect(res.status).toBe(200);
      return spy.mock.calls[0][0];
    } finally {
      spy.mockRestore();
    }
  }

  const pair = { [PROXY_HUB_NODE_ID_HEADER]: '12', [PROXY_HUB_NODE_NAME_HEADER]: encodeURIComponent('sencho-test-02') };

  it.each(['node_proxy', 'pilot_tunnel'] as const)('names the hub\'s node on a %s hop', async (machine) => {
    const input = await previewInput(pair, { machine });
    expect(input.hubNode).toEqual({ id: 12, name: 'sencho-test-02' });
    expect(input.transport).toBe(machine);
  });

  it('names nothing from a caller that is not a machine hop', async () => {
    const input = await previewInput(pair, { bearer: adminBearer });
    expect(input.hubNode).toBeUndefined();
    expect(input.transport).toBe('local');
  });

  it('falls back to the instance\'s own node when a hub sent nothing usable', async () => {
    const input = await previewInput({ [PROXY_HUB_NODE_ID_HEADER]: 'x', [PROXY_HUB_NODE_NAME_HEADER]: 'n' }, { machine: 'node_proxy' });
    expect(input.hubNode).toBeUndefined();
  });
});

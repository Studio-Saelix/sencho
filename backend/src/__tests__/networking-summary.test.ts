/**
 * The per-node networking summary and its routes: a stack that publishes a
 * non-loopback port counts as exposed and, with no intent set, as
 * unknown-exposure; the node-local route and the proxy-exempt fleet aggregate
 * both return it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const STACK = 'netsummary';

function stubSnapshot() {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
  } as unknown as DockerController);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('networking summary', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "0.0.0.0:8080:80"\n');
    stubSnapshot();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('node-local summary marks a published stack exposed and unknown-exposure', async () => {
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).toContain(STACK);
    expect(res.body.networkDrift.stacks).toEqual([]); // empty snapshot, no running containers
    expect(res.body.exposed.count).toBe(res.body.exposed.stacks.length);
  });

  it('flags a stack with an undeclared runtime network as network drift', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({
        containers: [{ id: 'c1', name: 'web1', service: 'web', composeProject: STACK, stack: STACK, state: 'running', image: 'nginx', networks: [{ name: `${STACK}_default`, id: 'd', ip: '' }, { name: `${STACK}_rogue`, id: 'r', ip: '' }], volumes: [], ports: [] }],
        networks: [
          { id: 'd', name: `${STACK}_default`, driver: 'bridge', scope: 'local', isSystem: false, composeProject: STACK, stack: STACK },
          { id: 'r', name: `${STACK}_rogue`, driver: 'bridge', scope: 'local', isSystem: false, composeProject: STACK, stack: STACK },
        ],
        volumes: [],
      }),
    } as unknown as DockerController);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.networkDrift.stacks).toContain(STACK);
  });

  it('still reports declared signals when the snapshot is unavailable (drift skipped)', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockRejectedValue(new Error('docker down')),
    } as unknown as DockerController);
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.networkDrift.stacks).toEqual([]);
  });

  it('drops the stack from unknown-exposure once an intent is set', async () => {
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'public', 'admin');
    const res = await request(app).get('/api/networking/summary').set('Authorization', authHeader);
    expect(res.body.exposed.stacks).toContain(STACK);
    expect(res.body.unknownExposure.stacks).not.toContain(STACK);
  });

  it('the fleet aggregate returns a per-node summary for the hub', async () => {
    const res = await request(app).get('/api/fleet/networking-summary').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    const local = res.body.nodes.find((n: { status: string; summary: { exposed: { stacks: string[] } } | null }) => n.summary?.exposed.stacks.includes(STACK));
    expect(local).toBeDefined();
    expect(local.status).toBe('ok');
    expect(local.summary.unknownExposure).toBeDefined();
    expect(local.summary.networkDrift).toBeDefined();
  });

  it('degrades a remote that errors to a node-error while keeping the hub', async () => {
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({ name: 'remote-degrade', type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: 'http://remote.invalid', api_token: 't' });
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => id === remoteId ? { apiUrl: 'http://remote.invalid', apiToken: 't' } : null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    try {
      const res = await request(app).get('/api/fleet/networking-summary').set('Authorization', authHeader);
      expect(res.status).toBe(200);
      const hub = res.body.nodes.find((n: { summary: unknown }) => n.summary !== null);
      const remote = res.body.nodes.find((n: { nodeId: number }) => n.nodeId === remoteId);
      expect(hub.status).toBe('ok');
      expect(remote.status).toBe('error');
      expect(remote.summary).toBeNull();
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('rejects an unauthenticated request to the node-local summary', async () => {
    expect((await request(app).get('/api/networking/summary')).status).toBe(401);
  });
});

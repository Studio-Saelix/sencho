/**
 * Node networking operator routes: auth boundaries, aggregate reads, delete guards.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';
import { DatabaseService } from '../services/DatabaseService';
import { evaluateNetworkDeleteGuard } from '../services/network/networkDeleteGuards';
import SelfIdentityService from '../services/SelfIdentityService';
import { invalidateNodeNetworkingAggregate } from '../services/network/networkingAggregateCache';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const STACK = 'netop';

function token(username: string, role: string, tokenVersion = 1): string {
  const user = DatabaseService.getInstance().getUserByUsername(username);
  return `Bearer ${jwt.sign(
    { username, role, tokenVersion: user?.token_version ?? tokenVersion },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  )}`;
}

const NET_ID = 'abcdefabcdef';

function stubAggregate() {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({
      containers: [],
      networks: [
        { id: NET_ID, name: 'orphan_net', driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null },
      ],
      volumes: [],
    }),
    inspectNetwork: vi.fn().mockResolvedValue({
      Id: NET_ID,
      Name: 'orphan_net',
      Driver: 'bridge',
      Scope: 'local',
      Labels: { 'com.example.key': 'secret-value' },
      Containers: {},
    }),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
  } as unknown as DockerController);

  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: JSON.stringify({
        name: STACK,
        services: { web: { image: 'nginx:latest', networks: { backend: null } } },
        networks: { backend: { name: `${STACK}_backend` } },
        volumes: {},
      }),
      stderr: '',
      code: 0,
      timedOut: false,
    }),
  } as unknown as ComposeService);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = token(TEST_USERNAME, 'admin');
});

afterAll(() => cleanupTestDb(tmpDir));

describe('networking operator routes', () => {
  let stackDir: string;

  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n');
    stubAggregate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    invalidateNodeNetworkingAggregate(1);
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('keeps GET /api/networking/summary auth-only for viewers', async () => {
    const db = DatabaseService.getInstance();
    db.addUser({ username: 'net-viewer', password_hash: 'x', role: 'viewer' });
    const viewerHeader = token('net-viewer', 'viewer');
    const res = await request(app).get('/api/networking/summary').set('Authorization', viewerHeader);
    expect(res.status).toBe(200);
  });

  it('requires authentication on new overview route and allows stack:read roles', async () => {
    expect((await request(app).get('/api/networking/overview')).status).toBe(401);

    const db = DatabaseService.getInstance();
    db.addUser({ username: 'net-viewer2', password_hash: 'x', role: 'viewer' });
    const viewerRes = await request(app).get('/api/networking/overview').set('Authorization', token('net-viewer2', 'viewer'));
    expect(viewerRes.status).toBe(200);

    const ok = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
    expect(ok.status).toBe(200);
    expect(ok.body.schemaVersion).toBe(3);
    expect(ok.body.runtimeAvailable).toBe(true);
    expect(ok.body.overview).toBeDefined();
    expect(Array.isArray(ok.body.networks)).toBe(true);
    expect(Array.isArray(ok.body.findings)).toBe(true);
  });

  it('sanitized network inspect returns label keys only', async () => {
    const res = await request(app).get(`/api/networking/networks/${NET_ID}`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(3);
    expect(res.body.network.labelKeys).toEqual(['com.example.key']);
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
  });

  it('returns a degraded schema envelope when Docker networking is unavailable', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockRejectedValue(new Error('runtime unavailable')),
    } as unknown as DockerController);

    const res = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      schemaVersion: 3,
      runtimeAvailable: false,
      networks: [],
    });
    expect(res.body.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime-unavailable', severity: 'info' }),
    ]));
    expect(res.body.findings.every((finding: { severity: string }) => !['warning', 'error'].includes(finding.severity))).toBe(true);
  });

  it('blocks admin delete when network is attached', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({
        containers: [{ id: 'c1', name: 'web', service: 'web', composeProject: STACK, stack: STACK, state: 'running', exitCode: null, image: 'nginx', networks: [{ name: 'orphan_net', id: NET_ID, ip: '' }], volumes: [], ports: [] }],
        networks: [{ id: NET_ID, name: 'orphan_net', driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null }],
        volumes: [],
      }),
      removeNetwork: vi.fn(),
    } as unknown as DockerController);

    const removeSpy = vi.spyOn(DockerController.getInstance(1), 'removeNetwork');
    const res = await request(app)
      .post('/api/system/networks/delete')
      .set('Authorization', authHeader)
      .send({ id: NET_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('attached');
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe('classifySnapshotNetworks', () => {
  it('preserves composeProject on external ownership rows', () => {
    const snapshot = {
      containers: [],
      networks: [{
        id: 'ext1',
        name: 'external_shared',
        driver: 'bridge',
        scope: 'local',
        isSystem: false,
        composeProject: 'other-project',
        stack: null,
      }],
      volumes: [],
    };
    const rows = DockerController.classifySnapshotNetworks(snapshot, ['localstack']);
    expect(rows[0].composeProject).toBe('other-project');
    expect(rows[0].stack).toBeNull();
    expect(rows[0].ownership).toBe('compose-managed');
  });
});

describe('evaluateNetworkDeleteGuard', () => {
  it('fails closed with stack-declaration-unknown when stacks are unrenderable', () => {
    const snapshot = {
      containers: [],
      networks: [{ id: 'n1', name: 'app_net', driver: 'bridge', scope: 'local', isSystem: false, composeProject: STACK, stack: STACK }],
      volumes: [],
    };
    const guard = evaluateNetworkDeleteGuard('n1', snapshot, [
      { stack: STACK, renderable: false, renderError: 'x', runtime: 'available', networks: [], services: [], drift: { runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [] }, missingExternalNetworks: [] },
    ]);
    expect(guard.blocked).toBe(true);
    expect(guard.code).toBe('stack-declaration-unknown');
  });

  it('fails closed for an unlabeled external network while a stack is unrenderable', () => {
    const snapshot = {
      containers: [],
      networks: [{ id: 'n1', name: 'shared_ext', driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null }],
      volumes: [],
    };
    const guard = evaluateNetworkDeleteGuard('n1', snapshot, [
      { stack: STACK, renderable: false, renderError: 'compose file invalid', runtime: 'available', networks: [{ key: 'shared_ext', name: 'shared_ext', external: true, internal: false, createdByStack: false }], services: [], drift: { runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [] }, missingExternalNetworks: [] },
    ]);
    expect(guard.blocked).toBe(true);
    expect(guard.code).toBe('stack-declaration-unknown');
  });

  it('blocks a system network ahead of every other reason', () => {
    const snapshot = {
      containers: [], volumes: [],
      networks: [{ id: 'sys', name: 'bridge', driver: 'bridge', scope: 'local', isSystem: true, composeProject: null, stack: null }],
    };
    expect(evaluateNetworkDeleteGuard('sys', snapshot, []).code).toBe('system-network');
  });

  it('blocks a Sencho-owned network', () => {
    const spy = vi.spyOn(SelfIdentityService.getInstance(), 'isOwnNetwork').mockReturnValue(true);
    try {
      const snapshot = {
        containers: [], volumes: [],
        networks: [{ id: 'own', name: 'sencho_mesh', driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null }],
      };
      expect(evaluateNetworkDeleteGuard('own', snapshot, []).code).toBe('sencho-owned');
    } finally {
      spy.mockRestore();
    }
  });

  it('blocks a network that still has an attached container', () => {
    const snapshot = {
      volumes: [],
      containers: [{ id: 'c1', name: 'web', service: 'web', composeProject: STACK, stack: STACK, state: 'running', exitCode: null, image: 'img', networks: [{ name: 'app_net', id: 'n1', ip: '' }], volumes: [], ports: [] }],
      networks: [{ id: 'n1', name: 'app_net', driver: 'bridge', scope: 'local', isSystem: false, composeProject: STACK, stack: STACK }],
    };
    expect(evaluateNetworkDeleteGuard('n1', snapshot, []).code).toBe('attached');
  });

  it('blocks a network a renderable stack declares', () => {
    const snapshot = {
      containers: [], volumes: [],
      networks: [{ id: 'n1', name: 'app_net', driver: 'bridge', scope: 'local', isSystem: false, composeProject: STACK, stack: STACK }],
    };
    const guard = evaluateNetworkDeleteGuard('n1', snapshot, [
      { stack: STACK, renderable: true, renderError: null, runtime: 'available',
        networks: [{ key: 'app_net', name: 'app_net', external: false, internal: false, createdByStack: true }],
        services: [], drift: { runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [] },
        missingExternalNetworks: [] },
    ]);
    expect(guard.code).toBe('stack-declared');
  });

  it('allows deleting an unattached, undeclared network', () => {
    const snapshot = {
      containers: [], volumes: [],
      networks: [{ id: 'n1', name: 'orphan_net', driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null }],
    };
    expect(evaluateNetworkDeleteGuard('n1', snapshot, [])).toEqual({ blocked: false });
  });

  it('does not block when the network is absent from the snapshot', () => {
    expect(evaluateNetworkDeleteGuard('ghost', { containers: [], networks: [], volumes: [] }, [])).toEqual({ blocked: false });
  });
});

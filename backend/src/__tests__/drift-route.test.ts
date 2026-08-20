/**
 * Route tests for the per-stack drift endpoint: auth enforcement and that the
 * read-only report is reachable on the Community tier (no tier gate). Deep diff
 * behaviour is covered by drift-detection.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('GET /api/stacks/:stackName/drift', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/stacks/myapp/drift');
    expect(res.status).toBe(401);
  });

  it('is reachable on the Community tier (404 for an unknown stack, not 403)', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app).get('/api/stacks/myapp/drift').set('Authorization', authHeader);
    expect(res.status).toBe(404);
    vi.restoreAllMocks();
  });

  it('returns 200 with a report for an existing stack on the Community tier', async () => {
    const composeDir = process.env.COMPOSE_DIR as string;
    const stackDir = path.join(composeDir, 'driftroutetest');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    // Stub only the Docker boundary so the test is deterministic and daemon-free;
    // the route, requireStackExists, compose parse, and the diff all run for real.
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
    } as unknown as DockerController);

    const res = await request(app).get('/api/stacks/driftroutetest/drift').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stack: 'driftroutetest', status: 'missing-runtime' });
    expect(Array.isArray(res.body.findings)).toBe(true);

    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });
});

describe('drift payload carries the GitOps revision', () => {
  const STACK = 'driftgitopstest';

  // Cleanup belongs here, not at the end of each test body. A failing
  // assertion would otherwise leak a blueprint, a deployment, and an
  // application into the next test, which reuses this stack name and
  // asserts not_applicable: one real failure would become two, and the
  // second would point at innocent code.
  afterEach(async () => {
    vi.restoreAllMocks();
    fs.rmSync(path.join(process.env.COMPOSE_DIR as string, STACK), { recursive: true, force: true });
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance().getDb();
    for (const table of ['gitops_applications', 'blueprint_deployments', 'blueprints']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });

  function stubDockerBoundary(): void {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
    } as unknown as DockerController);
  }

  function makeStack(): void {
    const stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
  }

  it('adds gitopsRevision to the GET without disturbing the ledger fields', async () => {
    makeStack();
    stubDockerBoundary();

    const res = await request(app).get(`/api/stacks/${STACK}/drift`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    // A stack with no Git source has no application, so the uniform
    // not-applicable shape is what a reader gets rather than a missing key.
    expect(res.body.gitopsRevision).toMatchObject({ schemaVersion: 1, targetMode: 'not_applicable' });
    expect(res.body.gitopsRevision.drift).toEqual([]);
    // The ledger surface is untouched: this field is additive, not a rewrite.
    expect(res.body).toMatchObject({ stack: STACK });
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(Array.isArray(res.body.ledger)).toBe(true);
    expect(res.body.temporal).toBeDefined();

  });

  it('resolves the Blueprint that owns the stack directory, not just Direct Git', async () => {
    // A Blueprint application is stored with stack_name NULL, so no lookup by
    // stack name reaches it, yet the reconciler materializes the Blueprint as a
    // stack directory of that name. Without the deployment bridge the Drift tab
    // reports not_applicable for a stack GitOps is actively managing, while the
    // Blueprint page reports a live application for the very same thing.
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes().find(n => n.is_default)?.id as number;
    expect(typeof nodeId).toBe('number');

    const blueprint = db.createBlueprint({
      name: STACK,
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [nodeId] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'admin',
    });
    // last_deployed_at is what proves this Blueprint actually wrote the
    // directory, which is the predicate the bridge requires.
    db.upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: nodeId,
      status: 'active',
      applied_revision: 1,
      last_deployed_at: Date.now(),
    });
    const { GitOpsTransitions } = await import('../services/gitops/transitions');
    const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
    GitOpsTransitions.getInstance().activateInlineBlueprint({
      application: blankInlineApplication('app-bp-drift', blueprint.id, Date.now()),
      envelope: { operationId: 'op-bp-drift', actor: 'tester', trigger: 'manual', at: Date.now() },
    });

    makeStack();
    stubDockerBoundary();
    const res = await request(app).get(`/api/stacks/${STACK}/drift`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.gitopsRevision).toMatchObject({
      applicationId: 'app-bp-drift',
      targetMode: 'inline_blueprint',
      blueprintId: blueprint.id,
    });

  });

  it('refuses to claim a stack the Blueprint could not deploy onto', async () => {
    // name_conflict is written precisely when a stack of that name already
    // exists on the node and Sencho does not own it. A deployment row exists,
    // so a present-row check would treat it as ownership and hand the unrelated
    // stack's operator this Blueprint's repository, ref, and SHA pointers: the
    // exact collision the deployment check is supposed to rule out.
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes().find(n => n.is_default)?.id as number;
    const blueprint = db.createBlueprint({
      name: STACK,
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [nodeId] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'admin',
    });
    db.upsertDeployment({ blueprint_id: blueprint.id, node_id: nodeId, status: 'name_conflict' });
    const { GitOpsTransitions } = await import('../services/gitops/transitions');
    const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
    GitOpsTransitions.getInstance().activateInlineBlueprint({
      application: blankInlineApplication('app-bp-conflict', blueprint.id, Date.now()),
      envelope: { operationId: 'op-bp-conflict', actor: 'tester', trigger: 'manual', at: Date.now() },
    });

    makeStack();
    stubDockerBoundary();
    const res = await request(app).get(`/api/stacks/${STACK}/drift`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.gitopsRevision).toMatchObject({ targetMode: 'not_applicable', applicationId: null });
  });

  it('refuses to claim a stack the Blueprint has never deployed', async () => {
    // A pending or first-deploy-failed row has nothing of ours on the node
    // either, so last_deployed_at is what proves the directory is the
    // Blueprint's work.
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes().find(n => n.is_default)?.id as number;
    const blueprint = db.createBlueprint({
      name: STACK,
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [nodeId] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'admin',
    });
    db.upsertDeployment({ blueprint_id: blueprint.id, node_id: nodeId, status: 'pending' });
    const { GitOpsTransitions } = await import('../services/gitops/transitions');
    const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
    GitOpsTransitions.getInstance().activateInlineBlueprint({
      application: blankInlineApplication('app-bp-pending', blueprint.id, Date.now()),
      envelope: { operationId: 'op-bp-pending', actor: 'tester', trigger: 'manual', at: Date.now() },
    });

    makeStack();
    stubDockerBoundary();
    const res = await request(app).get(`/api/stacks/${STACK}/drift`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.gitopsRevision).toMatchObject({ targetMode: 'not_applicable', applicationId: null });
  });

  it('adds the same gitopsRevision to the re-check', async () => {
    makeStack();
    stubDockerBoundary();

    const res = await request(app).post(`/api/stacks/${STACK}/drift/recheck`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.gitopsRevision).toMatchObject({ schemaVersion: 1, targetMode: 'not_applicable' });
    expect(Array.isArray(res.body.ledger)).toBe(true);

  });
});

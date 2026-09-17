/**
 * Authorization and wiring for Blueprint GitOps content-binding routes.
 *
 * Read stays on node:read (same as Blueprint detail). Convert, preview,
 * detach, and retire require stack:edit. Adopt requires stack:edit and stack:deploy on
 * the named Direct stack, plus stack:edit on the Blueprint name.
 * Community admins are allowed; the descriptor never names the retained
 * source-stack identity.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { LicenseTier } from '../services/license-types';
import type { Blueprint } from '../services/DatabaseService';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let adminCookie: string;
let viewerCookie: string;
let deployerCookie: string;
let counter = 0;

function setLicense(tier: LicenseTier): void {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

function seedBlueprint(): Blueprint {
  counter += 1;
  return DatabaseService.getInstance().createBlueprint({
    name: `bp-bind-${counter}`,
    description: null,
    compose_content: 'services:\n  app:\n    image: nginx\n',
    selector: { type: 'nodes', ids: [1] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'admin',
  });
}

function seedDirect(stackName: string): string {
  const application = {
    ...directApplicationFixture(`app-${stackName}`, stackName),
    configured_repo_url: `https://github.com/example/${stackName}.git`,
  };
  GitOpsTransitions.getInstance().activateDirect({
    application,
    nodeId: 1,
    envelope: { operationId: `op-${stackName}`, actor: 'tester', trigger: 'manual', at: Date.now() },
  });
  return application.id;
}

function seedBlueprintAndDirect(): { blueprint: Blueprint; stackName: string; applicationId: string } {
  const blueprint = seedBlueprint();
  const stackName = `stack-${blueprint.name}`;
  return { blueprint, stackName, applicationId: seedDirect(stackName) };
}

function expectNoSourceIdentity(body: unknown): void {
  expect(body).not.toHaveProperty('configured_source_stack_name');
  expect(body).not.toHaveProperty('stackName');
}

async function seedAndLoginRole(username: string, password: string, role: 'viewer' | 'deployer'): Promise<string> {
  const passwordHash = await bcrypt.hash(password, 1);
  DatabaseService.getInstance().addUser({
    username,
    password_hash: passwordHash,
    role,
  });
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username, password });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  viewerCookie = await seedAndLoginRole('bind-viewer', 'bind-viewer-pass', 'viewer');
  deployerCookie = await seedAndLoginRole('bind-deployer', 'bind-deployer-pass', 'deployer');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  setLicense('paid');
});

describe('GET /api/blueprints/:id/content-binding', () => {
  it('lets a viewer read a binding descriptor', async () => {
    const bp = seedBlueprint();
    const res = await request(app)
      .get(`/api/blueprints/${bp.id}/content-binding`)
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body.contentOrigin).toBe('inline');
    expectNoSourceIdentity(res.body);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(app).get('/api/blueprints/1/content-binding');
    expect(res.status).toBe(401);
  });
});

describe('content-binding mutations reject viewers', () => {
  it.each([
    { name: 'preview convert', method: 'post' as const, path: '/api/blueprints/1/content-binding/preview', body: { applicationId: 'app-x' } },
    { name: 'convert', method: 'put' as const, path: '/api/blueprints/1/content-binding', body: { applicationId: 'app-x' } },
    { name: 'detach preview', method: 'post' as const, path: '/api/blueprints/1/content-binding/detach/preview', body: {} },
    { name: 'detach', method: 'delete' as const, path: '/api/blueprints/1/content-binding', body: { applicationId: 'app-x' } },
    { name: 'retire preview', method: 'post' as const, path: '/api/blueprints/1/content-binding/retire/preview', body: {} },
    { name: 'retire', method: 'post' as const, path: '/api/blueprints/1/content-binding/retire', body: {} },
    { name: 'preview adopt', method: 'post' as const, path: '/api/stacks/web/git-source/adopt-blueprint/preview', body: { blueprintId: 1 } },
    { name: 'adopt', method: 'post' as const, path: '/api/stacks/web/git-source/adopt-blueprint', body: { blueprintId: 1 } },
  ])('does not let a viewer $name', async ({ method, path, body }) => {
    const res = await request(app)[method](path).set('Cookie', viewerCookie).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('Admin convert, read, detach, and adopt', () => {
  it('lets a Community admin convert, describe, and detach without leaking source identity', async () => {
    setLicense('community');
    const { blueprint: bp, stackName, applicationId } = seedBlueprintAndDirect();

    const preview = await request(app)
      .post(`/api/blueprints/${bp.id}/content-binding/preview`)
      .set('Cookie', adminCookie)
      .send({ applicationId });
    expect(preview.status).toBe(200);
    expect(preview.body.transition).toBe('convert');
    expect(preview.body.proposedOrigin).toBe('git');

    const convert = await request(app)
      .put(`/api/blueprints/${bp.id}/content-binding`)
      .set('Cookie', adminCookie)
      .send({ applicationId });
    expect(convert.status).toBe(200);
    expect(convert.body).toMatchObject({
      contentOrigin: 'git',
      applicationId,
      repoUrl: `https://github.com/example/${stackName}.git`,
      ref: 'main',
      composePaths: ['compose.yaml'],
      blockedRollout: true,
      snapshotPresent: true,
    });
    expectNoSourceIdentity(convert.body);
    expect(GitOpsStore.getInstance().getApplication(applicationId)).toMatchObject({
      target_mode: 'blueprint',
      configured_source_stack_name: stackName,
    });

    const detail = await request(app)
      .get(`/api/blueprints/${bp.id}`)
      .set('Cookie', adminCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.blueprint.content_origin).toBe('git');
    expect(detail.body.blueprint.application_id).toBe(applicationId);

    const bound = await request(app)
      .get(`/api/blueprints/${bp.id}/content-binding`)
      .set('Cookie', adminCookie);
    expect(bound.status).toBe(200);
    expect(bound.body.contentOrigin).toBe('git');
    expect(bound.body.applicationId).toBe(applicationId);
    expectNoSourceIdentity(bound.body);

    const detachPreview = await request(app)
      .post(`/api/blueprints/${bp.id}/content-binding/detach/preview`)
      .set('Cookie', adminCookie);
    expect(detachPreview.status).toBe(200);
    expect(detachPreview.body.transition).toBe('detach');
    expect(Array.isArray(detachPreview.body.markers)).toBe(true);

    const detach = await request(app)
      .delete(`/api/blueprints/${bp.id}/content-binding`)
      .set('Cookie', adminCookie);
    expect(detach.status).toBe(200);
    expect(detach.body.contentOrigin).toBe('inline');
    expect(detach.body.applicationId).toBeNull();
  });

  it('lets a Community admin preview and retire a converted Blueprint without active deployments', async () => {
    setLicense('community');
    const { blueprint: bp, applicationId } = seedBlueprintAndDirect();
    await request(app)
      .put(`/api/blueprints/${bp.id}/content-binding`)
      .set('Cookie', adminCookie)
      .send({ applicationId });

    const preview = await request(app)
      .post(`/api/blueprints/${bp.id}/content-binding/retire/preview`)
      .set('Cookie', adminCookie);
    expect(preview.status).toBe(200);
    expect(preview.body.transition).toBe('retire');

    const retire = await request(app)
      .post(`/api/blueprints/${bp.id}/content-binding/retire`)
      .set('Cookie', adminCookie);
    expect(retire.status).toBe(200);
    expect(retire.body.contentOrigin).toBe('inline');
    expect(retire.body.applicationId).toBeNull();
    expect(GitOpsStore.getInstance().getApplication(applicationId)).toMatchObject({
      target_mode: 'direct',
      stack_name: bp.name,
      configured_source_stack_name: null,
    });
  });

  it('returns 409 deployments_active when retire is attempted with live deployments', async () => {
    const { blueprint: bp, applicationId } = seedBlueprintAndDirect();
    await request(app)
      .put(`/api/blueprints/${bp.id}/content-binding`)
      .set('Cookie', adminCookie)
      .send({ applicationId });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: bp.id,
      node_id: 1,
      status: 'active',
    });

    const res = await request(app)
      .post(`/api/blueprints/${bp.id}/content-binding/retire`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('deployments_active');
  });

  it('lets a Community admin adopt a Direct stack onto a Blueprint', async () => {
    setLicense('community');
    const { blueprint: bp, stackName, applicationId } = seedBlueprintAndDirect();

    const preview = await request(app)
      .post(`/api/stacks/${stackName}/git-source/adopt-blueprint/preview`)
      .set('Cookie', adminCookie)
      .send({ blueprintId: bp.id });
    expect(preview.status).toBe(200);
    expect(preview.body.transition).toBe('adopt');

    const adopt = await request(app)
      .post(`/api/stacks/${stackName}/git-source/adopt-blueprint`)
      .set('Cookie', adminCookie)
      .send({ blueprintId: bp.id });
    expect(adopt.status).toBe(200);
    expect(adopt.body).toMatchObject({
      contentOrigin: 'git',
      applicationId,
      blockedRollout: true,
    });
    expectNoSourceIdentity(adopt.body);
  });

  it('returns 409 when convert targets a missing Direct application', async () => {
    const bp = seedBlueprint();
    const res = await request(app)
      .put(`/api/blueprints/${bp.id}/content-binding`)
      .set('Cookie', adminCookie)
      .send({ applicationId: 'missing-direct-app' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('application_not_direct');
    expectNoSourceIdentity(res.body);
  });

  it('does not let a deployer adopt, because stack:edit is required', async () => {
    const { blueprint: bp, stackName } = seedBlueprintAndDirect();
    const res = await request(app)
      .post(`/api/stacks/${stackName}/git-source/adopt-blueprint`)
      .set('Cookie', deployerCookie)
      .send({ blueprintId: bp.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('returns 404 when adopt names a missing Blueprint', async () => {
    const { stackName } = seedBlueprintAndDirect();
    const res = await request(app)
      .post(`/api/stacks/${stackName}/git-source/adopt-blueprint`)
      .set('Cookie', adminCookie)
      .send({ blueprintId: 999999 });
    expect(res.status).toBe(404);
  });

  it('returns 409 when adopt has no live Direct application', async () => {
    const bp = seedBlueprint();
    const res = await request(app)
      .post('/api/stacks/missing-direct/git-source/adopt-blueprint')
      .set('Cookie', adminCookie)
      .send({ blueprintId: bp.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('application_not_direct');
  });
});

/**
 * Check again on a Blueprint name conflict:
 * POST /api/blueprints/:id/deployments/:nodeId/recheck re-runs the ownership
 * check only. A name still taken leaves the row alone, a free name releases it
 * to `pending`, a check that cannot tell leaves it in conflict, and the route
 * never deploys. What a released row then does is the reconcile tick's decision,
 * pinned here so the consequence is not a surprise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { intentFingerprint, serializeApprovedBlast } from '../services/blueprintApproval';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerAuth: string;
let deployerAuth: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let BlueprintOwnershipProbeError: typeof import('../services/BlueprintService').BlueprintOwnershipProbeError;
let counter = 0;

const STATEFUL_COMPOSE = 'services:\n  app:\n    image: nginx\n    volumes:\n      - data:/data\nvolumes:\n  data:\n';

function seedNode(): { id: number; name: string } {
  counter += 1;
  const name = `bp-recheck-node-${counter}`;
  const result = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(name, Date.now());
  return { id: result.lastInsertRowid as number, name };
}

function seedBlueprint(nodeId: number, compose = 'services:\n  app:\n    image: nginx\n') {
  counter += 1;
  const classification = compose === STATEFUL_COMPOSE ? 'stateful' : 'stateless';
  return DatabaseService.getInstance().createBlueprint({
    name: `bp-recheck-${counter}`,
    description: null,
    compose_content: compose,
    selector: { type: 'nodes', ids: [nodeId] },
    drift_mode: 'observe',
    classification,
    classification_reasons: classification === 'stateful' ? ['named volume'] : [],
    enabled: true,
    created_by: 'admin',
  });
}

function approvePlace(blueprintId: number, nodeId: number): void {
  const bp = DatabaseService.getInstance().getBlueprint(blueprintId)!;
  DatabaseService.getInstance().setBlueprintApproval(blueprintId, {
    intentFingerprint: intentFingerprint(bp),
    blastJson: serializeApprovedBlast([{ nodeId, outcome: 'place' as const }]),
    approvedBy: 'admin',
  });
}

function seedConflict(blueprintId: number, nodeId: number): void {
  DatabaseService.getInstance().upsertDeployment({
    blueprint_id: blueprintId,
    node_id: nodeId,
    status: 'name_conflict',
    last_error: 'a stack named this already exists',
  });
}

const deployment = (blueprintId: number, nodeId: number) => DatabaseService.getInstance().getDeployment(blueprintId, nodeId);

const recheck = (blueprintId: number, nodeId: number, auth?: string) => {
  const req = request(app).post(`/api/blueprints/${blueprintId}/deployments/${nodeId}/recheck`);
  return auth ? req.set('Authorization', auth) : req.set('Cookie', adminCookie);
};

/** Spies on every path that could deploy, so a test can say none was taken. */
function watchDeploys() {
  const svc = BlueprintService.getInstance();
  return {
    deployToNode: vi.spyOn(svc, 'deployToNode').mockResolvedValue({ status: 'active' }),
    forceDeploy: vi.spyOn(BlueprintReconciler.getInstance(), 'forceDeploy').mockResolvedValue(undefined),
  };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));
  ({ BlueprintService, BlueprintOwnershipProbeError } = await import('../services/BlueprintService'));
  adminCookie = await loginAsTestAdmin(app);

  const db = DatabaseService.getInstance();
  const sign = (username: string, tv: number) =>
    `Bearer ${jwt.sign({ username, role: 'viewer', tv }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  const hash = await bcrypt.hash('password123', 1);
  db.addUser({ username: 'recheck-viewer', password_hash: hash, role: 'viewer' });
  viewerAuth = sign('recheck-viewer', db.getUserByUsername('recheck-viewer')!.token_version);
  db.addUser({ username: 'recheck-deployer', password_hash: hash, role: 'viewer' });
  deployerAuth = sign('recheck-deployer', db.getUserByUsername('recheck-deployer')!.token_version);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM blueprint_deployments').run();
  db.prepare('DELETE FROM blueprints').run();
  db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
  db.prepare("DELETE FROM role_assignments WHERE user_id IN (SELECT id FROM users WHERE username = 'recheck-deployer')").run();
});

function grantDeploy(stackName: string, nodeId: number): void {
  const db = DatabaseService.getInstance();
  const user = db.getUserByUsername('recheck-deployer')!;
  db.addRoleAssignment({ user_id: user.id, role: 'deployer', resource_type: 'stack', resource_id: stackName, node_id: nodeId });
}

describe('POST /api/blueprints/:id/deployments/:nodeId/recheck', () => {
  it('leaves a name that is still taken in conflict, and deploys nothing', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(true);
    const deploys = watchDeploys();

    const res = await recheck(bp.id, node.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: false, status: 'name_conflict' });
    expect(deployment(bp.id, node.id)).toMatchObject({ status: 'name_conflict', last_error: 'a stack named this already exists' });
    expect(deploys.deployToNode).not.toHaveBeenCalled();
    expect(deploys.forceDeploy).not.toHaveBeenCalled();
  });

  it('releases a row whose name is free to pending, and still deploys nothing itself', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    approvePlace(bp.id, node.id);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(false);
    const deploys = watchDeploys();

    const res = await recheck(bp.id, node.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true, status: 'pending' });
    expect(deployment(bp.id, node.id)).toMatchObject({ status: 'pending', last_error: null });
    expect(deploys.deployToNode).not.toHaveBeenCalled();
    expect(deploys.forceDeploy).not.toHaveBeenCalled();
  });

  it('is deployed by the next reconcile tick when the Blueprint is stateless and approved', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    approvePlace(bp.id, node.id);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(false);
    await recheck(bp.id, node.id);
    const deploys = watchDeploys();

    await BlueprintReconciler.getInstance().reconcileOne(bp.id);

    expect(deploys.deployToNode).toHaveBeenCalledTimes(1);
    expect((deploys.deployToNode.mock.calls[0]?.[1] as { id: number }).id).toBe(node.id);
  });

  it('is held for state review, not deployed, when the Blueprint is stateful', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id, STATEFUL_COMPOSE);
    seedConflict(bp.id, node.id);
    approvePlace(bp.id, node.id);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(false);
    await recheck(bp.id, node.id);
    const deploys = watchDeploys();

    await BlueprintReconciler.getInstance().reconcileOne(bp.id);

    expect(deploys.deployToNode).not.toHaveBeenCalled();
    expect(deployment(bp.id, node.id)?.status).toBe('pending_state_review');
  });

  it('keeps the row in conflict and answers an error when ownership cannot be checked', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict')
      .mockRejectedValue(new BlueprintOwnershipProbeError('Cannot verify stack ownership on remote node "edge"'));
    const deploys = watchDeploys();

    const res = await recheck(bp.id, node.id);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('ownership_probe_failed');
    expect(res.body.error).toMatch(/Cannot verify stack ownership/);
    expect(deployment(bp.id, node.id)?.status).toBe('name_conflict');
    expect(deploys.deployToNode).not.toHaveBeenCalled();
  });

  it('does not overwrite a row that moved while the check ran', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockImplementation(async () => {
      DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: node.id, status: 'deploying' });
      return false;
    });

    const res = await recheck(bp.id, node.id);

    expect(res.body).toEqual({ cleared: false, status: 'deploying' });
    expect(deployment(bp.id, node.id)?.status).toBe('deploying');
  });

  it('refuses a deployment that is not in a name conflict', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: node.id, status: 'failed' });
    const probe = vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict');

    const res = await recheck(bp.id, node.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'not_name_conflict', status: 'failed' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown Blueprint and for a node with no deployment', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    expect((await recheck(99999, node.id)).status).toBe(404);
    expect((await recheck(bp.id, node.id)).status).toBe(404);
  });

  it('refuses a Git-managed Blueprint, whose targets the GitOps rollout owns', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    // Only content_origin matters to this route. A real Git-managed row needs a bound
    // application (the table CHECK requires application_id), which the Git-managed gate
    // tests cover, so that CHECK is bypassed for this one write.
    const raw = DatabaseService.getInstance().getDb();
    raw.pragma('ignore_check_constraints = ON');
    try {
      raw.prepare("UPDATE blueprints SET content_origin = 'git' WHERE id = ?").run(bp.id);
    } finally {
      raw.pragma('ignore_check_constraints = OFF');
    }
    const probe = vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict');

    const res = await recheck(bp.id, node.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('git_managed_content');
    expect(probe).not.toHaveBeenCalled();
    expect(deployment(bp.id, node.id)?.status).toBe('name_conflict');
  });

  it('refuses a viewer, and a deployer of a different stack or node, without checking', async () => {
    const node = seedNode();
    const other = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    const probe = vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(false);

    expect((await recheck(bp.id, node.id, viewerAuth)).status).toBe(403);
    grantDeploy('some-other-stack', node.id);
    expect((await recheck(bp.id, node.id, deployerAuth)).status).toBe(403);
    grantDeploy(bp.name, other.id);
    expect((await recheck(bp.id, node.id, deployerAuth)).status).toBe(403);

    expect(probe).not.toHaveBeenCalled();
    expect(deployment(bp.id, node.id)?.status).toBe('name_conflict');
  });

  it('lets a deployer of exactly this stack on this node check again', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    grantDeploy(bp.name, node.id);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(false);

    const res = await recheck(bp.id, node.id, deployerAuth);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true, status: 'pending' });
  });
});

describe('forceDeploy', () => {
  it('still refuses a name_conflict row, so Check again is the only way out of one', async () => {
    const node = seedNode();
    const bp = seedBlueprint(node.id);
    seedConflict(bp.id, node.id);
    const deployToNode = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });

    await BlueprintReconciler.getInstance().forceDeploy(bp.id, node.id);

    expect(deployToNode).not.toHaveBeenCalled();
    expect(deployment(bp.id, node.id)?.status).toBe('name_conflict');
  });
});

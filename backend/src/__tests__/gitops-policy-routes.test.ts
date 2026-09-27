/**
 * The two policy write routes.
 *
 * The permission behaviour that matters here is the empty-target-set case. A
 * fresh application has no rollout target set yet, which is exactly when an
 * operator wants to choose the placement policy before the first placement, so
 * the gate resolves the Blueprint's own deploy stack name instead of falling
 * back to an application-wide grant that would lock out a scoped operator.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { emptyTargetRow } from '../services/gitops/store';

let tmpDir: string;
let adminCookie: string;
let viewerCookie: string;
let deployerCookie: string;
let scopedCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let app: import('express').Express;

function insertNode(name: string): number {
  const result = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(name, Date.now());
  return result.lastInsertRowid as number;
}

/**
 * A Git-managed Blueprint application, with or without live targets.
 *
 * `nodeCount: 0` is the shape under test: a fresh application that has never
 * placed anything, so `rolloutTargetSet` has nothing to return and the gate has
 * to fall back to the Blueprint's own deploy stack name.
 */
async function seedGitManagedBlueprint(nodeCount: number): Promise<{ blueprintId: number; applicationId: string; nodeIds: number[] }> {
  const { directApplicationFixture } = await import('./helpers/gitopsFixtures');
  const store = GitOpsStore.getInstance();
  const nodeIds: number[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    nodeIds.push(insertNode(`policy-node-${randomUUID().slice(0, 8)}`));
  }
  const applicationId = `app-${randomUUID().slice(0, 8)}`;
  const blueprint = DatabaseService.getInstance().createBlueprint({
    name: `bp-policy-${randomUUID().slice(0, 8)}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:1.25\n',
    selector: { type: 'nodes', ids: nodeIds },
    drift_mode: 'observe',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  });
  // This is what makes the Blueprint Git-managed, and therefore what the
  // authority routes resolve to.
  DatabaseService.getInstance().updateBlueprintContentOrigin(blueprint.id, 'git', applicationId);
  store.insertApplication({
    ...directApplicationFixture(applicationId, `src-${applicationId}`),
    target_mode: 'blueprint',
    lifecycle_key: `blueprint:${blueprint.id}`,
    stack_name: null,
    blueprint_id: blueprint.id,
    intent_revision_id: null,
    rollout_candidate_id: null,
    source_policy: 'review',
    placement_policy: 'operator',
    rollout_authorization_policy: 'manual',
  });
  for (const nodeId of nodeIds) {
    store.upsertTarget({ ...emptyTargetRow(applicationId, nodeId, Date.now()), target_status: 'active' });
  }
  return { blueprintId: blueprint.id, applicationId, nodeIds };
}

/**
 * An operator whose deploy grant is scoped to one stack and nothing else.
 *
 * The only persona that can tell the empty-target-set branch apart from an
 * application-wide grant: a role-based deployer passes either way, because a
 * role grant is global within its action.
 */
async function seedScopedDeployer(stackName: string, nodeId?: number): Promise<string> {
  const userId = DatabaseService.getInstance().getUserByUsername('policy-scoped')!.id;
  nodeId = nodeId ?? insertNode(`scoped-node-${randomUUID().slice(0, 8)}`);
  // A stack assignment is node-qualified by the table's own CHECK, which is the
  // constraint that makes it unresolvable before a node exists.
  DatabaseService.getInstance().getDb()
    .prepare("INSERT INTO role_assignments (user_id, role, resource_type, resource_id, node_id, created_at) VALUES (?, 'deployer', 'stack', ?, ?, ?)")
    .run(userId, stackName, nodeId, Date.now());
  return scopedCookie;
}

async function seedAndLoginRole(username: string, password: string, role: string): Promise<string> {
  const bcryptMod = (await import('bcrypt')).default;
  const passwordHash = await bcryptMod.hash(password, 1);
  DatabaseService.getInstance().addUser({ username, password_hash: passwordHash, role: role as 'viewer' });
  const res = await request(app).post('/api/auth/login').send({ username, password });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  viewerCookie = await seedAndLoginRole('policy-viewer', 'policy-viewer-pass', 'viewer');
  deployerCookie = await seedAndLoginRole('policy-deployer', 'policy-deployer-pass', 'deployer');
  scopedCookie = await seedAndLoginRole('policy-scoped', 'policy-scoped-pass', 'viewer');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
});

describe('POST /api/gitops/applications/:id/placement-policy', () => {
  it('sets the policy on a fresh application with no target set', async () => {
    // The case the gate exists for: nothing is placed yet, so there is no
    // per-target grant to check, and the Blueprint's own deploy stack name is
    // what the write is authorized against.
    const seeded = await seedGitManagedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(200);
    expect(res.body.policy).toBe('bounded_auto');
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_policy).toBe('bounded_auto');
  });

  it('refuses a partially-scoped operator and writes nothing', async () => {
    // The bulk case that matters: a policy write authorizes an action on every
    // frozen target, so an operator entitled to set it for one node and not
    // another must be refused outright. Applying it to the nodes they do hold
    // would leave the fleet split across two policies, half of which nobody
    // chose.
    const seeded = await seedGitManagedBlueprint(2);
    const blueprintName = DatabaseService.getInstance().getBlueprint(seeded.blueprintId)!.name;
    await seedScopedDeployer(blueprintName, seeded.nodeIds[0]);

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', scopedCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(403);
    // Not one of the two targets may be written.
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_policy).toBe('operator');
  });

  it('needs the application-wide grant before anything is placed', async () => {
    // A bounded_auto policy authorizes the system to place and withdraw
    // workloads on whatever nodes the Blueprint's selector matches later, and
    // that set is not known yet. A stack-scoped assignment is node-qualified,
    // so it cannot be resolved for a node that does not exist, which means a
    // narrowly-scoped operator is the wrong authority for a decision about an
    // unknown fleet. This is the conservative answer rather than a gap: an
    // operator whose deploy grant is scoped to nodes that all exist is
    // authorized per target, as the next test shows.
    const seeded = await seedGitManagedBlueprint(0);
    const blueprintName = DatabaseService.getInstance().getBlueprint(seeded.blueprintId)!.name;
    await seedScopedDeployer(blueprintName);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', scopedCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(403);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_policy).toBe('operator');
  });

  it('lets a stack-scoped operator set it once every target is one they hold', async () => {
    // The per-target gate, and the reason it is worth having: a policy that
    // authorizes work on every target is refused unless the caller is entitled
    // for all of them, and here they are.
    const seeded = await seedGitManagedBlueprint(1);
    const blueprintName = DatabaseService.getInstance().getBlueprint(seeded.blueprintId)!.name;
    await seedScopedDeployer(blueprintName, seeded.nodeIds[0]);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', scopedCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(200);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_policy).toBe('bounded_auto');
  });

  it('sets the policy with live targets present', async () => {
    const seeded = await seedGitManagedBlueprint(1);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(200);
  });

  it('refuses a value outside the policy vocabulary', async () => {
    const seeded = await seedGitManagedBlueprint(0);
    for (const policy of ['auto', 'enforce', '', null, 1]) {
      const res = await request(app)
        .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
        .set('Cookie', adminCookie)
        .send({ policy });
      expect(res.status).toBe(400);
    }
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_policy).toBe('operator');
  });

  it('refuses a caller without the create grant', async () => {
    const seeded = await seedGitManagedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', viewerCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(403);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_policy).toBe('operator');
  });

  it('allows an operator who holds deploy, and not because they are an admin', async () => {
    // A deployer holds stack:deploy and nothing else. This is the authority a
    // placement approval itself needs, so it is the authority the policy needs.
    const seeded = await seedGitManagedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', deployerCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(200);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_policy).toBe('bounded_auto');
  });

  it('refuses a write that would change nothing', async () => {
    const seeded = await seedGitManagedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'operator' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/gitops/applications/:id/rollout/authorization-policy', () => {
  it('sets the policy on a fresh application with no target set', async () => {
    const seeded = await seedGitManagedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorization-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'automatic' });
    expect(res.status).toBe(200);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.rollout_authorization_policy).toBe('automatic');
  });

  it('refuses a value outside the policy vocabulary', async () => {
    const seeded = await seedGitManagedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorization-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(400);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.rollout_authorization_policy).toBe('manual');
  });

  it('refuses a caller without the deploy grant', async () => {
    const seeded = await seedGitManagedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorization-policy`)
      .set('Cookie', viewerCookie)
      .send({ policy: 'automatic' });
    expect(res.status).toBe(403);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.rollout_authorization_policy).toBe('manual');
  });

  it('refuses a Direct application, which has no placement or rollout domain', async () => {
    const { directApplicationFixture } = await import('./helpers/gitopsFixtures');
    const applicationId = `direct-${randomUUID().slice(0, 8)}`;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    GitOpsStore.getInstance().insertApplication(directApplicationFixture(applicationId, `stack-${applicationId}`));
    const nodeId = insertNode(`direct-node-${randomUUID().slice(0, 8)}`);
    const res = await request(app)
      .post(`/api/gitops/applications/${nodeId}:${applicationId}/rollout/authorization-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'automatic' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_GIT_MANAGED');
  });
});

/**
 * A Blueprint application demoted back to Inline.
 *
 * The demotion keeps every policy column, and the placement decision does not
 * read the target mode, so a `bounded_auto` application keeps being decided
 * automatically after the demotion. Nothing about placement depends on where the
 * content came from, so resetting the policy here would re-couple the domains
 * this model separates. What has to hold instead is that the operator can still
 * read and set it, which is what these cases pin.
 */
describe('policy writes on a Blueprint demoted to Inline', () => {
  async function seedDemotedBlueprint(nodeCount: number): Promise<{ blueprintId: number; applicationId: string }> {
    const seeded = await seedGitManagedBlueprint(nodeCount);
    GitOpsTransitions.getInstance().blueprintModeDemoted({
      applicationId: seeded.applicationId,
      envelope: { operationId: `op-demote-${randomUUID().slice(0, 8)}`, actor: 'tester', trigger: 'test', at: Date.now() },
    });
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.target_mode).toBe('inline_blueprint');
    return seeded;
  }

  it('lets an operator put the placement policy back to operator review', async () => {
    // The case that matters. A `bounded_auto` application demoted to Inline
    // keeps approving its own stateless placement changes, and while every
    // policy write answered NOT_GIT_MANAGED here the only way to stop it was to
    // edit the row directly.
    const seeded = await seedGitManagedBlueprint(0);
    // Set through the transition, the way an operator would have.
    GitOpsTransitions.getInstance().placementPolicyChanged({
      applicationId: seeded.applicationId,
      placementPolicy: 'bounded_auto',
      envelope: { operationId: `op-auto-${randomUUID().slice(0, 8)}`, actor: 'tester', trigger: 'test', at: Date.now() },
    });
    GitOpsTransitions.getInstance().blueprintModeDemoted({
      applicationId: seeded.applicationId,
      envelope: { operationId: `op-demote-${randomUUID().slice(0, 8)}`, actor: 'tester', trigger: 'test', at: Date.now() },
    });
    const store = GitOpsStore.getInstance();
    expect(store.getApplication(seeded.applicationId)!.target_mode).toBe('inline_blueprint');
    // The demotion must not have quietly reset it, or the write below proves
    // nothing about a policy that was still in force.
    expect(store.getApplication(seeded.applicationId)!.placement_policy).toBe('bounded_auto');

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'operator' });
    expect(res.status).toBe(200);
    expect(store.getApplication(seeded.applicationId)!.placement_policy).toBe('operator');
  });

  it('lets an operator set the rollout authorization policy', async () => {
    const seeded = await seedDemotedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorization-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'automatic' });
    expect(res.status).toBe(200);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.rollout_authorization_policy).toBe('automatic');
  });

  it('no longer refuses the health rollout policy as not Git-managed', async () => {
    // The same gate served this write before the two new policies existed, so it
    // had the same gap and would otherwise be left in place next to the fix.
    //
    // The seed has no intent revision, and this route resolves the stack only
    // from the intent, so it still answers 409 for that reason rather than
    // because of Git management. Which is the point: the refusal is no longer
    // the source-domain one, and the two new policy routes beside it resolve
    // the same identity from the Blueprint name.
    const seeded = await seedDemotedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/health-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'pause' });
    // Whatever it answers, the refusal is no longer the source-domain one.
    expect(res.body?.code).not.toBe('NOT_GIT_MANAGED');
  });

  it('still refuses a caller without the deploy grant', async () => {
    // Widening which applications a policy write reaches must not widen who may
    // write one, so the permission behaviour is pinned here too.
    const seeded = await seedDemotedBlueprint(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement-policy`)
      .set('Cookie', viewerCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(403);
  });

  it('still refuses a Direct application, which has no policy domain', async () => {
    const { directApplicationFixture } = await import('./helpers/gitopsFixtures');
    const applicationId = `direct-${randomUUID().slice(0, 8)}`;
    GitOpsStore.getInstance().insertApplication(directApplicationFixture(applicationId, `stack-${applicationId}`));
    const nodeId = insertNode(`direct-node-${randomUUID().slice(0, 8)}`);
    const res = await request(app)
      .post(`/api/gitops/applications/${nodeId}:${applicationId}/placement-policy`)
      .set('Cookie', adminCookie)
      .send({ policy: 'bounded_auto' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_GIT_MANAGED');
  });
});

/**
 * Operator pull of a Git-managed Blueprint. The grant is exact stack:edit on
 * the source stack. A session that can only read, or that can edit a different
 * stack, is refused. The fetch itself is stubbed; the controller tests cover
 * what a pull does to the row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import type { Express } from 'express';
import type { DatabaseService as DatabaseServiceType } from '../services/DatabaseService';
import type { GitOpsStore as GitOpsStoreType } from '../services/gitops/store';
import type { SourceController as SourceControllerType } from '../services/gitops/SourceController';

let tmpDir: string;
let app: Express;
let DatabaseService: typeof DatabaseServiceType;
let GitOpsStore: typeof GitOpsStoreType;
let SourceController: typeof SourceControllerType;
let adminCookie: string;
let viewerCookie: string;
let editorCookie: string;
let otherStackCookie: string;

function seedBlueprint(): { blueprintId: number; applicationId: string; sourceStack: string } {
  const applicationId = `app-route-fetch-${Date.now()}`;
  const sourceStack = `src-${applicationId}`;
  const blueprint = DatabaseService.getInstance().createBlueprint({
    name: `bp-route-fetch-${applicationId.slice(-6)}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
    selector: { type: 'nodes', ids: [1] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  });
  DatabaseService.getInstance().updateBlueprintContentOrigin(blueprint.id, 'git', applicationId);
  GitOpsStore.getInstance().insertApplication({
    ...directApplicationFixture(applicationId, sourceStack),
    target_mode: 'blueprint',
    lifecycle_key: `blueprint:${blueprint.id}`,
    stack_name: null,
    configured_source_stack_name: sourceStack,
    blueprint_id: blueprint.id,
    source_policy: 'manual',
  });
  return { blueprintId: blueprint.id, applicationId, sourceStack };
}

async function loginRole(username: string): Promise<string> {
  const passwordHash = await bcrypt.hash('route-fetch-pass', 1);
  DatabaseService.getInstance().addUser({ username, password_hash: passwordHash, role: 'viewer' });
  const res = await request(app).post('/api/auth/login').send({ username, password: 'route-fetch-pass' });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

function assignStackEdit(username: string, stackName: string, nodeId: number): void {
  const userId = DatabaseService.getInstance().getUserByUsername(username)!.id;
  DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO role_assignments (user_id, role, resource_type, resource_id, node_id, created_at)
     VALUES (?, 'node-admin', 'stack', ?, ?, ?)`,
  ).run(userId, stackName, nodeId, Date.now());
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({ SourceController } = await import('../services/gitops/SourceController'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  viewerCookie = await loginRole('fetch-viewer');
  editorCookie = await loginRole('fetch-editor');
  otherStackCookie = await loginRole('fetch-other');
  const nodeId = DatabaseService.getInstance().getDefaultNode()!.id;
  assignStackEdit('fetch-editor', 'assigned-later', nodeId);
  assignStackEdit('fetch-other', 'some-other-stack', nodeId);
});

afterAll(() => cleanupTestDb(tmpDir));

describe('POST /api/gitops/applications/:id/source/fetch', () => {
  it('pulls when the session can edit the source stack', async () => {
    const seeded = seedBlueprint();
    const nodeId = DatabaseService.getInstance().getDefaultNode()!.id;
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE role_assignments SET resource_id = ? WHERE user_id = ?`,
    ).run(seeded.sourceStack, DatabaseService.getInstance().getUserByUsername('fetch-editor')!.id);
    const fetchSpy = vi.spyOn(SourceController.getInstance(), 'requestFetch').mockResolvedValue({
      status: 'settled',
      result: { outcome: 'pending_review', reason: 'A newer commit is waiting.', nextAction: 'review' },
      candidateGenerationId: 'gen-route',
      authority: { status: 'not_applicable' },
    });

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/fetch`)
      .set('Cookie', editorCookie)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'pending_review',
      candidateGenerationId: 'gen-route',
    });
    expect(fetchSpy).toHaveBeenCalledWith(seeded.applicationId, expect.any(String));
    expect(nodeId).toBeGreaterThan(0);
    fetchSpy.mockRestore();
  });

  it('rejects a session that can only read', async () => {
    const seeded = seedBlueprint();
    const fetchSpy = vi.spyOn(SourceController.getInstance(), 'requestFetch');

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/fetch`)
      .set('Cookie', viewerCookie)
      .send({});

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects stack:edit on a different stack', async () => {
    const seeded = seedBlueprint();
    const fetchSpy = vi.spyOn(SourceController.getInstance(), 'requestFetch');

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/fetch`)
      .set('Cookie', otherStackCookie)
      .send({});

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('lets an administrator pull', async () => {
    const seeded = seedBlueprint();
    const fetchSpy = vi.spyOn(SourceController.getInstance(), 'requestFetch').mockResolvedValue({
      status: 'refused',
      code: 'suspended',
      error: 'This source is suspended. Resume it before pulling.',
    });

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/fetch`)
      .set('Cookie', adminCookie)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('suspended');
    fetchSpy.mockRestore();
  });

  it('takes the portfolio id from the stack sheet and refuses the internal id', async () => {
    const seeded = seedBlueprint();
    DatabaseService.getInstance().upsertGitSource({
      stack_name: seeded.sourceStack,
      repo_url: 'https://github.com/example/repo.git',
      branch: 'main',
      compose_path: 'compose.yaml',
      compose_paths: ['compose.yaml'],
      context_dir: null,
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null,
      encrypted_deploy_key: null,
      ssh_known_hosts_entry: null,
      ssh_host_key_fingerprint: null,
      encrypted_ca_bundle: null,
      auto_apply_on_webhook: false,
      auto_deploy_on_apply: false,
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });
    const fetchSpy = vi.spyOn(SourceController.getInstance(), 'requestFetch').mockResolvedValue({
      status: 'settled',
      result: { outcome: 'pending_review', reason: 'A newer commit is waiting.', nextAction: 'review' },
      candidateGenerationId: 'gen-route',
      authority: { status: 'not_applicable' },
    });

    const sheet = await request(app)
      .get(`/api/stacks/${seeded.sourceStack}/git-source`)
      .set('Cookie', adminCookie);
    expect(sheet.status).toBe(200);
    expect(sheet.body.gitopsRevision.applicationId).toBe(seeded.applicationId);
    expect(sheet.body.gitopsRevision.blueprintId).toBe(seeded.blueprintId);
    expect(String(sheet.body.gitopsRevision.applicationId).startsWith('bp:')).toBe(false);

    const raw = await request(app)
      .post(`/api/gitops/applications/${seeded.applicationId}/source/fetch`)
      .set('Cookie', adminCookie)
      .send({});
    expect(raw.status).toBe(400);
    expect(raw.body.error).toBe('Application id is not a portfolio id');
    expect(fetchSpy).not.toHaveBeenCalled();

    const portfolio = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/fetch`)
      .set('Cookie', adminCookie)
      .send({});
    expect(portfolio.status).toBe(200);
    expect(portfolio.body.authority).toEqual({ status: 'not_applicable', rollout: null, note: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(seeded.applicationId, expect.any(String));
    fetchSpy.mockRestore();
  });

  it('reports a pull whose rollout is still starting as success', async () => {
    const seeded = seedBlueprint();
    const fetchSpy = vi.spyOn(SourceController.getInstance(), 'requestFetch').mockResolvedValue({
      status: 'settled',
      result: { outcome: 'candidate_already_fetched', reason: 'ok', nextAction: 'none' },
      candidateGenerationId: 'gen-continuing',
      authority: {
        status: 'accepted',
        rollout: 'not_started',
        note: 'the rollout is starting; watch the application for progress',
      },
    });

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/fetch`)
      .set('Cookie', adminCookie)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('candidate_already_fetched');
    expect(res.body.authority).toEqual({
      status: 'accepted',
      rollout: 'not_started',
      note: 'The rollout is starting; watch the application for progress.',
    });
    fetchSpy.mockRestore();
  });
});

/**
 * Route-level coverage for the hub-owned GitOps portfolio API
 * (routes/gitopsApplications.ts).
 *
 * What is pinned here: auth gating (401 unsigned, 403 on a remote nodeId
 * because the surface is hub-only), the response envelope (summary +
 * coverage + bounded page), filter validation (reject-by-name rather than a
 * quietly broader answer), cursor round-trips, and the detail route's 404
 * semantics for applications the caller may not read or that do not exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import type { GitOpsPortfolioResponse } from '../services/gitops/portfolioTypes';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let localNodeId: number;

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: 1 };
}

function makeStackDir(stackName: string): void {
  const dir = path.join(process.env.COMPOSE_DIR!, stackName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
  localNodeId = DatabaseService.getInstance().getNodes()[0]!.id;

  // One healthy-looking Direct application (Ak: source accepted, runtime
  // healthy on its target) plus one Blueprint application.
  const tx = GitOpsTransitions.getInstance();
  tx.activateDirect({
    application: directApplicationFixture('app-route-local', 'route-local-web'),
    nodeId: localNodeId,
    envelope: env('op-route-local'),
  });
  makeStackDir('route-local-web');

  // A third application in a failure state, so the attention queue is provably
  // non-empty and its independence from list filters is testable.
  tx.activateDirect({
    application: directApplicationFixture('app-route-attention', 'route-attention-web'),
    nodeId: localNodeId,
    envelope: env('op-route-attention-1'),
  });
  tx.fetchStarted('app-route-attention', env('op-route-attention-2'));
  tx.fetchFailed('app-route-attention', env('op-route-attention-2'), 'NETWORK_TIMEOUT');
  makeStackDir('route-attention-web');

  const db = DatabaseService.getInstance();
  const blueprint = db.createBlueprint({
    name: 'route-blueprint',
    description: null,
    compose_content: 'services:\n  app:\n    image: nginx\n',
    selector: { type: 'nodes', ids: [] },
    drift_mode: 'observe',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  });
  GitOpsStore.getInstance().insertApplication({
    ...directApplicationFixture('app-route-blueprint', `source-route-blueprint`),
    lifecycle_key: `blueprint:${blueprint.id}`,
    target_mode: 'blueprint',
    stack_name: null,
    configured_source_stack_name: null,
    blueprint_id: blueprint.id,
  });
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('GET /api/gitops/applications', () => {
  it('answers 401 without authentication', async () => {
    const res = await request(app).get('/api/gitops/applications');
    expect(res.status).toBe(401);
  });

  it('answers 403 when the node id names a remote node', async () => {
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({
      name: 'route-remote-x',
      type: 'remote',
      api_url: 'http://127.0.0.1:29995',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });
    const res = await request(app)
      .get('/api/gitops/applications')
      .set('Cookie', adminCookie)
      .set('x-node-id', String(remoteId));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HUB_ONLY_ENDPOINT');
  });

  it('lists the local Direct application and the Blueprint application', async () => {
    const res = await request(app).get('/api/gitops/applications').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const body = res.body as GitOpsPortfolioResponse;
    expect(body.schemaVersion).toBe(1);
    expect(Array.isArray(body.applications)).toBe(true);
    expect(body.summary.applications).toBeGreaterThanOrEqual(2);
    const direct = body.applications.find(row => row.id === `${localNodeId}:app-route-local`);
    expect(direct).toBeDefined();
    expect(direct!.targetMode).toBe('direct');
    expect(direct!.repository?.host).toBe('github.com');
    const blueprint = body.applications.find(row => row.id.startsWith('bp:'));
    expect(blueprint).toBeDefined();
    expect(blueprint!.name).toBe('route-blueprint');
  });

  it('keeps the summary computed over the full authorized set while filters narrow the list', async () => {
    const res = await request(app)
      .get('/api/gitops/applications?mode=direct')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const body = res.body as GitOpsPortfolioResponse;
    expect(body.applications.every(row => row.targetMode === 'direct')).toBe(true);
    // Summary is the full authorized portfolio, not the filtered page: the
    // Blueprint application still counts in the masthead numbers.
    expect(body.summary.applications).toBeGreaterThanOrEqual(2);
  });

  it('returns the attention queue independent of list filters', async () => {
    const res = await request(app)
      .get('/api/gitops/applications?q=route-local-web')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const body = res.body as GitOpsPortfolioResponse;
    // The table is narrowed to the healthy application...
    expect(body.applications.map(row => row.name)).toEqual(['route-local-web']);
    // ...but the failed application is still in the queue, so a search can
    // never hide an exception the masthead counts.
    expect(body.attentionQueue.map(row => row.id)).toContain(`${localNodeId}:app-route-attention`);
    expect(body.summary.attentionRequired).toBeGreaterThanOrEqual(1);
    expect(body.attentionQueueTruncated).toBe(false);
  });

  it('applies the q filter against identity and repository fields', async () => {
    const res = await request(app)
      .get('/api/gitops/applications?q=route-local')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect((res.body as GitOpsPortfolioResponse).applications.map(row => row.name)).toEqual(['route-local-web']);
  });

  it('rejects unknown filter values instead of answering with a superset', async () => {
    const res = await request(app)
      .get('/api/gitops/applications?mode=cryptic')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('paginates with an opaque cursor', async () => {
    const first = await request(app)
      .get('/api/gitops/applications?limit=1&sort=name')
      .set('Cookie', adminCookie);
    expect(first.status).toBe(200);
    const firstBody = first.body as GitOpsPortfolioResponse;
    expect(firstBody.applications).toHaveLength(1);
    if (firstBody.summary.applications > 1) {
      expect(firstBody.nextCursor).toBeTruthy();
      const second = await request(app)
        .get(`/api/gitops/applications?limit=1&sort=name&cursor=${encodeURIComponent(firstBody.nextCursor!)}`)
        .set('Cookie', adminCookie);
      expect(second.status).toBe(200);
      const secondBody = second.body as GitOpsPortfolioResponse;
      expect(secondBody.applications).toHaveLength(1);
      expect(secondBody.applications[0]!.id).not.toBe(firstBody.applications[0]!.id);
    }
  });

  it('rejects a corrupt page cursor', async () => {
    const res = await request(app)
      .get('/api/gitops/applications?cursor=corrupt')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/gitops/applications/:id', () => {
  it('answers 404 for an id that parses but matches nothing', async () => {
    const res = await request(app)
      .get(`/api/gitops/applications/${localNodeId}:no-such-app`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('answers 400 for an id outside the portfolio id grammar', async () => {
    const res = await request(app)
      .get('/api/gitops/applications/not-an-id:')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('returns the local Direct detail row with its canonical projection', async () => {
    const res = await request(app)
      .get(`/api/gitops/applications/${localNodeId}:app-route-local`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.application.id).toBe(`${localNodeId}:app-route-local`);
    expect(res.body.projection).toBeDefined();
    expect(res.body.projection.applicationId).toBe('app-route-local');
  });

  it('returns the Blueprint detail for a caller holding the fleet read grant', async () => {
    const list = await request(app).get('/api/gitops/applications').set('Cookie', adminCookie);
    const blueprintRow = (list.body as GitOpsPortfolioResponse).applications.find(row => row.id.startsWith('bp:'))!;
    const res = await request(app)
      .get(`/api/gitops/applications/${blueprintRow.id}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.application.id).toBe(blueprintRow.id);
    expect(res.body.projection.targetMode).toBe('blueprint');
  });
});

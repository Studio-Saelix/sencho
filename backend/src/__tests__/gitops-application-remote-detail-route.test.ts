/**
 * Route coverage for the remote Direct branch of
 * GET /api/gitops/applications/:id (routes/gitopsApplications.ts).
 *
 * The owning node's /git-sources probe is stubbed so the branch can be driven
 * without a live peer. What is pinned here: a readable row naming the
 * application with a revision the hub cannot walk answers 503
 * `evidence_unavailable`, while an id no row names still answers 404.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';

const fetchRows = vi.hoisted(() => vi.fn<(nodeId: number) => Promise<unknown[] | null | 'unsupported'>>());

vi.mock('../services/gitops/portfolioAggregator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitops/portfolioAggregator')>();
  return { ...actual, fetchRemoteSourceRows: fetchRows };
});

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let remoteId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  remoteId = DatabaseService.getInstance().addNode({
    name: 'detail-remote',
    type: 'remote',
    api_url: 'http://127.0.0.1:29996',
    api_token: 'tok',
    compose_dir: '/app/compose',
    is_default: false,
  });
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  fetchRows.mockReset();
});

describe('GET /api/gitops/applications/:id (remote Direct)', () => {
  it('answers 503 evidence_unavailable for a matched row whose revision is not usable', async () => {
    fetchRows.mockResolvedValue([{
      stack_name: 'remote-web',
      stackResourcePresent: true,
      // Names the application but lacks the facets/targets/drift the hub walks.
      gitopsRevision: { applicationId: 'app-remote', targetMode: 'direct' },
    }]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('evidence_unavailable');
  });

  it('keeps 404 when no readable row names the application', async () => {
    fetchRows.mockResolvedValue([{
      stack_name: 'remote-other',
      stackResourcePresent: true,
      gitopsRevision: { applicationId: 'app-other', targetMode: 'direct' },
    }]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
    expect(res.body.code).toBeUndefined();
  });

  it('keeps 503 node_unreachable when the owning node does not answer', async () => {
    fetchRows.mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('node_unreachable');
  });
});

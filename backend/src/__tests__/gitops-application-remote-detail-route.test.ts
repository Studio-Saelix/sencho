import bcrypt from 'bcrypt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, loginAsTestAdmin, setupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';

const fetchRows = vi.hoisted(() => vi.fn<(nodeId: number) => Promise<unknown[] | null | 'unsupported'>>());

vi.mock('../services/gitops/portfolioAggregator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitops/portfolioAggregator')>();
  return { ...actual, fetchRemoteSourceRows: fetchRows };
});

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;
let remoteId: number;

function remoteRow(gitopsRevision: unknown): Record<string, unknown> {
  return { stack_name: 'remote-web', stackResourcePresent: true, gitopsRevision };
}

function unusableRow(): Record<string, unknown> {
  return {
    stack_name: 'remote-web',
    stackResourcePresent: true,
    gitopsRevision: { applicationId: 'app-remote', targetMode: 'direct' },
  };
}

function malformedFacetsRow(): Record<string, unknown> {
  return {
    stack_name: 'remote-web',
    stackResourcePresent: true,
    gitopsRevision: {
      ...readableProjection(),
      facets: {},
    },
  };
}

function readableSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'source_poll_scheduled',
    nextPollAt: 2000,
    configuredRepoUrl: 'https://example.test/repository.git',
    repoIdentity: { host: 'example.test', pathname: '/repository.git' },
    configuredRef: 'main',
    desiredCommitSha: null,
    fetchedCommitSha: null,
    candidateGenerationId: null,
    acceptedGenerationId: 'generation-1',
    ...overrides,
  };
}

function readableFacets(): Record<string, unknown> {
  return {
    source: readableSource(),
    artifact: { status: 'not_applicable' },
    placement: { status: 'unbound_direct' },
    rollout: { status: 'not_applicable' },
  };
}

function readableProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    targetMode: 'direct',
    applicationId: 'app-remote',
    lifecycleStatus: 'active',
    stackName: 'remote-web',
    blueprintId: null,
    rolloutGenerationId: null,
    approvals: {
      sourceAcceptanceRef: null,
      placementApprovalRef: null,
      rolloutAuthorizationRef: null,
      legacyCombinedApprovalRef: null,
    },
    facets: readableFacets(),
    targets: [],
    drift: [],
    limitations: [],
    availableActions: [],
    ...overrides,
  };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  const passwordHash = await bcrypt.hash('detail-viewer-pass', 1);
  DatabaseService.getInstance().addUser({
    username: 'detail-viewer',
    password_hash: passwordHash,
    role: 'viewer',
  });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'detail-viewer', password: 'detail-viewer-pass' });
  const cookies = login.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
  remoteId = DatabaseService.getInstance().addNode({
    name: 'detail-remote',
    type: 'remote',
    api_url: 'http://127.0.0.1:29996',
    api_token: 'tok',
    compose_dir: process.env.COMPOSE_DIR!,
    is_default: false,
  });
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  fetchRows.mockReset();
});

describe('GET /api/gitops/applications/:id (remote Direct)', () => {
  it('answers 503 evidence_unavailable for a matched row without a usable revision', async () => {
    fetchRows.mockResolvedValue([unusableRow()]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('evidence_unavailable');
  });

  it('answers 503 evidence_unavailable when the matched projection cannot be walked', async () => {
    fetchRows.mockResolvedValue([malformedFacetsRow()]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('evidence_unavailable');
  });

  it.each([
    ['schema version', (projection: Record<string, unknown>) => ({ ...projection, schemaVersion: 2 })],
    ['approvals', (projection: Record<string, unknown>) => ({ ...projection, approvals: {} })],
    ['drift identity', (projection: Record<string, unknown>) => ({
      ...projection,
      drift: [{
        class: 'source',
        freshnessAt: null,
        owner: 'operator',
        reason: 'missing expected identity',
        configuredPolicy: null,
        affectedTargets: [],
        action: 'fetch',
        observed: { kind: 'unknown' },
      }],
    })],
    ['limitation message', (projection: Record<string, unknown>) => ({
      ...projection,
      limitations: [{ code: 'invalid_evidence', evidence: null }],
    })],
  ])('rejects a readable row with malformed %s as evidence_unavailable', async (_label, mutate) => {
    fetchRows.mockResolvedValue([remoteRow(mutate(readableProjection()))]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('evidence_unavailable');
  });

  it('accepts valid missing-artifact evidence with a null expected identity', async () => {
    fetchRows.mockResolvedValue([remoteRow(readableProjection({ facets: { ...readableFacets(), artifact: { status: 'artifact_unresolved', generationId: 'generation-1', expected: null, latestEvidence: null, limitation: 'artifact_pointer_missing', }, }, }))]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.projection.facets.artifact.status).toBe('artifact_unresolved');
  });

  it('rejects a source status without its required failure evidence', async () => {
    fetchRows.mockResolvedValue([remoteRow(readableProjection({ facets: { ...readableFacets(), source: readableSource({ status: 'source_failed' }), }, }))]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('evidence_unavailable');
  });

  it('rejects contradictory artifact qualification evidence', async () => {
    fetchRows.mockResolvedValue([remoteRow(readableProjection({ facets: { ...readableFacets(), artifact: { status: 'artifact_exact', artifactSetId: 'artifact-1', generationId: 'generation-1', evidenceVersion: 1, qualification: 'exact', freshnessAt: 1, expected: null, latestEvidence: { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'unavailable', identity: null, }, }, }, }))]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('evidence_unavailable');
  });

  it('rejects artifact identity changes without a differing expected identity', async () => {
    fetchRows.mockResolvedValue([remoteRow(readableProjection({ facets: { ...readableFacets(), artifact: { status: 'artifact_identity_changed', artifactSetId: 'artifact-1', generationId: 'generation-1', evidenceVersion: 1, qualification: 'exact', freshnessAt: 1, expected: null, latestEvidence: { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'exact', identity: 'sha256:artifact', }, }, }, }))]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('evidence_unavailable');
  });

  it('rejects an exact claim whose expected identity disagrees with the latest evidence', async () => {
    fetchRows.mockResolvedValue([remoteRow(readableProjection({ facets: { ...readableFacets(), artifact: { status: 'artifact_exact', artifactSetId: 'artifact-1', generationId: 'generation-1', evidenceVersion: 1, qualification: 'exact', freshnessAt: 1, expected: { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'exact', identity: 'sha256:something-else', }, latestEvidence: { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'exact', identity: 'sha256:artifact', }, }, }, }))]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('evidence_unavailable');
  });

  it('accepts an artifact verdict and qualification this build does not know', async () => {
    fetchRows.mockResolvedValue([remoteRow(readableProjection({ facets: { ...readableFacets(), artifact: { status: 'artifact_future_verdict', artifactSetId: 'artifact-1', generationId: 'generation-1', evidenceVersion: 1, qualification: 'future_qualification', freshnessAt: 1, expected: null, latestEvidence: { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'future_qualification', identity: 'sha256:artifact', }, }, }, }))]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.projection.facets.artifact.status).toBe('artifact_future_verdict');
  });

  it('keeps 404 when no readable row names the application', async () => {
    fetchRows.mockResolvedValue([{
      ...unusableRow(),
      gitopsRevision: { applicationId: 'app-other', targetMode: 'direct' },
    }]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
    expect(res.body.code).toBeUndefined();
  });

  it('keeps 404 for the same row when the caller cannot read it', async () => {
    fetchRows.mockResolvedValue([{ ...unusableRow(), stack_name: null }]);
    const res = await request(app)
      .get(`/api/gitops/applications/${remoteId}:app-remote`)
      .set('Cookie', viewerCookie);
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

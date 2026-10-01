/**
 * `/api/security/evidence-policy`: the read is permission-gated, the write is
 * admin-only because every field can weaken a deploy block, and a malformed
 * body must change nothing at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';

// The stack has no Compose file in a test DB, so the deploy path would fail on
// filesystem reads before it ever reached the gate. Stubbed the same way the
// sibling deploy-policy route test does.
vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: vi.fn().mockResolvedValue([]),
      getBaseDir: () => '/tmp/compose',
      readComposeFile: vi.fn().mockResolvedValue(''),
      hasComposeFile: vi.fn().mockResolvedValue(true),
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  db.updateGlobalSetting('security_scanner_unavailable', 'allow');
  db.updateGlobalSetting('security_scan_failure', 'block');
  db.updateGlobalSetting('security_candidate_unproven', 'block');
});

describe('GET /api/security/evidence-policy', () => {
  it('returns the resolved policy and states the shipped default alongside it', async () => {
    const res = await request(app).get('/api/security/evidence-policy').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.policy).toMatchObject({
      scannerUnavailable: 'allow',
      scanFailure: 'block',
      candidateUnproven: 'block',
      isDefault: true,
    });
    // The UI has to be able to say what the default is, not just what is set.
    expect(res.body.defaults).toMatchObject({ scannerUnavailable: 'allow', scanFailure: 'block' });
    expect(res.body.outcomes).toEqual(['allow', 'warn', 'block']);
  });

  it('rejects an unauthenticated read', async () => {
    const res = await request(app).get('/api/security/evidence-policy');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/security/evidence-policy', () => {
  it('persists each outcome', async () => {
    const res = await request(app)
      .put('/api/security/evidence-policy')
      .set('Cookie', authCookie)
      .send({ scannerUnavailable: 'warn', scanFailure: 'allow', candidateUnproven: 'allow' });
    expect(res.status).toBe(200);
    expect(res.body.policy).toMatchObject({
      scannerUnavailable: 'warn',
      scanFailure: 'allow',
      candidateUnproven: 'allow',
      isDefault: false,
    });

    const readBack = await request(app).get('/api/security/evidence-policy').set('Cookie', authCookie);
    expect(readBack.body.policy).toMatchObject({
      scannerUnavailable: 'warn',
      scanFailure: 'allow',
      candidateUnproven: 'allow',
    });
  });

  it('records what a gate-weakening write changed and what it changed from', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const audit = vi.spyOn(DatabaseService.getInstance(), 'insertAuditLog');
    try {
      await request(app)
        .put('/api/security/evidence-policy')
        .set('Cookie', authCookie)
        .send({ scanFailure: 'allow' });
      // The request-audit middleware also writes a row per request, so select
      // this route's own entry rather than the last one written.
      const summaries = audit.mock.calls
        .map((c) => (c[0] as { summary?: string }).summary ?? '')
        .filter((t) => t.startsWith('policy.evidence_availability'));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain('changed=[scanFailure]');
      // The previous value matters as much as the new one: "who loosened it,
      // and from what".
      expect(summaries[0]).toContain('was=[scanFailure=block]');
    } finally {
      audit.mockRestore();
    }
  });

  it('writes no audit row when the body changed nothing', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const audit = vi.spyOn(DatabaseService.getInstance(), 'insertAuditLog');
    try {
      const res = await request(app).put('/api/security/evidence-policy').set('Cookie', authCookie).send({});
      expect(res.status).toBe(200);
      const mine = audit.mock.calls
        .map((c) => (c[0] as { summary?: string }).summary ?? '')
        .filter((t) => t.startsWith('policy.evidence_availability'));
      expect(mine).toEqual([]);
    } finally {
      audit.mockRestore();
    }
  });

  it('accepts a partial body and leaves the rest of the policy alone', async () => {
    const res = await request(app)
      .put('/api/security/evidence-policy')
      .set('Cookie', authCookie)
      .send({ scannerUnavailable: 'block' });
    expect(res.status).toBe(200);
    expect(res.body.policy).toMatchObject({
      scannerUnavailable: 'block',
      scanFailure: 'block',
      candidateUnproven: 'block',
    });
  });

  it('rejects an unknown outcome and writes nothing', async () => {
    const res = await request(app)
      .put('/api/security/evidence-policy')
      .set('Cookie', authCookie)
      .send({ scannerUnavailable: 'deny' });
    expect(res.status).toBe(400);
    const readBack = await request(app).get('/api/security/evidence-policy').set('Cookie', authCookie);
    expect(readBack.body.policy.scannerUnavailable).toBe('allow');
  });

  it('rejects a non-boolean-ish outcome, so a stringy "1" cannot disable the gate', async () => {
    const res = await request(app)
      .put('/api/security/evidence-policy')
      .set('Cookie', authCookie)
      .send({ scannerUnavailable: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects the deferred freshness field rather than accepting a setting nothing reads', async () => {
    // The control is deferred to the paths that can act on stored evidence.
    // Accepting the field here would persist a value that silently does nothing.
    const res = await request(app)
      .put('/api/security/evidence-policy')
      .set('Cookie', authCookie)
      .send({ maxScanAgeDays: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('maxScanAgeDays');
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    const res = await request(app)
      .put('/api/security/evidence-policy')
      .set('Cookie', authCookie)
      .send({ scannerUnavailable: 'warn', everythingIsFine: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('everythingIsFine');
  });

  it('writes nothing when one field in a multi-field body is invalid', async () => {
    // A partial apply would leave the gate reading a policy nobody chose.
    const res = await request(app)
      .put('/api/security/evidence-policy')
      .set('Cookie', authCookie)
      .send({ scannerUnavailable: 'warn', candidateUnproven: 'sometimes' });
    expect(res.status).toBe(400);
    const readBack = await request(app).get('/api/security/evidence-policy').set('Cookie', authCookie);
    expect(readBack.body.policy.scannerUnavailable).toBe('allow');
  });

  it('is writable on a replica, because the gate runs on the node that deploys', async () => {
    // Deliberately NOT replica-blocked. This configures the local gate, exactly
    // like the honour-suppressions toggle beside it, which a replica can also
    // set. Blocking it would leave the panel rendered and every save refused.
    const { FleetSyncService } = await import('../services/FleetSyncService');
    const roleSpy = vi.spyOn(FleetSyncService, 'getRole').mockReturnValue('replica');
    try {
      const res = await request(app)
        .put('/api/security/evidence-policy')
        .set('Cookie', authCookie)
        .send({ scanFailure: 'allow' });
      expect(res.status).toBe(200);
      expect(res.body.policy.scanFailure).toBe('allow');
    } finally {
      roleSpy.mockRestore();
    }
  });

  it('still refuses a replicated resource write on a replica, so the guard is real', async () => {
    // Contrast case: proves the replica guard exists and this route is a
    // deliberate exception rather than an oversight.
    const { FleetSyncService } = await import('../services/FleetSyncService');
    const roleSpy = vi.spyOn(FleetSyncService, 'getRole').mockReturnValue('replica');
    try {
      const res = await request(app)
        .post('/api/security/policies')
        .set('Cookie', authCookie)
        .send({ name: 'replica-refused', stack_pattern: '*', max_severity: 'HIGH', block_on_deploy: true, enabled: true, block_on_severity: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REPLICA_READ_ONLY');
    } finally {
      roleSpy.mockRestore();
    }
  });

  it('refuses a non-admin write', async () => {
    const bcrypt = await import('bcrypt');
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().addUser({
      username: 'evidence-viewer',
      password_hash: await bcrypt.default.hash('viewerpass', 1),
      role: 'viewer',
    });
    const token = jwt.sign({ username: 'evidence-viewer', role: 'viewer' }, TEST_JWT_SECRET);

    const res = await request(app)
      .put('/api/security/evidence-policy')
      .set('Authorization', `Bearer ${token}`)
      .send({ scannerUnavailable: 'block' });
    expect(res.status).toBe(403);

    const readBack = await request(app).get('/api/security/evidence-policy').set('Cookie', authCookie);
    expect(readBack.body.policy.scannerUnavailable).toBe('allow');
  });
});

describe('evidence policy on the deploy gate, end to end', () => {
  it('keeps a missing scanner allowing the deploy until an operator says otherwise', async () => {
    const { ComposeService } = await import('../services/ComposeService');
    const listImages = vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:bad']);
    const deploy = vi
      .spyOn(ComposeService.prototype, 'deployStack')
      .mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
    const TrivyService = (await import('../services/TrivyService')).default;
    const trivy = TrivyService.getInstance();
    const available = vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(false);

    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().createScanPolicy({
      name: 'evidence-default-block',
      node_id: null,
      node_identity: '',
      stack_pattern: 'evidence-*',
      max_severity: 'HIGH',
      block_on_deploy: 1,
      block_on_severity: 1,
      block_on_kev: 0,
      block_on_fixable: 0,
      enabled: 1,
      replicated_from_control: 0,
    });

    const allowed = await request(app).post('/api/stacks/evidence-demo/deploy').set('Cookie', authCookie);
    expect(allowed.status).not.toBe(409);
    expect(deploy).toHaveBeenCalled();

    // The same install, with one setting changed, refuses instead.
    DatabaseService.getInstance().updateGlobalSetting('security_scanner_unavailable', 'block');
    const blocked = await request(app).post('/api/stacks/evidence-demo/deploy').set('Cookie', authCookie);
    expect(blocked.status).toBe(409);
    // The refusal has to be explainable, not just a 409.
    expect(blocked.body.evidence).toMatchObject({ outcome: 'block' });
    expect(blocked.body.evidence.applications[0].rule).toBe('security_scanner_unavailable=block');

    listImages.mockRestore();
    deploy.mockRestore();
    available.mockRestore();
  });
});

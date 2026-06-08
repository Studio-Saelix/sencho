/**
 * Drift Ledger: the persistence layer on top of the read-only spatial engine.
 * Covers the deploy baseline + temporal comparison, the reconcile step that
 * records findings appearing and clearing (and the activity rows it writes), the
 * supporting database methods, and the POST re-check route that persists on demand.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import type { StackDriftReport, StackDriftFinding, DriftFindingKind } from '../services/DriftDetectionService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let DriftLedgerService: typeof import('../services/DriftLedgerService').DriftLedgerService;
let computeStackHashes: typeof import('../services/DriftLedgerService').computeStackHashes;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let nodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ DriftLedgerService, computeStackHashes } = await import('../services/DriftLedgerService'));
  ({ LicenseService } = await import('../services/LicenseService'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' });
  authHeader = `Bearer ${token}`;
  nodeId = (DatabaseService.getInstance().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

function db() {
  return DatabaseService.getInstance();
}

function clearLedger(stack: string) {
  db().deleteStackDriftFindings(nodeId, stack);
  db().getDb().prepare('DELETE FROM notification_history WHERE node_id = ? AND stack_name = ?').run(nodeId, stack);
  db().deleteStackDossier(nodeId, stack);
}

function finding(kind: DriftFindingKind, service: string, expected?: string, actual?: string): StackDriftFinding {
  return { kind, service, detail: `${service} ${kind}`, expected, actual };
}

function reportWith(findings: StackDriftFinding[], over: Partial<StackDriftReport> = {}): StackDriftReport {
  return { stack: over.stack ?? 'web', status: findings.length ? 'drifted' : 'in-sync', hasComposeFile: true, hasContainers: true, findings, ...over };
}

function driftActivity(stack: string) {
  return db().getStackActivity(nodeId, stack, { limit: 50 }).filter(e => e.category === 'drift_detected' || e.category === 'drift_resolved');
}

describe('computeStackHashes', () => {
  it('is deterministic for identical content', () => {
    const a = computeStackHashes('services:\n  web:\n    image: nginx:1.27\n');
    const b = computeStackHashes('services:\n  web:\n    image: nginx:1.27\n');
    expect(a).toEqual(b);
  });

  it('source hash differs but rendered hash matches when only comments/whitespace change', () => {
    const plain = computeStackHashes('services:\n  web:\n    image: nginx:1.27\n');
    const commented = computeStackHashes('# a comment\nservices:\n  web:\n    image: nginx:1.27\n\n');
    expect(commented.sourceHash).not.toBe(plain.sourceHash);
    expect(commented.renderedHash).toBe(plain.renderedHash);
  });

  it('rendered hash changes when the model changes', () => {
    const v1 = computeStackHashes('services:\n  web:\n    image: nginx:1.27\n');
    const v2 = computeStackHashes('services:\n  web:\n    image: nginx:1.28\n');
    expect(v2.renderedHash).not.toBe(v1.renderedHash);
  });

  it('returns a null rendered hash when the model cannot be parsed', () => {
    // No services => the local parser reports a parse error and cannot model it.
    const h = computeStackHashes('not_a_compose_key: true\n');
    expect(typeof h.sourceHash).toBe('string');
    expect(h.renderedHash).toBeNull();
  });
});

describe('setStackDossierHashes', () => {
  beforeEach(() => clearLedger('hashstack'));

  it('creates a dossier row with empty notes when none exists', () => {
    db().setStackDossierHashes(nodeId, 'hashstack', 'src1', 'rnd1');
    const row = db().getStackDossier(nodeId, 'hashstack');
    expect(row?.source_hash).toBe('src1');
    expect(row?.rendered_hash).toBe('rnd1');
    expect(row?.purpose).toBe('');
  });

  it('preserves operator notes when updating hashes', () => {
    db().upsertStackDossier(nodeId, 'hashstack', {
      purpose: 'reverse proxy', owner: 'ops', access_urls: '', static_ip: '', vlan: '',
      firewall_notes: '', reverse_proxy_notes: '', backup_notes: '', upgrade_notes: '', recovery_notes: '', custom_notes: '',
    });
    db().setStackDossierHashes(nodeId, 'hashstack', 'src2', 'rnd2');
    const row = db().getStackDossier(nodeId, 'hashstack');
    expect(row?.purpose).toBe('reverse proxy');
    expect(row?.owner).toBe('ops');
    expect(row?.source_hash).toBe('src2');
  });
});

describe('drift finding store', () => {
  beforeEach(() => clearLedger('findstack'));

  it('inserts open findings and resolves them', () => {
    const id = db().insertDriftFinding({
      node_id: nodeId, stack_name: 'findstack', service: 'web', finding_type: 'image-mismatch',
      severity: 'warning', message: 'm', expected_json: null, actual_json: null, detected_at: 1000,
    });
    expect(db().getOpenDriftFindings(nodeId, 'findstack')).toHaveLength(1);
    db().resolveDriftFinding(id, 2000);
    expect(db().getOpenDriftFindings(nodeId, 'findstack')).toHaveLength(0);
    const recent = db().getRecentDriftFindings(nodeId, 'findstack', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0].resolved_at).toBe(2000);
  });

  it('orders recent findings open-first, then resolved, each newest first', () => {
    const mk = (service: string, detected: number) => db().insertDriftFinding({
      node_id: nodeId, stack_name: 'findstack', service, finding_type: 'image-mismatch',
      severity: 'warning', message: service, expected_json: null, actual_json: null, detected_at: detected,
    });
    mk('a', 100);
    const b = mk('b', 300);
    mk('c', 200);
    db().resolveDriftFinding(b, 400); // b is the only resolved one (and the newest by detected_at)
    // Open (c@200, a@100 by detected_at DESC) come before the resolved b despite b being newest.
    expect(db().getRecentDriftFindings(nodeId, 'findstack', 10).map(r => r.service)).toEqual(['c', 'a', 'b']);
  });
});

describe('DriftLedgerService.computeTemporal', () => {
  beforeEach(() => clearLedger('tempstack'));
  const content = 'services:\n  web:\n    image: nginx:1.27\n';

  it('reports no baseline before a deploy', () => {
    const t = DriftLedgerService.getInstance().computeTemporal(nodeId, 'tempstack', content);
    expect(t).toEqual({ hasBaseline: false, sourceChanged: false, renderedChanged: false });
  });

  it('reports a match when content is unchanged since baseline', () => {
    const { sourceHash, renderedHash } = computeStackHashes(content);
    db().setStackDossierHashes(nodeId, 'tempstack', sourceHash, renderedHash);
    const t = DriftLedgerService.getInstance().computeTemporal(nodeId, 'tempstack', content);
    expect(t).toEqual({ hasBaseline: true, sourceChanged: false, renderedChanged: false });
  });

  it('flags source and rendered changes after the file changes', () => {
    const baseline = computeStackHashes(content);
    db().setStackDossierHashes(nodeId, 'tempstack', baseline.sourceHash, baseline.renderedHash);
    const t = DriftLedgerService.getInstance().computeTemporal(nodeId, 'tempstack', 'services:\n  web:\n    image: nginx:1.28\n');
    expect(t.hasBaseline).toBe(true);
    expect(t.sourceChanged).toBe(true);
    expect(t.renderedChanged).toBe(true);
  });

  it('flags source changed but not rendered for a comments/whitespace-only edit', () => {
    const baseline = computeStackHashes(content);
    db().setStackDossierHashes(nodeId, 'tempstack', baseline.sourceHash, baseline.renderedHash);
    const t = DriftLedgerService.getInstance().computeTemporal(nodeId, 'tempstack', `# a note\n${content}\n`);
    expect(t).toEqual({ hasBaseline: true, sourceChanged: true, renderedChanged: false });
  });
});

describe('DriftLedgerService.reconcile', () => {
  beforeEach(() => clearLedger('rec'));
  const ledger = () => DriftLedgerService.getInstance();

  it('records newly detected findings and a single activity row', () => {
    const res = ledger().reconcile(nodeId, 'rec', reportWith([finding('image-mismatch', 'web', 'nginx:1.27', 'nginx:1.26')], { stack: 'rec' }));
    expect(res).toEqual({ detected: 1, resolved: 0 });
    expect(db().getOpenDriftFindings(nodeId, 'rec')).toHaveLength(1);
    const activity = driftActivity('rec');
    expect(activity).toHaveLength(1);
    expect(activity[0].category).toBe('drift_detected');
  });

  it('is idempotent: re-checking the same drift writes nothing new', () => {
    const report = reportWith([finding('image-mismatch', 'web')], { stack: 'rec' });
    ledger().reconcile(nodeId, 'rec', report);
    const res = ledger().reconcile(nodeId, 'rec', report);
    expect(res).toEqual({ detected: 0, resolved: 0 });
    expect(db().getOpenDriftFindings(nodeId, 'rec')).toHaveLength(1);
    expect(driftActivity('rec')).toHaveLength(1);
  });

  it('resolves a finding that has cleared and records a resolved activity row', () => {
    ledger().reconcile(nodeId, 'rec', reportWith([finding('image-mismatch', 'web')], { stack: 'rec' }));
    const res = ledger().reconcile(nodeId, 'rec', reportWith([], { stack: 'rec', status: 'in-sync' }));
    expect(res).toEqual({ detected: 0, resolved: 1 });
    expect(db().getOpenDriftFindings(nodeId, 'rec')).toHaveLength(0);
    expect(driftActivity('rec').filter(e => e.category === 'drift_resolved')).toHaveLength(1);
  });

  it('records exactly one row per direction when one finding clears as another appears', () => {
    ledger().reconcile(nodeId, 'rec', reportWith([finding('image-mismatch', 'web')], { stack: 'rec' }));
    // In a single check, 'web' clears while 'db' newly appears.
    const res = ledger().reconcile(nodeId, 'rec', reportWith([finding('service-missing', 'db')], { stack: 'rec' }));
    expect(res).toEqual({ detected: 1, resolved: 1 });
    expect(db().getOpenDriftFindings(nodeId, 'rec')).toHaveLength(1);
    const cats = driftActivity('rec').map(e => e.category);
    expect(cats.filter(c => c === 'drift_detected')).toHaveLength(2); // first reconcile + this one
    expect(cats.filter(c => c === 'drift_resolved')).toHaveLength(1);
  });

  it('does not reconcile an unreachable report (open findings are not falsely resolved)', () => {
    ledger().reconcile(nodeId, 'rec', reportWith([finding('image-mismatch', 'web')], { stack: 'rec' }));
    const res = ledger().reconcile(nodeId, 'rec', { stack: 'rec', status: 'unreachable', hasComposeFile: true, hasContainers: false, findings: [] });
    expect(res).toEqual({ detected: 0, resolved: 0 });
    expect(db().getOpenDriftFindings(nodeId, 'rec')).toHaveLength(1);
  });

  it('does not reconcile a parse-error report', () => {
    ledger().reconcile(nodeId, 'rec', reportWith([finding('image-mismatch', 'web')], { stack: 'rec' }));
    const res = ledger().reconcile(nodeId, 'rec', { stack: 'rec', status: 'drifted', hasComposeFile: false, hasContainers: false, findings: [], parseError: 'bad yaml' });
    expect(res).toEqual({ detected: 0, resolved: 0 });
    expect(db().getOpenDriftFindings(nodeId, 'rec')).toHaveLength(1);
  });
});

describe('DriftLedgerService.recordBaseline', () => {
  beforeEach(() => clearLedger('baseline'));

  it('hashes the on-disk compose and stores it as the dossier baseline', async () => {
    const stackDir = path.join(process.env.COMPOSE_DIR as string, 'baseline');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
    try {
      await DriftLedgerService.getInstance().recordBaseline(nodeId, 'baseline');
      const row = db().getStackDossier(nodeId, 'baseline');
      const expected = computeStackHashes('services:\n  web:\n    image: nginx:1.27\n');
      expect(row?.source_hash).toBe(expected.sourceHash);
      expect(row?.rendered_hash).toBe(expected.renderedHash);
    } finally {
      fs.rmSync(stackDir, { recursive: true, force: true });
    }
  });
});

describe('drift route (GET read-only, POST recheck persists)', () => {
  const STACK = 'recheckroute';
  let stackDir: string;

  // A running container on a different image than compose declares => image-mismatch.
  const stubDriftedDocker = () => vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({
      containers: [{
        id: 'c1', name: `${STACK}-web-1`, service: 'web', composeProject: STACK, stack: STACK,
        state: 'running', image: 'nginx:1.26', networks: [], volumes: [], ports: [],
      }],
      networks: [], volumes: [],
    }),
  } as unknown as DockerController);

  beforeEach(() => {
    clearLedger(STACK);
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('GET reports drift without writing the ledger or activity timeline', async () => {
    stubDriftedDocker();
    const res = await request(app).get(`/api/stacks/${STACK}/drift`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('drifted');
    expect(res.body.temporal).toBeDefined();
    // A passive read must not persist anything.
    expect(db().getOpenDriftFindings(nodeId, STACK)).toHaveLength(0);
    expect(driftActivity(STACK)).toHaveLength(0);
  });

  it('POST recheck persists the current drift and returns temporal + ledger', async () => {
    stubDriftedDocker();
    const res = await request(app).post(`/api/stacks/${STACK}/drift/recheck`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('drifted');
    expect(res.body.temporal).toBeDefined();
    expect(Array.isArray(res.body.ledger)).toBe(true);
    expect(res.body.ledger).toHaveLength(1);
    expect(res.body.ledger[0]).toMatchObject({ service: 'web', kind: 'image-mismatch', resolvedAt: null });

    // The transition was recorded exactly once in the activity timeline.
    const acts = driftActivity(STACK);
    expect(acts).toHaveLength(1);
    expect(acts[0].category).toBe('drift_detected');
    // And persisted as an open finding.
    expect(db().getOpenDriftFindings(nodeId, STACK)).toHaveLength(1);
  });
});

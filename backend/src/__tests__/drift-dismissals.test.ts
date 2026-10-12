/**
 * Stack drift dismissals: the key, fingerprint and per-kind policy, the image
 * age the engine derives, the ledger columns that carry a dismissal, and the
 * routes that write and read them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import type { DependencyContainer, DependencySnapshot } from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';
import {
  driftDismissPolicy,
  driftFindingFacts,
  parseDriftKey,
  type DriftLedgerKind,
} from '../services/driftDismissals';
import { annotateImageAge, classifyImageAge, type ImageInspector } from '../services/driftImageAge';
import type { StackDriftReport } from '../services/DriftDetectionService';
import { classifyStackApiPath } from '../helpers/stackRouteAuth';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let deployerAuth: string;
let nodeId: number;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

const STACK = 'web';
const KEY = 'drift:image-mismatch:web';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const db = DatabaseService.getInstance();
  nodeId = db.getNodes().find((node) => node.is_default)!.id;

  const sign = (username: string, role: string, tv: number) =>
    `Bearer ${jwt.sign({ username, role, tv }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  db.addUser({ username: 'drift-viewer', password_hash: await bcrypt.hash('password123', 1), role: 'viewer' });
  viewerAuth = sign('drift-viewer', 'viewer', db.getUserByUsername('drift-viewer')!.token_version);
  db.addUser({ username: 'drift-deployer', password_hash: await bcrypt.hash('password123', 1), role: 'viewer' });
  const deployer = db.getUserByUsername('drift-deployer')!;
  db.addRoleAssignment({ user_id: deployer.id, role: 'deployer', resource_type: 'stack', resource_id: STACK, node_id: nodeId });
  deployerAuth = sign('drift-deployer', 'viewer', deployer.token_version);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('drift finding id and policy', () => {
  it('round trips kind and service', () => {
    expect(parseDriftKey('drift:image-mismatch:web')).toEqual({ kind: 'image-mismatch', service: 'web' });
    expect(parseDriftKey('drift:network-missing:')).toEqual({ kind: 'network-missing', service: '' });
  });

  it.each([
    '', 'web', 'drift:bogus:web', 'networking:1:x', 'drift:image-mismatch', `drift:image-mismatch:${'a'.repeat(300)}`,
    'drift:image-mismatch:we\nb',
  ])('refuses %j', (id) => {
    expect(parseDriftKey(id)).toBeNull();
  });

  it('decides every kind, and refuses only the Git managed-path conflict', () => {
    const kinds: DriftLedgerKind[] = [
      'service-missing', 'service-undeclared', 'image-mismatch', 'ports-mismatch',
      'network-undeclared', 'network-missing', 'managed-path-conflict',
    ];
    for (const kind of kinds) {
      expect(driftDismissPolicy(kind)).toBe(kind === 'managed-path-conflict' ? 'none' : 'any');
    }
  });
});

describe('drift fingerprint', () => {
  const base = { kind: 'image-mismatch' as const, service: 'web', expected: 'nginx:1.27', actual: 'nginx:1.26' };

  it('hashes structured facts only, so the message is never an input', () => {
    const a = driftFindingFacts(base);
    expect(driftFindingFacts({ ...base }).fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toMatchObject({ id: KEY, count: 1, severity: 'warning', dismissPolicy: 'any' });
  });

  it('moves when the running value, the declared value or the service changes', () => {
    const a = driftFindingFacts(base).fingerprint;
    expect(driftFindingFacts({ ...base, actual: 'nginx:1.25' }).fingerprint).not.toBe(a);
    expect(driftFindingFacts({ ...base, expected: 'nginx:1.28' }).fingerprint).not.toBe(a);
    expect(driftFindingFacts({ ...base, service: 'api' }).fingerprint).not.toBe(a);
  });

  it('ignores the derived image age, so a Docker cache change never resurfaces a dismissal', () => {
    const a = driftFindingFacts(base).fingerprint;
    // A published finding carries the age beside its structured facts.
    const aged = { ...base, detail: 'd', imageAge: 'running-newer' as const };
    expect(driftFindingFacts(aged).fingerprint).toBe(a);
    const unknownAge = { ...aged, imageAge: 'unknown' as const };
    expect(driftFindingFacts(unknownAge).fingerprint).toBe(a);
  });

  it('does not let one field spill into the next', () => {
    expect(driftFindingFacts({ ...base, expected: 'a', actual: 'bc' }).fingerprint)
      .not.toBe(driftFindingFacts({ ...base, expected: 'ab', actual: 'c' }).fingerprint);
  });

  it('counts the networks a network finding names, so a growing list lifts any hold', () => {
    expect(driftFindingFacts({ kind: 'network-undeclared', service: 'web', actual: 'a, b, c' }).count).toBe(3);
    expect(driftFindingFacts({ kind: 'network-missing', service: '', expected: 'x, y' }).count).toBe(2);
    expect(driftFindingFacts({ kind: 'network-undeclared', service: 'web', actual: 'a' }).count).toBe(1);
    expect(driftFindingFacts({ kind: 'ports-mismatch', service: 'web', expected: '80/tcp', actual: '81/tcp' }).count).toBe(1);
  });
});

describe('image age', () => {
  const built = (map: Record<string, string>): ImageInspector => ({
    getImage: (ref: string) => ({
      inspect: async () => {
        if (map[ref] === undefined) throw Object.assign(new Error('no such image'), { statusCode: 404 });
        return { Created: map[ref] };
      },
    }),
  });

  it('says the running image is newer or older only when both build times are known', async () => {
    const docker = built({ 'app:1': '2026-01-01T00:00:00Z', 'app:2': '2026-02-01T00:00:00Z' });
    expect(await classifyImageAge(docker, 'app:1', ['app:2'])).toBe('running-newer');
    expect(await classifyImageAge(docker, 'app:2', ['app:1'])).toBe('running-older');
  });

  it('stays unknown when the declared image is not local, a time is unreadable, or replicas disagree', async () => {
    const docker = built({ 'app:1': '2026-01-01T00:00:00Z', 'app:2': '2026-02-01T00:00:00Z', 'app:3': '2025-12-01T00:00:00Z', bad: 'not a date' });
    expect(await classifyImageAge(docker, 'app:gone', ['app:2'])).toBe('unknown');
    expect(await classifyImageAge(docker, 'app:1', ['bad'])).toBe('unknown');
    expect(await classifyImageAge(docker, 'app:1', ['app:2', 'app:3'])).toBe('unknown');
    expect(await classifyImageAge(docker, 'app:1', [])).toBe('unknown');
    expect(await classifyImageAge(docker, 'app:1', ['app:1'])).toBe('unknown');
  });

  it('annotates only image findings, and never touches Docker when there are none', async () => {
    const factory = vi.fn(() => built({}));
    const quiet: StackDriftReport = { stack: 'web', status: 'in-sync', hasComposeFile: true, hasContainers: true, findings: [] };
    expect(await annotateImageAge(factory, quiet)).toBe(quiet);
    expect(factory).not.toHaveBeenCalled();

    const report: StackDriftReport = {
      ...quiet,
      status: 'drifted',
      findings: [
        { kind: 'image-mismatch', service: 'web', detail: 'x', expected: 'app:1', actual: 'app:2' },
        { kind: 'ports-mismatch', service: 'web', detail: 'y', expected: '80/tcp', actual: '81/tcp' },
      ],
    };
    const annotated = await annotateImageAge(() => built({ 'app:1': '2026-01-01T00:00:00Z', 'app:2': '2026-02-01T00:00:00Z' }), report);
    expect(annotated.findings[0].imageAge).toBe('running-newer');
    expect(annotated.findings[1].imageAge).toBeUndefined();
  });
});

describe('stack route classifier', () => {
  it('asks for exact deploy authority on the stack to dismiss and to restore', () => {
    expect(classifyStackApiPath('POST', '/stacks/web/drift/dismissals')).toEqual({ kind: 'named-stack', stackName: 'web', action: 'stack:deploy' });
    expect(classifyStackApiPath('DELETE', '/stacks/web/drift/dismissals/7')).toEqual({ kind: 'named-stack', stackName: 'web', action: 'stack:deploy' });
    expect(classifyStackApiPath('GET', '/stacks/web/drift/dismissals')).toEqual({ kind: 'unknown-named' });
    expect(classifyStackApiPath('DELETE', '/stacks/web/drift/dismissals/7/extra')).toEqual({ kind: 'unknown-named' });
  });
});

describe('migration on an existing database', () => {
  it('adds the dismissal columns to a ledger that has rows, and keeps the rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-drift-migrate-'));
    const previous = process.env.DATA_DIR;
    try {
      const raw = new Database(path.join(dir, 'sencho.db'));
      raw.exec(`
        CREATE TABLE stack_drift_findings (
          id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, stack_name TEXT NOT NULL,
          service TEXT NOT NULL, finding_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'warning',
          message TEXT NOT NULL, expected_json TEXT, actual_json TEXT, detected_at INTEGER NOT NULL, resolved_at INTEGER
        );
        INSERT INTO stack_drift_findings (node_id, stack_name, service, finding_type, message, detected_at)
          VALUES (1, 'old', 'web', 'image-mismatch', 'old finding', 5);
      `);
      raw.close();
      process.env.DATA_DIR = dir;
      const { DatabaseService: Fresh } = await import('../services/DatabaseService');
      const saved = (Fresh as unknown as { instance?: unknown }).instance;
      (Fresh as unknown as { instance?: unknown }).instance = undefined;
      try {
        const row = Fresh.getInstance().getOpenDriftFindings(1, 'old')[0];
        expect(row).toMatchObject({ message: 'old finding', dismissed_by: null, dismissed_mode: null, dismissed_count: null });
        // A second boot over the migrated file is a no-op.
        (Fresh as unknown as { instance?: unknown }).instance = undefined;
        expect(Fresh.getInstance().getOpenDriftFindings(1, 'old')).toHaveLength(1);
      } finally {
        (Fresh as unknown as { instance?: unknown }).instance = saved;
      }
    } finally {
      process.env.DATA_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── routes ────────────────────────────────────────────────────────────────

function container(image: string): DependencyContainer {
  return {
    id: 'c1', name: 'c1', service: 'web', composeProject: null, stack: STACK, state: 'running', exitCode: null,
    image, networks: [], volumes: [], ports: [],
  };
}

const NEWER = '2026-02-01T00:00:00Z';
const OLDER = '2026-01-01T00:00:00Z';

/** What Docker says is running; `snapshot: null` makes the read fail. */
function stubRuntime(runningImage: string | null, snapshot: 'ok' | 'down' = 'ok'): void {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: JSON.stringify({ name: STACK, services: { web: { image: 'nginx:1.27' } } }),
      stderr: '', code: 0, timedOut: false,
    }),
  } as unknown as ComposeService);
  const snap: DependencySnapshot = {
    containers: runningImage === null ? [] : [container(runningImage)],
    networks: [], volumes: [],
  };
  const created: Record<string, string> = { 'nginx:1.27': NEWER, 'nginx:1.26': OLDER, 'nginx:1.28': '2026-03-01T00:00:00Z' };
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: snapshot === 'down' ? vi.fn().mockRejectedValue(new Error('docker down')) : vi.fn().mockResolvedValue(snap),
    getDocker: () => ({
      getImage: (ref: string) => ({
        inspect: async () => {
          if (created[ref] === undefined) throw Object.assign(new Error('no such image'), { statusCode: 404 });
          return { Created: created[ref] };
        },
      }),
    }),
  } as unknown as DockerController);
}

const get = (auth = adminAuth) => request(app).get(`/api/stacks/${STACK}/drift`).set('Authorization', auth);
const recheck = () => request(app).post(`/api/stacks/${STACK}/drift/recheck`).set('Authorization', adminAuth);
const post = (body: object, auth = adminAuth, stack = STACK) =>
  request(app).post(`/api/stacks/${stack}/drift/dismissals`).set('Authorization', auth).send(body);
const del = (id: number | string, auth = adminAuth, stack = STACK) =>
  request(app).delete(`/api/stacks/${stack}/drift/dismissals/${id}`).set('Authorization', auth);

/** The finding a drifted read publishes, as the client would echo it back. */
async function seen(): Promise<{ findingId: string; fingerprint: string; count: number }> {
  const res = await get();
  const finding = res.body.findings[0];
  return { findingId: finding.id, fingerprint: finding.fingerprint, count: finding.count };
}

beforeEach(() => {
  for (const name of [STACK, 'other']) {
    fs.mkdirSync(path.join(process.env.COMPOSE_DIR as string, name), { recursive: true });
    fs.writeFileSync(path.join(process.env.COMPOSE_DIR as string, name, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
  }
  DatabaseService.getInstance().getDb().prepare('DELETE FROM stack_drift_findings').run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET drift publishes what a dismissal is compared against', () => {
  it('carries an id, fingerprint, count and policy on each finding, the image age, and no dismissals yet', async () => {
    stubRuntime('nginx:1.26');
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('drifted');
    expect(res.body.findings[0]).toMatchObject({
      kind: 'image-mismatch', id: KEY, count: 1, severity: 'warning', dismissPolicy: 'any', imageAge: 'running-older',
    });
    expect(res.body.findings[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(res.body.dismissals).toEqual([]);
  });

  it('reads a newer running image as newer, and an image it cannot find as unknown', async () => {
    stubRuntime('nginx:1.28');
    expect((await get()).body.findings[0].imageAge).toBe('running-newer');
    vi.restoreAllMocks();
    stubRuntime('nginx:1.29');
    expect((await get()).body.findings[0].imageAge).toBe('unknown');
  });
});

describe('POST /api/stacks/:stackName/drift/dismissals', () => {
  it('dismisses until it changes, records who, and leaves the verdict and the count alone', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    const res = await post({ ...echoed, mode: 'until_change' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kept: false,
      dismissal: { surface: 'drift', findingKey: KEY, mode: 'until_change', createdBy: TEST_USERNAME, count: 1, severity: 'warning' },
    });

    const after = await get();
    expect(after.body.dismissals).toHaveLength(1);
    expect(after.body.dismissals[0]).toMatchObject({ id: res.body.dismissal.id, fingerprint: echoed.fingerprint });
    // A dismissal only moves the finding in the list: the verdict and its count are unchanged.
    expect(after.body.status).toBe('drifted');
    expect(after.body.findings).toHaveLength(1);
  });

  it('records a dismissal on the ledger row, so the ledger retires it when the finding clears', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    const id = (await post({ ...echoed, mode: 'forever' })).body.dismissal.id as number;
    expect(DatabaseService.getInstance().getDriftFinding(id)).toMatchObject({ dismissed_mode: 'forever', resolved_at: null });

    vi.restoreAllMocks();
    stubRuntime('nginx:1.27');
    expect((await recheck()).body.dismissals).toEqual([]);
    expect(DatabaseService.getInstance().getDriftFinding(id)?.resolved_at).not.toBeNull();

    // The same drift coming back is a new finding with no dismissal on it.
    vi.restoreAllMocks();
    stubRuntime('nginx:1.26');
    const back = await recheck();
    expect(back.body.findings).toHaveLength(1);
    expect(back.body.dismissals).toEqual([]);
  });

  it('never weakens a stronger dismissal that still covers the finding', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    const first = await post({ ...echoed, mode: 'forever' });
    const second = await post({ ...echoed, mode: 'until_change' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ kept: true, dismissal: { id: first.body.dismissal.id, mode: 'forever' } });
  });

  it('replaces a weaker or equal dismissal, and a stronger one that no longer covers the finding', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    const first = await post({ ...echoed, mode: 'until_change' });
    // Equal rank does not keep: the second click is a write.
    expect((await post({ ...echoed, mode: 'until_change' })).body.kept).toBe(false);
    const upgraded = await post({ ...echoed, mode: 'forever' });
    expect(upgraded.status).toBe(201);
    expect(upgraded.body).toMatchObject({ kept: false, dismissal: { id: first.body.dismissal.id, mode: 'forever' } });

    // The running image changes, so the stored fingerprint no longer covers the finding.
    vi.restoreAllMocks();
    stubRuntime('nginx:1.28');
    const changed = await seen();
    expect(changed.fingerprint).not.toBe(echoed.fingerprint);
    const again = await post({ ...changed, mode: 'until_change' });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ kept: false, dismissal: { mode: 'until_change', fingerprint: changed.fingerprint } });
  });

  it('publishes a new fingerprint for a changed finding while the dismissal keeps the one it was made against', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    await post({ ...echoed, mode: 'until_change' });

    vi.restoreAllMocks();
    stubRuntime('nginx:1.28');
    const after = await get();
    expect(after.body.findings[0].fingerprint).not.toBe(echoed.fingerprint);
    expect(after.body.dismissals[0].fingerprint).toBe(echoed.fingerprint);
  });

  it('only touches the dismissed finding: a sibling open row stays open and no check is stamped', async () => {
    stubRuntime('nginx:1.26');
    const db = DatabaseService.getInstance();
    const sibling = db.insertDriftFinding({
      node_id: nodeId, stack_name: STACK, service: 'api', finding_type: 'ports-mismatch', severity: 'warning',
      message: 'm', expected_json: null, actual_json: null, detected_at: 1,
    });
    const before = db.getStackDossier(nodeId, STACK);
    const echoed = await seen();
    expect((await post({ ...echoed, mode: 'until_change' })).status).toBe(201);
    expect(db.getDriftFinding(sibling)?.resolved_at).toBeNull();
    expect(db.getStackDossier(nodeId, STACK)).toEqual(before);
  });

  it('accepts a timed dismissal with an expiry, and refuses a malformed one', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    const res = await post({ ...echoed, mode: 'days', days: 7 });
    expect(res.status).toBe(201);
    expect(res.body.dismissal.expiresAt).toBeGreaterThan(Date.now());
    expect((await post({ ...echoed, mode: 'days', days: 0 })).status).toBe(400);
    expect((await post({ ...echoed, mode: 'sometimes' })).status).toBe(400);
  });

  it('refuses a finding that changed after it was seen, or that is already gone', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    const stale = await post({ ...echoed, fingerprint: '0000000000000000', mode: 'until_change' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('FINDING_CHANGED');
    expect((await post({ ...echoed, count: 4, mode: 'until_change' })).body.code).toBe('FINDING_CHANGED');

    vi.restoreAllMocks();
    stubRuntime('nginx:1.27');
    const gone = await post({ ...echoed, mode: 'until_change' });
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe('FINDING_GONE');
  });

  it('says nothing was dismissed when Docker cannot be read', async () => {
    stubRuntime('nginx:1.26', 'down');
    const res = await post({ findingId: KEY, fingerprint: 'abc', count: 1, mode: 'until_change' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EVIDENCE_UNAVAILABLE');
  });

  it('refuses a count beyond the shared bound', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    expect((await post({ ...echoed, count: 10_000_001, mode: 'until_change' })).status).toBe(400);
  });

  it('answers 400 for a managed-path conflict, an unreadable id, or a missing fingerprint', async () => {
    stubRuntime('nginx:1.26');
    const conflict = await post({ findingId: 'drift:managed-path-conflict:abc', fingerprint: 'abc', count: 1, mode: 'until_change' });
    expect(conflict.status).toBe(400);
    expect(conflict.body.error).toMatch(/Git source/);
    expect((await post({ findingId: 'nope', fingerprint: 'abc', count: 1, mode: 'until_change' })).status).toBe(400);
    expect((await post({ findingId: KEY, mode: 'until_change' })).status).toBe(400);
  });

  it('is scoped to the stack: a deployer on one stack cannot dismiss on another, and a viewer cannot dismiss', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    expect((await post({ ...echoed, mode: 'until_change' }, deployerAuth)).status).toBe(201);
    expect((await post({ ...echoed, mode: 'until_change' }, deployerAuth, 'other')).status).toBe(403);
    expect((await post({ ...echoed, mode: 'until_change' }, viewerAuth)).status).toBe(403);
    expect((await request(app).post(`/api/stacks/${STACK}/drift/dismissals`).send(echoed)).status).toBe(401);
  });

  it('answers 404 for a stack that does not exist', async () => {
    stubRuntime('nginx:1.26');
    expect((await post({ findingId: KEY, fingerprint: 'abc', count: 1, mode: 'until_change' }, adminAuth, 'nostack')).status).toBe(404);
  });
});

describe('DELETE /api/stacks/:stackName/drift/dismissals/:id', () => {
  it('restores the finding, with the same authority that dismissed it', async () => {
    stubRuntime('nginx:1.26');
    const echoed = await seen();
    const id = (await post({ ...echoed, mode: 'until_change' })).body.dismissal.id as number;

    expect((await del(id, viewerAuth)).status).toBe(403);
    expect((await del(id, deployerAuth, 'other')).status).toBe(403);
    expect((await del(id, deployerAuth)).status).toBe(204);
    expect((await get()).body.dismissals).toEqual([]);
    // Restoring twice reaches the same end state.
    expect((await del(id)).status).toBe(204);
  });

  it('cannot restore a finding that belongs to another stack', async () => {
    stubRuntime('nginx:1.26');
    const otherId = DatabaseService.getInstance().insertDriftFinding({
      node_id: nodeId, stack_name: 'other', service: 'web', finding_type: 'image-mismatch', severity: 'warning',
      message: 'm', expected_json: null, actual_json: null, detected_at: 1,
    });
    expect((await del(otherId, adminAuth, STACK)).status).toBe(404);
    expect((await del('abc')).status).toBe(400);
    expect((await del(999999)).status).toBe(404);
  });
});

describe('image age is only a decoration', () => {
  it('reads as unknown, and the report still builds, when Docker cannot be asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const report: StackDriftReport = {
      stack: 'web', status: 'drifted', hasComposeFile: true, hasContainers: true,
      findings: [{ kind: 'image-mismatch', service: 'web', detail: 'x', expected: 'app:1', actual: 'app:2' }],
    };
    const annotated = await annotateImageAge(() => { throw new Error('no docker'); }, report);
    expect(annotated.findings[0]).toMatchObject({ kind: 'image-mismatch', imageAge: 'unknown' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

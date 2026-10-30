/**
 * Recovery points and repositories: one terminal write per point, skipped data
 * never reads as complete, holds block deletion, verifications append, and a
 * repository secret is encrypted at rest and never leaves through a
 * descriptor, an error, or point evidence.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { StorageIdentity, RepositoryDescriptor, PointCaptureEvidence } from '../services/recovery/types';

let tmpDir: string;
let points: typeof import('../services/recovery/recoveryPoints');
let repos: typeof import('../services/recovery/repositories');
let identities: typeof import('../services/recovery/storageIdentity');
let redaction: typeof import('../services/recovery/redaction');
let recoveryDb: typeof import('../services/recovery/recoveryDb').recoveryDb;

const ENGINE = 'docker-engine:points-test';
let storage: StorageIdentity;
let repository: RepositoryDescriptor;
let counter = 0;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  points = await import('../services/recovery/recoveryPoints');
  repos = await import('../services/recovery/repositories');
  identities = await import('../services/recovery/storageIdentity');
  redaction = await import('../services/recovery/redaction');
  ({ recoveryDb } = await import('../services/recovery/recoveryDb'));
  storage = identities.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'points_data', generationToken: 'g1',
    dependents: [{ stackName: 'web', serviceName: 'db' }],
  });
  repository = repos.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE, kind: 'local_volume', locator: 'sencho_recovery_repo', failureDomain: 'same_failure_domain',
  });
});

afterAll(() => cleanupTestDb(tmpDir));

const evidence = (overrides: Partial<PointCaptureEvidence> = {}): PointCaptureEvidence => ({
  snapshotId: `snap-${++counter}`,
  capture: { fileCount: 10, byteCount: 1024, skippedCount: 0 },
  exclusions: [],
  consistency: 'crash_consistent_live',
  ...overrides,
});

const beginRoot = (storageId = storage.id, expectedGenerationToken = 'g1') => points.RecoveryPointStore.getInstance().begin({
  storageId, expectedGenerationToken, repositoryId: repository.id, kind: 'root', trigger: 'manual', actor: 'admin',
  sourceOperationId: `op-${++counter}`, sourceNodeKey: ENGINE, engineId: 'test-engine',
});

describe('RecoveryPointStore', () => {
  const store = () => points.RecoveryPointStore.getInstance();

  it('records a pending point against the current generation, then finalizes it once', () => {
    const p = beginRoot();
    expect(p).toMatchObject({ status: 'pending', kind: 'root', pathScope: null, storageGeneration: 1, schemaVersion: 1, snapshotId: null, completedAt: null });
    const done = store().finalize(p.id, { status: 'succeeded', evidence: evidence() });
    expect(done.status).toBe('succeeded');
    expect(done.capture).toEqual({ fileCount: 10, byteCount: 1024, skippedCount: 0 });
    // A duplicated or late completion cannot rewrite the record, and says so as a recovery error.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => store().finalize(p.id, { status: 'failed', errorClass: 'internal' })).toThrow(expect.objectContaining({ errorClass: 'invalid_request' }));
    warn.mockRestore();
    expect(store().get(p.id)?.status).toBe('succeeded');
    // The database still refuses a direct rewrite.
    expect(() => recoveryDb().prepare("UPDATE recovery_points SET status = 'failed' WHERE id = ?").run(p.id)).toThrow(/immutable/);
  });

  it('demotes a point that skipped data to partial, whatever the engine claimed', () => {
    const skipped = store().finalize(beginRoot().id, { status: 'succeeded', evidence: evidence({ capture: { fileCount: 9, byteCount: 900, skippedCount: 1 } }) });
    expect(skipped.status).toBe('partial');
    const denied = store().finalize(beginRoot().id, {
      status: 'succeeded',
      evidence: evidence({ exclusions: [{ path: 'secrets/db', reason: 'permission_denied' }] }),
    });
    expect(denied.status).toBe('partial');
    const chosen = store().finalize(beginRoot().id, {
      status: 'succeeded',
      evidence: evidence({ exclusions: [{ path: 'cache', reason: 'policy_excluded' }] }),
    });
    expect(chosen.status).toBe('succeeded');
  });

  it('keeps a partial claim partial even when the capture reports nothing skipped', () => {
    const clean = store().finalize(beginRoot().id, { status: 'partial', evidence: evidence() });
    expect(clean).toMatchObject({ status: 'partial', capture: { skippedCount: 0 }, exclusions: [] });
    expect(store().get(clean.id)?.status).toBe('partial');
  });

  it('has the database itself refuse a point whose storage or repository does not exist', () => {
    const insert = (storageId: string, repositoryId: string) => recoveryDb().prepare(`
      INSERT INTO recovery_points
        (id, schema_version, storage_id, storage_generation, kind, repository_id, status, consistency,
         trigger_kind, actor, source_operation_id, source_node_key, engine_id, capability_version, started_at)
      VALUES (?, 1, ?, 1, 'root', ?, 'pending', 'unknown', 'manual', 'admin', 'op', ?, 'e', 1, 1)
    `).run(`fk-${++counter}`, storageId, repositoryId, ENGINE);
    expect(() => insert(storage.id, repository.id)).not.toThrow();
    expect(() => insert('no-such-storage', repository.id)).toThrow(/FOREIGN KEY/);
    expect(() => insert(storage.id, 'no-such-repo')).toThrow(/FOREIGN KEY/);
  });

  it('records a failure with its class and no evidence', () => {
    const failed = store().finalize(beginRoot().id, { status: 'failed', errorClass: 'source_unreadable' });
    expect(failed).toMatchObject({ status: 'failed', failureClass: 'source_unreadable', snapshotId: null, capture: null });
    const untyped = beginRoot();
    expect(() => store().finalize(untyped.id, { status: 'failed' } as never)).toThrow(expect.objectContaining({ errorClass: 'invalid_request' }));
    expect(store().get(untyped.id)?.status).toBe('pending');
  });

  it('logs the snapshot id of a late completion so the orphaned snapshot can be found', () => {
    const p = store().finalize(beginRoot().id, { status: 'failed', errorClass: 'internal' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => store().finalize(p.id, { status: 'succeeded', evidence: evidence({ snapshotId: 'snap-late-1' }) })).toThrow(redaction.RecoveryError);
    expect(warn.mock.calls[0]).toContain(' (snapshot snap-late-1)');
    warn.mockRestore();
  });

  it('keeps path points scoped inside the root', () => {
    const p = store().begin({
      storageId: storage.id, expectedGenerationToken: 'g1', repositoryId: repository.id, kind: 'path', pathScope: 'uploads/2026/', trigger: 'pre_change',
      actor: 'admin', sourceOperationId: 'op-path', sourceNodeKey: ENGINE, engineId: 'test-engine',
    });
    expect(p.pathScope).toBe('uploads/2026');
    for (const bad of ['', '/etc', '../up', 'a/../../b', '.']) {
      expect(() => store().begin({
        storageId: storage.id, expectedGenerationToken: 'g1', repositoryId: repository.id, kind: 'path', pathScope: bad, trigger: 'pre_change',
        actor: 'admin', sourceOperationId: 'op-bad', sourceNodeKey: ENGINE, engineId: 'test-engine',
      })).toThrow(redaction.RecoveryError);
    }
    expect(() => store().begin({
      storageId: storage.id, expectedGenerationToken: 'g1', repositoryId: repository.id, kind: 'root',
      pathScope: 'a' as never, trigger: 'manual',
      actor: 'admin', sourceOperationId: 'op-bad', sourceNodeKey: ENGINE, engineId: 'test-engine',
    })).toThrow(redaction.RecoveryError);
  });

  it('refuses a point of a superseded generation, an unknown storage, or an unknown repository', () => {
    const old = identities.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'recreated_data', generationToken: 'g1', dependents: [],
    });
    identities.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'recreated_data', generationToken: 'g2', dependents: [],
    });
    expect(() => beginRoot(old.id, 'g1')).toThrow(expect.objectContaining({ errorClass: 'identity_unknown' }));
    // Recreated since the caller observed it: the token no longer matches.
    expect(() => beginRoot(storage.id, 'g0-stale')).toThrow(expect.objectContaining({ errorClass: 'identity_unknown' }));
    expect(() => beginRoot('no-such-storage')).toThrow(expect.objectContaining({ errorClass: 'identity_unknown' }));
    expect(() => store().begin({
      storageId: storage.id, expectedGenerationToken: 'g1', repositoryId: 'no-such-repo', kind: 'root', trigger: 'manual', actor: 'admin',
      sourceOperationId: 'op', sourceNodeKey: ENGINE, engineId: 'test-engine',
    })).toThrow(expect.objectContaining({ errorClass: 'repository_unavailable' }));
  });

  it('appends verifications and refuses to verify an unfinished point', () => {
    const pending = beginRoot();
    expect(() => store().recordVerification(pending.id, 'engine_check_metadata', 'verified', null)).toThrow(redaction.RecoveryError);
    const done = store().finalize(pending.id, { status: 'succeeded', evidence: evidence() });
    store().recordVerification(done.id, 'engine_check_metadata', 'verified', 'op-v1', 10);
    store().recordVerification(done.id, 'engine_check_read_data', 'mismatch', 'op-v2', 20);
    expect(store().listVerifications(done.id).map((v) => v.result)).toEqual(['verified', 'mismatch']);
    expect(store().get(done.id)?.status).toBe('succeeded');
  });

  it('keeps a held point from being deleted', () => {
    const p = store().finalize(beginRoot().id, { status: 'succeeded', evidence: evidence() });
    store().addHold({ pointId: p.id, holderKind: 'last_known_good', holderRef: storage.storageKey });
    store().addHold({ pointId: p.id, holderKind: 'last_known_good', holderRef: storage.storageKey });
    expect(store().listHolds(p.id)).toHaveLength(1);
    expect(() => recoveryDb().prepare('DELETE FROM recovery_points WHERE id = ?').run(p.id)).toThrow(/held/);
    store().removeHold({ pointId: p.id, holderKind: 'last_known_good', holderRef: storage.storageKey });
    expect(recoveryDb().prepare('DELETE FROM recovery_points WHERE id = ?').run(p.id).changes).toBe(1);
  });

  it('drops unknown evidence fields and ends a point failed on invalid or credential-shaped evidence', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A field the contract does not know is dropped, never stored.
    const keyed = store().finalize(beginRoot().id, {
      status: 'succeeded',
      evidence: { ...evidence(), password: 'hunter2' } as unknown as PointCaptureEvidence,
    });
    expect(keyed.status).toBe('succeeded');
    const row = recoveryDb().prepare('SELECT * FROM recovery_points WHERE id = ?').get(keyed.id);
    expect(JSON.stringify(row)).not.toContain('hunter2');
    const texted = beginRoot();
    expect(() => store().finalize(texted.id, {
      status: 'succeeded',
      evidence: evidence({ snapshotId: 'RESTIC_PASSWORD=hunter2' }),
    })).toThrow(expect.objectContaining({ errorClass: 'internal' }));
    expect(store().get(texted.id)?.status).toBe('failed');
    // The refusal is logged without the credential-shaped snapshot id.
    expect(JSON.stringify(err.mock.calls)).not.toContain('hunter2');
    const oversized = beginRoot();
    expect(() => store().finalize(oversized.id, {
      status: 'succeeded', evidence: evidence({ snapshotId: 'a'.repeat(129) }),
    })).toThrow(expect.objectContaining({ errorClass: 'internal' }));
    expect(store().get(oversized.id)?.status).toBe('failed');
    const malformed = beginRoot();
    expect(() => store().finalize(malformed.id, {
      status: 'succeeded',
      evidence: evidence({ capture: { fileCount: -1, byteCount: 0, skippedCount: 0 } }),
    })).toThrow(expect.objectContaining({ errorClass: 'internal' }));
    const inconsistent = beginRoot();
    expect(() => store().finalize(inconsistent.id, {
      status: 'succeeded',
      evidence: evidence({ consistency: 'application_consistent' as never }),
    })).toThrow(expect.objectContaining({ errorClass: 'internal' }));
    expect(store().get(inconsistent.id)).toMatchObject({ status: 'failed', failureClass: 'internal' });
    const escaping = beginRoot();
    expect(() => store().finalize(escaping.id, {
      status: 'succeeded',
      evidence: evidence({ exclusions: [{ path: '../etc/shadow', reason: 'unreadable' }] }),
    })).toThrow(expect.objectContaining({ errorClass: 'internal' }));
    err.mockRestore();
  });

  it('stores only the known evidence fields, with exclusion paths canonicalized', () => {
    const p = store().finalize(beginRoot().id, {
      status: 'succeeded',
      evidence: {
        ...evidence({ exclusions: [{ path: 'uploads//a/', reason: 'policy_excluded' }] }),
        capture: { fileCount: 3, byteCount: 30, skippedCount: 0, path: 'RESTIC_PASSWORD=hunter2' },
      } as unknown as PointCaptureEvidence,
    });
    expect(p.status).toBe('succeeded');
    expect(p.exclusions).toEqual([{ path: 'uploads/a', reason: 'policy_excluded' }]);
    const raw = recoveryDb().prepare('SELECT capture_json FROM recovery_points WHERE id = ?').get(p.id) as { capture_json: string };
    expect(JSON.parse(raw.capture_json)).toEqual({ fileCount: 3, byteCount: 30, skippedCount: 0 });
  });

  it('keeps an exclusion whose file name merely looks like a credential', () => {
    const p = store().finalize(beginRoot().id, {
      status: 'succeeded',
      evidence: evidence({ exclusions: [
        { path: 'exports/database_dump.20240101.compressed', reason: 'policy_excluded' },
        { path: 'conf/password=hunter2.txt', reason: 'policy_excluded' },
      ] }),
    });
    expect(p.status).toBe('succeeded');
    expect(p.exclusions.map((e) => e.path)).toEqual(['exports/database_dump.20240101.compressed', 'conf/password=hunter2.txt']);
  });

  it('refuses a hold of an unknown kind instead of dropping it', () => {
    const p = store().finalize(beginRoot().id, { status: 'succeeded', evidence: evidence() });
    expect(() => store().addHold({ pointId: p.id, holderKind: 'whim' as never, holderRef: 'x' })).toThrow(/CHECK/);
    expect(store().listHolds(p.id)).toEqual([]);
  });
});

describe('RecoveryRepositoryStore', () => {
  const store = () => repos.RecoveryRepositoryStore.getInstance();
  const SECRET = 'correct horse battery staple 9f8e7d';

  it('registers a repository once per locator', () => {
    const again = store().register({ ownerNodeKey: ENGINE, kind: 'local_volume', locator: 'sencho_recovery_repo', failureDomain: 'same_failure_domain' });
    expect(again.id).toBe(repository.id);
    expect(again.failureDomain).toBe('same_failure_domain');
  });

  it('encrypts the secret at rest and never puts it in a descriptor', () => {
    store().storeSecret(repository.id, SECRET);
    const raw = recoveryDb().prepare('SELECT encrypted_secret FROM recovery_repositories WHERE id = ?').get(repository.id) as { encrypted_secret: string };
    expect(raw.encrypted_secret.startsWith('enc:')).toBe(true);
    expect(raw.encrypted_secret).not.toContain(SECRET);
    const descriptor = store().get(repository.id);
    expect(descriptor?.secretState).toBe('stored');
    expect(JSON.stringify(descriptor)).not.toContain(SECRET);
    expect(JSON.stringify(descriptor)).not.toContain('enc:');
    expect(store().readSecret(repository.id)).toBe(SECRET);
  });

  it('refuses a second registration with a different failure domain, or an unknown kind', () => {
    expect(() => store().register({ ownerNodeKey: ENGINE, kind: 'local_volume', locator: 'sencho_recovery_repo', failureDomain: 'separate' }))
      .toThrow(expect.objectContaining({ errorClass: 'invalid_request' }));
    expect(() => store().register({ ownerNodeKey: ENGINE, kind: 's3' as never, locator: 'other_repo', failureDomain: 'unknown' })).toThrow(/CHECK/);
  });

  it('sets the repository fingerprint once and refuses a replacement', () => {
    const r = store().register({ ownerNodeKey: ENGINE, kind: 'local_volume', locator: 'fingerprint_repo', failureDomain: 'same_failure_domain' });
    store().setFingerprint(r.id, 'restic-aaaa');
    store().setFingerprint(r.id, 'restic-aaaa');
    expect(() => store().setFingerprint(r.id, 'restic-bbbb')).toThrow(expect.objectContaining({ errorClass: 'repository_unavailable' }));
    expect(store().get(r.id)?.repositoryFingerprint).toBe('restic-aaaa');
    expect(() => store().setFingerprint(r.id, ' ')).toThrow(expect.objectContaining({ errorClass: 'invalid_request' }));
  });

  it('reports a missing or unreadable secret as unavailable, never as the ciphertext', () => {
    const fresh = store().register({ ownerNodeKey: ENGINE, kind: 'local_volume', locator: 'second_repo', failureDomain: 'unknown' });
    expect(() => store().readSecret(fresh.id)).toThrow(expect.objectContaining({ errorClass: 'repository_key_unavailable' }));
    recoveryDb().prepare("UPDATE recovery_repositories SET encrypted_secret = 'enc:00:00:00' WHERE id = ?").run(fresh.id);
    expect(() => store().readSecret(fresh.id)).toThrow(expect.objectContaining({ errorClass: 'repository_key_unavailable' }));
    expect(() => store().readSecret('missing')).toThrow(expect.objectContaining({ errorClass: 'repository_unavailable' }));
    expect(() => store().storeSecret(fresh.id, '')).toThrow(expect.objectContaining({ errorClass: 'invalid_request' }));
  });
});

describe('redaction boundary', () => {
  it('gives every error class a fixed sentence that carries no input', () => {
    const err = new redaction.RecoveryError('repository_key_unavailable');
    expect(err.message).toBe(redaction.errorDetailFor('repository_key_unavailable'));
    expect(redaction.classifyRecoveryError(new Error('restic: wrong password for /home/someone/repo'))).toBe('internal');
    expect(redaction.classifyRecoveryError(err)).toBe('repository_key_unavailable');
  });

  it('strips a known secret and credential shapes from node-local log text', () => {
    const line = redaction.redactRecoveryLogText(
      'restic failed with s3cr3t-pass at https://user:pw@example.com/repo password=other',
      ['s3cr3t-pass'],
    );
    expect(line).not.toContain('s3cr3t-pass');
    expect(line).not.toContain('user:pw');
    expect(line).not.toContain('password=other');
  });

  it('names the two node answers that are not network faults', () => {
    expect(redaction.errorDetailFor('node_refused')).toBe('The node refused the request.');
    expect(redaction.errorDetailFor('node_error')).toBe('The node could not answer the request.');
  });

  it('accepts plain metadata and paths under a home directory', () => {
    expect(() => redaction.assertMetadataOnly({
      storageKey: 'abc', idempotencyKey: 'k', exclusions: [{ path: '/home/someone/data', reason: 'unreadable' }],
    }, 'test')).not.toThrow();
    expect(() => redaction.assertMetadataOnly({ nested: { apiKey: 'x' } }, 'test')).toThrow();
    expect(() => redaction.assertMetadataOnly(['Bearer abcdefghijklmnop'], 'test')).toThrow();
  });
});

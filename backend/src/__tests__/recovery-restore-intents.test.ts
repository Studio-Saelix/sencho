/**
 * The restore-intent phase table. The overwrite pipeline is only safe if an
 * illegal phase change is refused rather than coerced: a restore that skipped the
 * fence would move live data with the workloads still running, and one that left
 * a terminal phase would be reconciled twice.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let intents: typeof import('../services/recovery/restoreIntents');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let tmpDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  intents = await import('../services/recovery/restoreIntents');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  const db = recoveryDbModule.recoveryDb();
  for (const table of ['recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_point_holds',
    'recovery_locks', 'recovery_operations', 'recovery_point_verifications', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

/** One storage, repository, operation and point: everything an intent joins to. */
function seed(): { pointId: string; operationId: string } {
  const db = recoveryDbModule.recoveryDb();
  db.exec(`
    INSERT OR IGNORE INTO recovery_storage_identities
      (id, authority_id, owner_node_key, kind, locator, storage_key, generation, generation_token, state, first_seen_at, last_seen_at)
      VALUES ('s1', 'a', 'docker-engine:a', 'named_volume', 'data', 'k', 1, 'token-1', 'current', 1, 1);
    INSERT OR IGNORE INTO recovery_repositories (id, authority_id, owner_node_key, kind, locator, failure_domain, created_at)
      VALUES ('r1', 'a', 'docker-engine:a', 'local_volume', 'repo', 'same_failure_domain', 1);
  `);
  const operationId = randomUUID();
  db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, actor, transport, state, process_epoch, created_at, updated_at)
    VALUES (?, ?, 'restore', 'admin', 'local', 'running', 'e', 1, 1)`).run(operationId, randomUUID());
  const pointId = randomUUID();
  db.prepare(`INSERT INTO recovery_points
    (id, schema_version, storage_id, storage_generation, kind, repository_id, snapshot_id, status, consistency,
     capture_json, trigger_kind, actor, source_operation_id, source_node_key, engine_id, capability_version, started_at, completed_at)
    VALUES (?, 3, 's1', 1, 'root', 'r1', 'snap', 'succeeded', 'crash_consistent_live',
      '{"fileCount":1,"byteCount":1,"skippedCount":0}', 'manual', 'admin', ?, 'docker-engine:a', 'restic', 1, 1, 2)`)
    .run(pointId, operationId);
  return { pointId, operationId };
}

/** The recovery error class of a refusal, so a case asserts the contract not the prose. */
function refuses(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { errorClass?: string }).errorClass ?? 'not-a-recovery-error';
  }
  return 'allowed';
}

function overwriteIntent(): string {
  const { pointId, operationId } = seed();
  const record = intents.RestoreIntentStore.getInstance().recordOverwrite({
    operationId,
    pointId,
    targetVolume: 'data',
    actor: 'admin',
    processEpoch: 'e',
    stagingVolume: 'sencho-recovery-stage-x',
    expectedGenerationToken: 'token-1',
  });
  return record.id;
}

function newVolumeIntent(): string {
  const { pointId, operationId } = seed();
  const record = intents.RestoreIntentStore.getInstance().record({
    operationId,
    pointId,
    targetVolume: 'fresh-target',
    actor: 'admin',
    processEpoch: 'e',
  });
  return record.id;
}

describe('the staged-overwrite phase table', () => {
  it('walks the whole overwrite path in order', () => {
    const id = overwriteIntent();
    const store = intents.RestoreIntentStore.getInstance();
    const path: import('../services/recovery/types').RestoreIntentPhase[] = [
      'staging', 'staged_verified', 'fenced', 'protecting', 'materializing', 'swapping', 'swapped', 'committed',
    ];
    for (const phase of path) store.advance(id, phase);
    expect(store.get(id)?.phase).toBe('committed');
  });

  it('refuses a phase it never reached, and every phase after a terminal one', () => {
    const id = overwriteIntent();
    const store = intents.RestoreIntentStore.getInstance();
    // recorded -> swapped would move live data with the workloads still running.
    expect(refuses(() => store.advance(id, 'swapped'))).toBe('invalid_request');
    expect(refuses(() => store.advance(id, 'materializing'))).toBe('invalid_request');
    store.advance(id, 'rolled_back');
    for (const phase of ['staging', 'fenced', 'swapping', 'committed'] as const) {
      expect(refuses(() => store.advance(id, phase))).toBe('invalid_request');
    }
    expect(store.get(id)?.phase).toBe('rolled_back');
  });

  it('keeps a new-volume restore out of the overwrite phases', () => {
    const id = newVolumeIntent();
    const store = intents.RestoreIntentStore.getInstance();
    for (const phase of ['fenced', 'protecting', 'materializing', 'swapping', 'swapped'] as const) {
      expect(refuses(() => store.advance(id, phase))).toBe('invalid_request');
    }
    store.advance(id, 'staging');
    store.advance(id, 'staged_verified');
    store.advance(id, 'committed');
    expect(store.get(id)?.phase).toBe('committed');
  });

  it('records the staging volume, generation token and the failure class with the phase', () => {
    const id = overwriteIntent();
    const store = intents.RestoreIntentStore.getInstance();
    store.advance(id, 'staging');
    store.advance(id, 'staged_verified', {
      filesRestored: 12, bytesRestored: 4096, verified: true, xattrWarnings: 0,
    });
    store.advance(id, 'fenced');
    const record = store.get(id);
    expect(record).toMatchObject({
      phase: 'fenced',
      filesRestored: 12,
      bytesRestored: 4096,
      verified: true,
      xattrWarnings: 0,
      expectedGenerationToken: 'token-1',
      stagingVolume: 'sencho-recovery-stage-x',
    });
    store.advance(id, 'rolled_back', { outcomeClass: 'pre_restore_failed' });
    expect(store.get(id)?.outcomeClass).toBe('pre_restore_failed');
  });

  it('keeps one live intent per target volume, and frees the name once it settles', () => {
    const first = overwriteIntent();
    const { pointId, operationId } = seed();
    expect(refuses(() => intents.RestoreIntentStore.getInstance().recordOverwrite({
      operationId,
      pointId,
      targetVolume: 'data',
      actor: 'admin',
      processEpoch: 'e',
      stagingVolume: 'sencho-recovery-stage-y',
      expectedGenerationToken: 'token-1',
    }))).toBe('lock_held');
    intents.RestoreIntentStore.getInstance().advance(first, 'rolled_back');
    expect(() => intents.RestoreIntentStore.getInstance().recordOverwrite({
      operationId,
      pointId,
      targetVolume: 'data',
      actor: 'admin',
      processEpoch: 'e',
      stagingVolume: 'sencho-recovery-stage-y',
      expectedGenerationToken: 'token-1',
    })).not.toThrow();
  });
});

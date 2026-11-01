/**
 * What a restart settles.
 *
 * An interrupted restore is the dangerous case: a volume may hold half-written
 * data that nothing has ever run against. The three outcomes are the whole
 * policy, so they are pinned here: a target that is gone is rolled back, one that
 * is ours and unused is removed, and one that is ours but in use stays and reads
 * `completion_unknown`. A target that is not ours is never touched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let intents: typeof import('../services/recovery/restoreIntents');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let identityStore: typeof import('../services/recovery/storageIdentity');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let operations: typeof import('../services/recovery/operations');

const ENGINE = 'docker-engine:restart';
const LABEL = 'dev.sencho.recovery.restore-intent';

interface FakeVolume {
  name: string;
  labels: Record<string, string>;
}

function fakeDocker(volumes: FakeVolume[], mounted: string[] = []) {
  const removed: string[] = [];
  return {
    removed,
    docker: {
      getVolume: (name: string) => ({
        inspect: async () => {
          const found = volumes.find((v) => v.name === name);
          if (!found) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
          return { Name: found.name, Labels: found.labels };
        },
        remove: async () => {
          const index = volumes.findIndex((v) => v.name === name);
          if (index >= 0) volumes.splice(index, 1);
          removed.push(name);
        },
      }),
      listContainers: async () => mounted.map((Name) => ({ Mounts: [{ Type: 'volume', Name }] })),
    } as unknown as Docker,
  };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  intents = await import('../services/recovery/restoreIntents');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  identityStore = await import('../services/recovery/storageIdentity');
  repositories = await import('../services/recovery/repositories');
  points = await import('../services/recovery/recoveryPoints');
  operations = await import('../services/recovery/operations');
});

afterAll(async () => {
  await cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const db = recoveryDbModule.recoveryDb();
  for (const table of [
    'recovery_restore_intents', 'recovery_repository_checks', 'recovery_locks', 'recovery_operations',
    'recovery_point_verifications', 'recovery_points', 'recovery_repositories',
    'recovery_storage_dependents', 'recovery_storage_identities',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

/** A point and an operation to hang an intent on. */
function seedIntent(targetVolume: string, phase: 'recorded' | 'staging' | 'staged_verified'): { intentId: string; operationId: string } {
  const repository = repositories.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE,
    kind: 'local_volume',
    locator: 'repo',
    failureDomain: 'same_failure_domain',
  });
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE,
    kind: 'named_volume',
    locator: 'source',
    generationToken: 't1',
    dependents: [],
  });
  const point = points.RecoveryPointStore.getInstance().begin({
    kind: 'root',
    storageId: storage.id,
    expectedGenerationToken: 't1',
    repositoryId: repository.id,
    trigger: 'manual',
    actor: 'admin',
    sourceOperationId: 'op-src',
    sourceNodeKey: ENGINE,
    engineId: 'restic',
  });
  points.RecoveryPointStore.getInstance().finalize(point.id, {
    status: 'succeeded',
    evidence: { snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
  });
  const operation = operations.RecoveryOperationStore.getInstance().start({
    idempotencyKey: `key-${targetVolume}`,
    kind: 'restore',
    storageId: storage.id,
    pointId: point.id,
    actor: 'admin',
    transport: 'local',
    requestDigest: 'a'.repeat(64),
  });
  operations.RecoveryOperationStore.getInstance().markRunning(operation.operation.id);
  const intent = intents.RestoreIntentStore.getInstance().record({
    operationId: operation.operation.id,
    pointId: point.id,
    targetVolume,
    actor: 'admin',
    processEpoch: 'dead-epoch',
  });
  if (phase !== 'recorded') intents.RestoreIntentStore.getInstance().advance(intent.id, 'staging');
  if (phase === 'staged_verified') intents.RestoreIntentStore.getInstance().advance(intent.id, 'staged_verified');
  return { intentId: intent.id, operationId: operation.operation.id };
}

describe('restore intent reconciliation at boot', () => {
  it('rolls back an intent whose target is already gone', async () => {
    const { intentId } = seedIntent('vanished_target', 'staging');
    const result = await intents.reconcileRestoreIntentsAtStartup(fakeDocker([]).docker);
    expect(result).toEqual({ rolledBack: 1, unknown: 0 });
    expect(intents.RestoreIntentStore.getInstance().get(intentId)?.phase).toBe('rolled_back');
  });

  it('removes its own unused target and rolls back', async () => {
    const { intentId } = seedIntent('partial_target', 'staging');
    const intent = intents.RestoreIntentStore.getInstance().get(intentId);
    const fake = fakeDocker([{ name: 'partial_target', labels: { [LABEL]: intent?.id ?? '' } }]);
    const result = await intents.reconcileRestoreIntentsAtStartup(fake.docker);
    expect(result).toEqual({ rolledBack: 1, unknown: 0 });
    expect(fake.removed).toEqual(['partial_target']);
    expect(intents.RestoreIntentStore.getInstance().get(intentId)?.phase).toBe('rolled_back');
  });

  it('keeps a target a container is using and reports it unknown', async () => {
    const { intentId } = seedIntent('in_use_target', 'staged_verified');
    const intent = intents.RestoreIntentStore.getInstance().get(intentId);
    const fake = fakeDocker(
      [{ name: 'in_use_target', labels: { [LABEL]: intent?.id ?? '' } }],
      ['in_use_target'],
    );
    const result = await intents.reconcileRestoreIntentsAtStartup(fake.docker);
    expect(result).toEqual({ rolledBack: 0, unknown: 1 });
    expect(fake.removed).toEqual([]);
    expect(intents.RestoreIntentStore.getInstance().get(intentId)?.phase).toBe('completion_unknown');
  });

  it('never touches a target that does not carry this intent label', async () => {
    const { intentId } = seedIntent('someone_elses', 'staging');
    const fake = fakeDocker([{ name: 'someone_elses', labels: {} }]);
    const result = await intents.reconcileRestoreIntentsAtStartup(fake.docker);
    expect(result).toEqual({ rolledBack: 0, unknown: 1 });
    expect(fake.removed).toEqual([]);
    expect(intents.RestoreIntentStore.getInstance().get(intentId)?.phase).toBe('completion_unknown');
  });

  it('leaves committed intents alone', async () => {
    const { intentId } = seedIntent('done_target', 'staged_verified');
    intents.RestoreIntentStore.getInstance().advance(intentId, 'committed');
    const fake = fakeDocker([{ name: 'done_target', labels: {} }]);
    const result = await intents.reconcileRestoreIntentsAtStartup(fake.docker);
    expect(result).toEqual({ rolledBack: 0, unknown: 0 });
    expect(fake.removed).toEqual([]);
  });
});

describe('log lines that name a restore target', () => {
  const NAME = 'vol\r\n[forged] entry';

  function printed(spy: { mock: { calls: unknown[][] } }): string {
    return spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  }

  it('strips control characters when a second live restore into the target is refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { operationId } = seedIntent(NAME, 'recorded');
    // The unique index on live targets refuses the second record.
    expect(() => intents.RestoreIntentStore.getInstance().record({
      operationId, pointId: 'p', targetVolume: NAME, actor: 'admin', processEpoch: 'epoch',
    })).toThrow();
    expect(printed(warn)).toContain('vol[forged] entry');
    expect(printed(warn)).not.toMatch(/[\x00-\x1F\x7F]/);
    warn.mockRestore();
  });

  it('strips control characters when the target cannot be inspected at boot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    seedIntent(NAME, 'staging');
    const docker = {
      listContainers: async () => [],
      getVolume: () => ({ inspect: async () => { throw Object.assign(new Error('daemon down'), { statusCode: 500 }); } }),
    } as unknown as Docker;
    await intents.reconcileRestoreIntentsAtStartup(docker);
    expect(printed(warn)).toContain('vol[forged] entry');
    expect(printed(warn)).not.toMatch(/[\x00-\x1F\x7F]/);
    warn.mockRestore();
  });

  it('strips control characters when the interrupted target cannot be removed at boot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { intentId } = seedIntent(NAME, 'staging');
    const docker = {
      listContainers: async () => [],
      getVolume: () => ({
        inspect: async () => ({ Labels: { [LABEL]: intentId } }),
        remove: async () => { throw new Error('busy'); },
      }),
    } as unknown as Docker;
    await intents.reconcileRestoreIntentsAtStartup(docker);
    expect(printed(warn)).toContain('vol[forged] entry');
    expect(printed(warn)).not.toMatch(/[\x00-\x1F\x7F]/);
    warn.mockRestore();
  });
});

describe('restart truth', () => {
  it('never resumes a dead process\'s operation, and turns its lock stale', () => {
    const { operationId } = seedIntent('leftover', 'staging');
    const store = operations.RecoveryOperationStore.getInstance();
    const repositoryId = repositories.RecoveryRepositoryStore.getInstance().getActive()?.id ?? 'repo';
    // A lock the previous process held, on a repository it was writing.
    const db = recoveryDbModule.recoveryDb();
    db.prepare(`
      INSERT INTO recovery_locks (scope, resource_key, owner_operation_id, process_epoch, acquired_at)
      VALUES ('repository', ?, ?, 'dead-epoch', 1)
    `).run(repositoryId, operationId);

    const settled = new operations.RecoveryOperationStore('live-epoch');
    const result = settled.reconcileAtStartup();
    expect(result.interruptedOperations).toBe(1);
    expect(result.staleLocks).toBe(1);

    const operation = store.get(operationId);
    expect(operation).toMatchObject({ state: 'completion_unknown', errorClass: 'interrupted' });
    const lock = store.getLock('repository', repositoryId);
    expect(lock?.staleSince).not.toBeNull();
  });

  it('refuses to move a dead process\'s operation to running', () => {
    const { operationId } = seedIntent('leftover-2', 'staging');
    const db = recoveryDbModule.recoveryDb();
    // Queued, but owned by a process that is gone, and not yet reconciled.
    db.prepare("UPDATE recovery_operations SET state = 'queued', process_epoch = 'dead-epoch' WHERE id = ?").run(operationId);
    const store = operations.RecoveryOperationStore.getInstance();
    expect(() => store.markRunning(operationId)).toThrow(/interrupted/i);
    expect(store.get(operationId)?.state).toBe('queued');
  });

  it('refuses to finish a dead process\'s operation', () => {
    const { operationId } = seedIntent('leftover-3', 'staging');
    recoveryDbModule.recoveryDb()
      .prepare("UPDATE recovery_operations SET process_epoch = 'dead-epoch' WHERE id = ?").run(operationId);
    const store = operations.RecoveryOperationStore.getInstance();
    expect(() => store.finish(operationId, { state: 'failed', errorClass: 'internal' })).toThrow(/interrupted/i);
  });
});

describe('intent transitions', () => {
  it('refuses a phase that does not follow', () => {
    const { intentId } = seedIntent('ordered', 'recorded');
    expect(() => intents.RestoreIntentStore.getInstance().advance(intentId, 'committed'))
      .toThrow(/not valid/i);
    expect(intents.RestoreIntentStore.getInstance().advance(intentId, 'staging').phase).toBe('staging');
    expect(intents.RestoreIntentStore.getInstance().advance(intentId, 'staged_verified').phase).toBe('staged_verified');
    expect(intents.RestoreIntentStore.getInstance().advance(intentId, 'committed').phase).toBe('committed');
    expect(() => intents.RestoreIntentStore.getInstance().advance(intentId, 'rolled_back'))
      .toThrow(/not valid/i);
  });
});

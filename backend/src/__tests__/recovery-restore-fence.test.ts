/**
 * The durable restore fence.
 *
 * A staged overwrite stops every container that mounts the volume, so the only
 * thing that makes that safe is that nothing Sencho runs can start one of them
 * again, or write the volume, until the restore releases it. These cases check
 * each site that could break that rule, and that the record exists before the
 * Docker mutation it describes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { fakeDocker, container, intentLabels } from './__helpers__/overwriteFixture';
import { DataRestoreFenceError } from '../helpers/dataRestoreFenceError';
import type { FenceMemberInput } from '../services/recovery/restoreFence';
import type { RestoreIntentPhase } from '../services/recovery/types';

let fence: typeof import('../services/recovery/restoreFence');
let intents: typeof import('../services/recovery/restoreIntents');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let locks: typeof import('../services/StackOpLockService');
let DockerController: typeof import('../services/DockerController').default;
let NodeRegistryModule: typeof import('../services/NodeRegistry');
let VolumeBrowserService: typeof import('../services/VolumeBrowserService');
let tmpDir: string;

const VOLUME = 'app_data';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  fence = await import('../services/recovery/restoreFence');
  intents = await import('../services/recovery/restoreIntents');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  locks = await import('../services/StackOpLockService');
  DockerController = (await import('../services/DockerController')).default;
  NodeRegistryModule = await import('../services/NodeRegistry');
  VolumeBrowserService = await import('../services/VolumeBrowserService');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  const db = recoveryDbModule.recoveryDb();
  for (const table of ['recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_point_holds',
    'recovery_locks', 'recovery_operations', 'recovery_point_verifications', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  locks.StackOpLockService.resetForTests();
  fence.resetRestoreFenceWarningForTests();
  vi.restoreAllMocks();
});

const PHASE_PATH: readonly RestoreIntentPhase[] = [
  'staging', 'staged_verified', 'fenced', 'protecting', 'materializing', 'swapping', 'swapped',
];

/** A storage, repository, operation and point, then one intent walked to `phase`. */
function seedIntent(phase: RestoreIntentPhase): string {
  const db = recoveryDbModule.recoveryDb();
  db.exec(`
    INSERT OR IGNORE INTO recovery_storage_identities
      (id, authority_id, owner_node_key, kind, locator, storage_key, generation, generation_token, state, first_seen_at, last_seen_at)
      VALUES ('s1', 'a', 'docker-engine:a', 'named_volume', '${VOLUME}', 'k', 1, 'token-1', 'current', 1, 1);
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
  const intent = intents.RestoreIntentStore.getInstance().recordOverwrite({
    operationId,
    pointId,
    targetVolume: VOLUME,
    actor: 'admin',
    processEpoch: 'e',
    stagingVolume: 'sencho-recovery-stage-x',
    expectedGenerationToken: 'token-1',
  });
  const store = intents.RestoreIntentStore.getInstance();
  for (const step of PHASE_PATH) {
    store.advance(intent.id, step);
    if (step === phase) break;
  }
  return intent.id;
}

const member = (overrides: Partial<FenceMemberInput> = {}): FenceMemberInput => ({
  containerId: 'c1',
  containerName: 'stack-dir-web-1',
  stackName: 'stack-dir',
  projectName: 'stack-dir',
  restartPolicy: { Name: 'always' },
  wasRunning: true,
  ...overrides,
});

describe('the fence record', () => {
  it('records the members before the policy change, and changes the policy before the stop', async () => {
    const intentId = seedIntent('fenced');
    const fake = fakeDocker({ containers: [container({ Id: 'c1', State: 'running' })] });
    // Every Docker call is inspected as it happens, against the record and the
    // container's policy at that moment.
    const seen: Array<{ call: string; recorded: number; policy: string }> = [];
    fake.failOn = (call) => {
      seen.push({
        call,
        recorded: fence.RestoreFenceStore.getInstance().listMembers(intentId).length,
        policy: fake.containers.get('c1')?.HostConfig.RestartPolicy.Name ?? 'missing',
      });
      return null;
    };

    fence.RestoreFenceStore.getInstance().recordMembers(intentId, [member()]);
    await fence.applyRestoreFence(intentId, fake.docker, fence.RestoreFenceStore.getInstance().listMembers(intentId));

    expect(seen.map((entry) => entry.call)).toEqual(['update:c1', 'stop:c1']);
    expect(seen[0].recorded).toBe(1);
    // The policy was pinned before the container was stopped, so a daemon
    // restart after a power cut cannot bring it back on half-swapped data.
    expect(seen[1].policy).toBe('no');
    expect(fake.containers.get('c1')?.State).toBe('exited');
  });

  it('stops a container that was already stopped and still pins its policy', async () => {
    const intentId = seedIntent('fenced');
    const fake = fakeDocker({ containers: [container({ Id: 'c1', State: 'exited' })] });
    fence.RestoreFenceStore.getInstance().recordMembers(intentId, [member({ wasRunning: false })]);
    await fence.applyRestoreFence(intentId, fake.docker, fence.RestoreFenceStore.getInstance().listMembers(intentId));
    // 304 is "already stopped", which is the state the fence wants.
    expect(fake.calls).toEqual(['update:c1', 'stop:c1']);
  });

  it('refuses the operation when a container cannot be fenced', async () => {
    const intentId = seedIntent('fenced');
    const fake = fakeDocker({ containers: [container({ Id: 'c1' })] });
    fake.failOn = (call) => (call === 'update:c1'
      ? Object.assign(new Error('permission denied'), { statusCode: 403 })
      : null);
    fence.RestoreFenceStore.getInstance().recordMembers(intentId, [member()]);
    await expect(fence.applyRestoreFence(intentId, fake.docker, fence.RestoreFenceStore.getInstance().listMembers(intentId)))
      .rejects.toMatchObject({ errorClass: 'fence_unavailable' });
  });

  it('restores every recorded policy and starts only what was running', async () => {
    const intentId = seedIntent('swapped');
    const fake = fakeDocker({
      containers: [
        container({ Id: 'c1', HostConfig: { RestartPolicy: { Name: 'no' } } }),
        container({ Id: 'c2', State: 'exited', HostConfig: { RestartPolicy: { Name: 'no' } } }),
      ],
    });
    fence.RestoreFenceStore.getInstance().recordMembers(intentId, [
      member({ containerId: 'c1', restartPolicy: { Name: 'always' }, wasRunning: true }),
      member({ containerId: 'c2', restartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 }, wasRunning: false }),
    ]);
    await fence.releaseRestoreFence(
      intentId, fake.docker, fence.RestoreFenceStore.getInstance().listMembers(intentId), { restart: true },
    );

    const c1 = fake.containers.get('c1');
    const c2 = fake.containers.get('c2');
    expect(c1?.HostConfig.RestartPolicy).toEqual({ Name: 'always' });
    expect(c2?.HostConfig.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 3 });
    expect(c1?.State).toBe('running');
    // It was stopped before the restore, so it stays stopped.
    expect(c2?.State).toBe('exited');
    expect(fake.calls).toEqual(['update:c1', 'start:c1', 'update:c2']);
    expect(intents.RestoreIntentStore.getInstance().get(intentId)?.fenceState).toBe('released');
  });

  it('keeps the fence held and reports it when a policy cannot be restored', async () => {
    const intentId = seedIntent('swapped');
    const fake = fakeDocker({ containers: [container({ Id: 'c1' })] });
    fake.failOn = (call) => (call === 'update:c1' ? new Error('daemon gone') : null);
    fence.RestoreFenceStore.getInstance().recordMembers(intentId, [member()]);
    await expect(fence.releaseRestoreFence(
      intentId, fake.docker, fence.RestoreFenceStore.getInstance().listMembers(intentId), { restart: true },
    )).rejects.toMatchObject({ errorClass: 'fence_unavailable' });
    expect(intents.RestoreIntentStore.getInstance().get(intentId)?.fenceState).toBe('release_failed');
  });
});

describe('what the fence closes', () => {
  it('refuses a Compose lifecycle on a fenced stack under its Compose project name', () => {
    const intentId = seedIntent('fenced');
    fence.RestoreFenceStore.getInstance().recordMembers(intentId, [
      member({ stackName: 'stack-dir', projectName: 'StackDir' }),
    ]);
    fence.RestoreFenceStore.getInstance().setFenceState(intentId, 'held');
    const service = locks.StackOpLockService.getInstance();
    // The directory name and the project name both resolve to the same workload.
    for (const name of ['stack-dir', 'StackDir']) {
      const result = service.tryAcquire(1, name, 'deploy', 'alice');
      expect(result.acquired).toBe(false);
      expect(result.acquired === false && result.existing.action).toBe('data_restore');
    }
    // A stack that does not mount the volume is unaffected.
    expect(service.tryAcquire(1, 'other', 'deploy', 'alice').acquired).toBe(true);
  });

  it('stops closing a stack once the fence is released or settled', () => {
    const intentId = seedIntent('fenced');
    const store = fence.RestoreFenceStore.getInstance();
    store.recordMembers(intentId, [member()]);
    store.setFenceState(intentId, 'held');
    expect(locks.StackOpLockService.getInstance().tryAcquire(1, 'stack-dir', 'start', 'alice').acquired).toBe(false);
    intents.RestoreIntentStore.getInstance().setFenceState(intentId, 'released');
    intents.RestoreIntentStore.getInstance().advance(intentId, 'rolled_back');
    expect(locks.StackOpLockService.getInstance().tryAcquire(1, 'stack-dir', 'start', 'alice').acquired).toBe(true);
  });

  it('refuses a container start and restart by its mounts, not by its project label', async () => {
    const intentId = seedIntent('fenced');
    const fake = fakeDocker({
      containers: [
        // A project label that has nothing to do with the stack directory.
        container({ Id: 'c1', Labels: { 'com.docker.compose.project': 'some-other-name' }, Mounts: [{ Type: 'volume', Name: VOLUME }] }),
        container({ Id: 'c2', Mounts: [{ Type: 'bind', Name: 'x' }] }),
      ],
    });
    // The controller reads its client from the registry when it is constructed,
    // so the stub has to live there for the controller's own methods.
    vi.spyOn(NodeRegistryModule.NodeRegistry.getInstance(), 'getDocker').mockReturnValue(fake.docker);
    fence.RestoreFenceStore.getInstance().recordMembers(intentId, [member({ stackName: null, projectName: 'some-other-name' })]);
    fence.RestoreFenceStore.getInstance().setFenceState(intentId, 'held');

    const controller = DockerController.getInstance(1);
    await expect(controller.startContainer('c1')).rejects.toMatchObject({ code: 'data_restore' });
    await expect(controller.restartContainer('c1')).rejects.toMatchObject({ code: 'data_restore' });
    await expect(controller.startContainer('c2')).resolves.toBeUndefined();
    // The fenced container was never started; the ordinary one was.
    expect(fake.calls.filter((call) => call.endsWith(':c1'))).toEqual([]);
    expect(fake.calls).toContain('start:c2');
  });

  it('refuses the Files & Volumes browser on a fenced volume', async () => {
    const intentId = seedIntent('fenced');
    const fake = fakeDocker({ volumes: [{ name: VOLUME }, { name: 'other' }] });
    vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue(fake.docker);
    fence.RestoreFenceStore.getInstance().recordMembers(intentId, [member()]);
    fence.RestoreFenceStore.getInstance().setFenceState(intentId, 'held');
    const browser = VolumeBrowserService.VolumeBrowserService.getInstance(1);
    await expect(browser.listDir(VOLUME, '')).rejects.toMatchObject({ code: 'data_restore' });
  });

  it('fails open with one warning when the store cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(recoveryDbModule, 'recoveryDb').mockImplementation(() => {
      throw new Error('schema newer than this build');
    });
    try {
      const store = fence.RestoreFenceStore.getInstance();
      expect(store.isStackFenced('stack-dir')).toBe(false);
      expect(store.isVolumeFenced(VOLUME)).toBe(false);
      expect(store.liveFencedVolumeNames()).toEqual([]);
      // One line for the condition, not one per request.
      store.isStackFenced('stack-dir');
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('restore fence store'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('fence identity', () => {
  it('resolves the stack from the project label map, and keeps the project label', () => {
    const map = new Map([['StackDir', 'stack-dir']]);
    expect(fence.fenceIdentityFor(
      { Labels: { 'com.docker.compose.project': 'StackDir' } }, map, ['stack-dir'],
    )).toEqual({ stackName: 'stack-dir', projectName: 'StackDir' });
    // A project label that matches no stack is still recorded, so a caller
    // keying by the label is refused too.
    expect(fence.fenceIdentityFor(
      { Labels: { 'com.docker.compose.project': 'unmanaged' } }, map, ['stack-dir'],
    )).toEqual({ stackName: null, projectName: 'unmanaged' });
    expect(fence.fenceIdentityFor({}, map, ['stack-dir'])).toEqual({ stackName: null, projectName: null });
  });

  it('names only the volume in the refusal, and tags a created volume with the intent', () => {
    const err = new DataRestoreFenceError(VOLUME);
    expect(err.message).toContain(VOLUME);
    expect(err.code).toBe('data_restore');
    expect(intentLabels('intent-1')).toEqual({ 'dev.sencho.recovery.restore-intent': 'intent-1' });
  });
});

/**
 * The staged overwrite pipeline.
 *
 * Each case fails the work at one step and asserts the property that step exists
 * for: nothing live moved before the point was proven, the fence was released
 * and the workloads restarted on every failure that did not commit, and a
 * cleanup failure never restarts a workload next to a leftover directory.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { format } from 'util';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
  container,
  DEFAULT_CAPTURE,
  delayContainerCall,
  fakeDocker,
  gate,
  intentLabels,
  scriptedEngine,
  scriptedHelper,
} from './__helpers__/overwriteFixture';
import { HELPER_LABEL_RESTORE_INTENT } from '../services/recovery/restic/helperRunner';

let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let identityStore: typeof import('../services/recovery/storageIdentity');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let intents: typeof import('../services/recovery/restoreIntents');
let fence: typeof import('../services/recovery/restoreFence');
let overwrite: typeof import('../services/recovery/overwriteRestore');
let DockerController: typeof import('../services/DockerController').default;

let tmpDir: string;
const ENGINE = 'docker-engine:overwrite-runner';
const VOLUME = 'app_data';
const STACK = 'stack-dir';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  identityStore = await import('../services/recovery/storageIdentity');
  repositories = await import('../services/recovery/repositories');
  points = await import('../services/recovery/recoveryPoints');
  intents = await import('../services/recovery/restoreIntents');
  fence = await import('../services/recovery/restoreFence');
  overwrite = await import('../services/recovery/overwriteRestore');
  DockerController = (await import('../services/DockerController')).default;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  const db = recoveryDbModule.recoveryDb();
  for (const table of ['recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_locks',
    'recovery_operations', 'recovery_point_verifications', 'recovery_point_holds', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  fence.resetRestoreFenceWarningForTests();
  vi.restoreAllMocks();
  vi.spyOn(DockerController, 'resolveProjectNameMap')
    .mockResolvedValue(new Map([[STACK, STACK]]));
});

interface Seeded {
  intentId: string;
  operationId: string;
  pointId: string;
  repository: import('../services/recovery/types').RepositoryDescriptor;
  generationToken: string;
}

/** A storage, point, operation and a recorded overwrite intent with its fence members. */
function seed(input: {
  createdAt: string;
  members: Array<Parameters<typeof container>[0]>;
}): Seeded {
  const repository = repositories.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE,
    kind: 'local_volume',
    locator: 'repo',
    failureDomain: 'same_failure_domain',
  });
  repositories.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  const generationToken = `${input.createdAt}|63:42`;
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE,
    kind: 'named_volume',
    locator: VOLUME,
    generationToken,
    dependents: [],
  });
  const point = points.RecoveryPointStore.getInstance().begin({
    kind: 'root',
    storageId: storage.id,
    expectedGenerationToken: generationToken,
    repositoryId: repository.id,
    trigger: 'manual',
    actor: 'admin',
    sourceOperationId: 'op-src',
    sourceNodeKey: ENGINE,
    engineId: 'restic',
  });
  points.RecoveryPointStore.getInstance().finalize(point.id, {
    status: 'succeeded',
    evidence: {
      snapshotId: 'snap-1',
      capture: { fileCount: 3, byteCount: 300, skippedCount: 0 },
      exclusions: [],
      consistency: 'crash_consistent_live',
    },
  });
  const operationId = randomUUID();
  const db = recoveryDbModule.recoveryDb();
  db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, process_epoch, created_at, updated_at)
    VALUES (?, ?, 'restore', ?, ?, 'admin', 'local', 'running', 'e', 1, 1)`)
    .run(operationId, randomUUID(), storage.id, point.id);
  const intent = intents.RestoreIntentStore.getInstance().recordOverwrite({
    operationId,
    pointId: point.id,
    targetVolume: VOLUME,
    actor: 'admin',
    processEpoch: 'e',
    stagingVolume: overwrite.stagingVolumeFor(randomUUID()),
    expectedGenerationToken: generationToken,
  });
  points.RecoveryPointStore.getInstance().addHold({
    pointId: point.id, holderKind: 'restore_intent', holderRef: intent.id,
  });
  fence.RestoreFenceStore.getInstance().recordMembers(intent.id, input.members.map((item) => ({
    containerId: item.Id,
    containerName: item.Names?.[0]?.replace(/^\//, '') ?? item.Id,
    stackName: STACK,
    projectName: STACK,
    restartPolicy: item.HostConfig?.RestartPolicy ?? { Name: 'always' },
    wasRunning: item.State === 'running',
  })));
  // The staging volume name is derived from the intent id so the pipeline and
  // the seeded rows agree.
  const staging = overwrite.stagingVolumeFor(intent.id);
  recoveryDbModule.recoveryDb().prepare('UPDATE recovery_restore_intents SET staging_volume = ? WHERE id = ?')
    .run(staging, intent.id);
  return { intentId: intent.id, operationId, pointId: point.id, repository, generationToken };
}

type Finish = import('../services/recovery/types').OperationFinish;

async function run(input: {
  fake: ReturnType<typeof fakeDocker>;
  helper: ReturnType<typeof scriptedHelper>;
  engine: ReturnType<typeof scriptedEngine>;
  seeded: Seeded;
  signal?: AbortSignal;
  onChange?: () => void;
}): Promise<{ outcomes: Finish[]; progresses: number }> {
  const outcomes: Finish[] = [];
  let progresses = 0;
  const intent = intents.RestoreIntentStore.getInstance().get(input.seeded.intentId);
  await overwrite.runOverwritePipeline({
    deps: {
      nodeId: 1,
      nodeName: 'node-one',
      transport: 'local',
      docker: input.fake.docker,
      runner: () => input.helper.helper,
      points: points.RecoveryPointStore.getInstance(),
      repositories: repositories.RecoveryRepositoryStore.getInstance(),
      intents: intents.RestoreIntentStore.getInstance(),
      fence: fence.RestoreFenceStore.getInstance(),
      ownerNodeKey: ENGINE,
      knownStackNames: [],
      actor: 'admin',
      authorizeStack: () => true,
      authorizeGlobal: () => true,
    },
    operationId: input.seeded.operationId,
    intentId: input.seeded.intentId,
    repository: input.seeded.repository,
    engine: input.engine.engine,
    context: {
      operationId: input.seeded.operationId,
      pointId: input.seeded.pointId,
      lock: {
        scope: 'repository',
        resourceKey: input.seeded.repository.id,
        ownerOperationId: input.seeded.operationId,
        processEpoch: 'e',
        acquiredAt: Date.now(),
        staleSince: null,
      },
      signal: input.signal ?? new AbortController().signal,
      onProgress: () => { progresses += 1; },
    },
    finish: (outcome) => outcomes.push(outcome),
    onProgress: () => { progresses += 1; },
    // The hook lets a case change the world between two phases.
    ...(input.onChange ? {} : {}),
  });
  void intent;
  void input.onChange;
  return { outcomes, progresses };
}

function successHelper(overrides: Array<{ action: string; exitCode: number; status?: string }> = []) {
  return scriptedHelper({
    swapAnswers: [
      { action: 'prepare', exitCode: 0, status: 'planned' },
      { action: 'commit', exitCode: 0, status: 'swapped' },
      { action: 'status', exitCode: 0, status: 'swapped' },
      { action: 'cleanup', exitCode: 0, status: 'cleaned' },
      { action: 'rollback', exitCode: 0, status: 'rolled_back' },
      ...overrides,
    ],
  });
}

describe('a staged overwrite that succeeds', () => {
  it('stages, fences, protects, materializes, swaps, cleans up and restarts', async () => {
    const member = container({
      Id: 'c1',
      State: 'running',
      labels: undefined,
      Names: ['/stack-dir-db-1'],
      Mounts: [{ Type: 'volume', Name: VOLUME }],
    } as never);
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = successHelper();
    const engine = scriptedEngine();
    const { outcomes } = await run({ fake, helper, engine, seeded });

    expect(outcomes).toEqual([{ state: 'succeeded' }]);
    // Staging first, then the in-target materialization.
    expect(engine.restoreCalls.map((call) => call.mode)).toEqual(['new_volume', 'staged_overwrite']);
    expect(engine.restoreCalls[1].workDir).toMatch(/^\.sencho-restore-[0-9a-f-]{36}\/incoming$/);
    expect(engine.createPointCalls).toBe(1);

    // The point was proven before the workloads were stopped, and the staging
    // volume was removed before that too.
    const calls = fake.calls;
    const stagingCreated = calls.findIndex((call) => call === `createVolume:${overwrite.stagingVolumeFor(seeded.intentId)}`);
    const stagingRemoved = calls.findIndex((call) => call === `removeVolume:${overwrite.stagingVolumeFor(seeded.intentId)}`);
    const firstStop = calls.indexOf('stop:c1');
    expect(stagingCreated).toBeGreaterThanOrEqual(0);
    expect(stagingRemoved).toBeGreaterThan(stagingCreated);
    expect(firstStop).toBeGreaterThan(stagingRemoved);

    // The policy was pinned to no before the stop, and restored before the start.
    expect(calls.filter((call) => call === 'update:c1').length).toBe(2);
    expect(calls.indexOf('update:c1')).toBeLessThan(firstStop);
    expect(calls.lastIndexOf('update:c1')).toBeLessThan(calls.indexOf('start:c1'));

    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('committed');
    expect(intent?.fenceState).toBe('released');
    expect(intent?.preRestorePointId).toBeTruthy();
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toEqual([]);
    const preRestore = points.RecoveryPointStore.getInstance().get(intent?.preRestorePointId ?? '');
    expect(preRestore?.status).toBe('succeeded');
    expect(preRestore?.trigger).toBe('pre_restore');
    expect(fake.containers.get('c1')?.State).toBe('running');
    expect(fake.containers.get('c1')?.HostConfig.RestartPolicy).toEqual({ Name: 'always' });
  });
});

describe('a staged overwrite that fails before anything live moves', () => {
  it('fails at staging with the target untouched and no container stopped', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const engine = scriptedEngine({
      restores: [async () => ({ ok: false as const, errorClass: 'integrity_mismatch' as const })],
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'integrity_mismatch' }]);
    expect(fake.calls.some((call) => call.startsWith('update:') || call.startsWith('stop:') || call.startsWith('start:')))
      .toBe(false);
    expect(fake.volumes.has(overwrite.stagingVolumeFor(seeded.intentId))).toBe(false);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toEqual([]);
  });

  it('refuses when a new container appeared after admission', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    // A container that mounts the same volume shows up before the fence.
    fake.containers.set('c2', container({
      Id: 'c2', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }],
    }));
    const { outcomes } = await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'dependents_changed' }]);
    expect(fake.calls.some((call) => call.startsWith('stop:') || call.startsWith('update:'))).toBe(false);
  });

  it('fails with pre_restore_failed when the point taken first is partial, and restarts the workloads', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const engine = scriptedEngine({
      createPoint: async () => ({
        ok: true as const,
        evidence: {
          snapshotId: 'snap-pre',
          capture: { fileCount: 2, byteCount: 20, skippedCount: 1 },
          exclusions: [],
          consistency: 'crash_consistent_stopped' as const,
        },
      }),
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'pre_restore_failed' }]);
    expect(fake.calls).toContain('stop:c1');
    expect(fake.calls).toContain('start:c1');
    expect(fake.containers.get('c1')?.State).toBe('running');
    expect(fake.calls.some((call) => call === 'start:nonexistent')).toBe(false);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
  });

  it('does not restart a workload when the swap ends in an unknown state', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = scriptedHelper({
      swapAnswers: [
        { action: 'prepare', exitCode: 0, status: 'planned' },
        { action: 'commit', exitCode: 1 },
        { action: 'status', exitCode: 0, status: 'inconsistent' },
      ],
    });
    const { outcomes } = await run({ fake, helper, engine: scriptedEngine(), seeded });

    expect(outcomes).toEqual([{ state: 'completion_unknown' }]);
    expect(fake.calls).not.toContain('start:c1');
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('completion_unknown');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(true);
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);
  });
});

describe('a staged overwrite that fails after the commit', () => {
  it('reports cleanup_failed, keeps the fence held and starts nothing', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = scriptedHelper({
      swapAnswers: [
        { action: 'prepare', exitCode: 0, status: 'planned' },
        { action: 'commit', exitCode: 0, status: 'swapped' },
        { action: 'status', exitCode: 0, status: 'swapped' },
        { action: 'cleanup', exitCode: 1, status: 'inconsistent' },
      ],
    });
    const { outcomes } = await run({ fake, helper, engine: scriptedEngine(), seeded });

    expect(outcomes).toEqual([{ state: 'partial', errorClass: 'cleanup_failed' }]);
    expect(fake.calls).not.toContain('start:c1');
    expect(fake.containers.get('c1')?.State).toBe('exited');
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('swapped');
    expect(intent?.outcomeClass).toBe('cleanup_failed');
    expect(intent?.fenceState).toBe('held');
    // The data is committed, so the source point stays recoverable only through
    // the hold until the operator resolves it; the pre-restore point is held too.
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('cancels during staging and leaves the workloads alone', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const engine = scriptedEngine({
      restores: [async () => ({ ok: false as const, errorClass: 'interrupted' as const })],
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'cancelled' }]);
    expect(fake.calls.some((call) => call.startsWith('stop:') || call.startsWith('update:'))).toBe(false);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
  });
});

describe('cancelling after the fence is applied', () => {
  // A cancel aborts whichever helper is running. Whichever step it lands on, the
  // operation ends `cancelled` and the workloads come back, and an aborted
  // pre-restore capture is a stop, not a point that came out incomplete.
  function twoContainers() {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    return { fake, seeded };
  }

  it('ends cancelled, not pre_restore_failed, when the pre-restore capture is the step aborted', async () => {
    const { fake, seeded } = twoContainers();
    const engine = scriptedEngine({
      createPoint: async () => ({ ok: false as const, errorClass: 'interrupted' as const }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cancel = new AbortController();
    cancel.abort();
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded, signal: cancel.signal });

    expect(outcomes).toEqual([{ state: 'cancelled' }]);
    // The workloads were stopped by the fence and come back, on the original data.
    expect(fake.calls).toContain('stop:c1');
    expect(fake.calls).toContain('start:c1');
    expect(fake.containers.get('c1')?.State).toBe('running');
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('rolled_back');
    expect(intent?.fenceState).toBe('released');
    expect(intent?.outcomeClass).toBeNull();
    // The point taken for the cancelled run is not left looking complete.
    const preRestore = points.RecoveryPointStore.getInstance().get(intent?.preRestorePointId ?? '');
    expect(preRestore?.status).toBe('failed');
    // A stop the operator asked for is not logged as a failure.
    expect(warn).not.toHaveBeenCalled();
  });

  it('ends cancelled when the copy inside the volume is the step aborted', async () => {
    const { fake, seeded } = twoContainers();
    const engine = scriptedEngine({
      restores: [
        async () => ({ ok: true as const, evidence: { filesRestored: 4, bytesRestored: 400, verified: true } }),
        async () => ({ ok: false as const, errorClass: 'interrupted' as const }),
      ],
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'cancelled' }]);
    expect(fake.containers.get('c1')?.State).toBe('running');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
  });

  it('ends cancelled when the swap preparation is the step aborted, and restarts the workloads', async () => {
    const { fake, seeded } = twoContainers();
    const helper = scriptedHelper({
      swapAnswers: [
        { action: 'prepare', exitCode: 1, aborted: true },
        { action: 'rollback', exitCode: 0, status: 'rolled_back' },
      ],
    });
    const cancel = new AbortController();
    cancel.abort();
    const { outcomes } = await run({ fake, helper, engine: scriptedEngine(), seeded, signal: cancel.signal });

    expect(outcomes).toEqual([{ state: 'cancelled' }]);
    expect(fake.containers.get('c1')?.State).toBe('running');
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('rolled_back');
    expect(intent?.fenceState).toBe('released');
  });

  it('logs a stop nobody asked for, such as a helper signalled from outside', async () => {
    const { fake, seeded } = twoContainers();
    const engine = scriptedEngine({
      createPoint: async () => ({ ok: false as const, errorClass: 'interrupted' as const }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'cancelled' }]);
    expect(warn.mock.calls.map((call) => format(...call)).some((line) =>
      line.includes('ended cancelled while taking the pre-restore point'))).toBe(true);
  });

  it('still ends pre_restore_failed when the capture really failed', async () => {
    const { fake, seeded } = twoContainers();
    const engine = scriptedEngine({
      createPoint: async () => ({ ok: false as const, errorClass: 'node_error' as const }),
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });
    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'pre_restore_failed' }]);
  });
});

describe('a failed overwrite says why in the node log', () => {
  // The API answers a class only and the helper container is removed when it
  // exits, so the log is the only place an operator can learn the cause.
  function seededOne() {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    return { fake, seeded };
  }

  async function warnings(work: () => Promise<unknown>): Promise<string[]> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await work();
    return warn.mock.calls.map((call) => format(...call));
  }

  it('names the restore, its class and where it stopped when the copy inside the volume fails', async () => {
    const { fake, seeded } = seededOne();
    const engine = scriptedEngine({
      restores: [
        async () => ({ ok: true as const, evidence: { filesRestored: 4, bytesRestored: 400, verified: true } }),
        async () => ({ ok: false as const, errorClass: 'node_error' as const }),
      ],
    });
    const lines = await warnings(() => run({ fake, helper: successHelper(), engine, seeded }));
    const line = lines.find((text) => text.includes('Overwrite') && text.includes(seeded.intentId));
    expect(line).toBeDefined();
    expect(line).toContain('failed with node_error');
    expect(line).toContain('while copying the point into the volume');
    expect(line).toContain('intent now rolled_back');
  });

  it('names a pre-restore capture that failed', async () => {
    const { fake, seeded } = seededOne();
    const engine = scriptedEngine({
      createPoint: async () => ({ ok: false as const, errorClass: 'node_error' as const }),
    });
    const lines = await warnings(() => run({ fake, helper: successHelper(), engine, seeded }));
    expect(lines.some((text) => text.includes('pre-restore point') && text.includes('node_error'))).toBe(true);
    expect(lines.some((text) => text.includes('failed with pre_restore_failed'))).toBe(true);
  });

  it('names a staging failure, which settles before anything is fenced', async () => {
    const { fake, seeded } = seededOne();
    const engine = scriptedEngine({
      restores: [async () => ({ ok: false as const, errorClass: 'repository_unavailable' as const })],
    });
    const lines = await warnings(() => run({ fake, helper: successHelper(), engine, seeded }));
    expect(lines.some((text) => text.includes(seeded.intentId) && text.includes('failed with repository_unavailable'))).toBe(true);
  });

  it('names a swap that left the volume unproven, and a clean-up that failed', async () => {
    const unknown = seededOne();
    const unknownLines = await warnings(() => run({
      fake: unknown.fake,
      helper: scriptedHelper({
        swapAnswers: [
          { action: 'prepare', exitCode: 0, status: 'planned' },
          { action: 'commit', exitCode: 1 },
          { action: 'status', exitCode: 0, status: 'inconsistent' },
        ],
      }),
      engine: scriptedEngine(),
      seeded: unknown.seeded,
    }));
    expect(unknownLines.some((text) => text.includes('ended completion_unknown'))).toBe(true);

    const cleanup = seededOne();
    const cleanupLines = await warnings(() => run({
      fake: cleanup.fake,
      helper: scriptedHelper({
        swapAnswers: [
          { action: 'prepare', exitCode: 0, status: 'planned' },
          { action: 'commit', exitCode: 0, status: 'swapped' },
          { action: 'status', exitCode: 0, status: 'swapped' },
          { action: 'cleanup', exitCode: 1, status: 'inconsistent' },
        ],
      }),
      engine: scriptedEngine(),
      seeded: cleanup.seeded,
    }));
    expect(cleanupLines.some((text) => text.includes('ended partial with cleanup_failed'))).toBe(true);
  });

  it('names the step for a failure that is not a helper failure, such as a container that appeared', async () => {
    const { fake, seeded } = seededOne();
    // A second container mounts the volume once the fence is about to be applied.
    fake.containers.set('c2', container({ Id: 'c2', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] }));
    const lines = await warnings(() => run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded }));
    expect(lines.some((text) => text.includes('failed with dependents_changed while fencing the workloads'))).toBe(true);
  });

  it('keeps the cause of an engine call that threw, which the class alone loses', async () => {
    const { fake, seeded } = seededOne();
    const engine = scriptedEngine({
      restores: [
        async () => ({ ok: true as const, evidence: { filesRestored: 4, bytesRestored: 400, verified: true } }),
        async () => { throw new Error('helper image is missing'); },
      ],
    });
    const lines = await warnings(() => run({ fake, helper: successHelper(), engine, seeded }));
    expect(lines.some((text) => text.includes('Copying the point into the volume') && text.includes('helper image is missing'))).toBe(true);
  });

  it('still settles the operation when writing the line fails', async () => {
    const { fake, seeded } = seededOne();
    const engine = scriptedEngine({
      createPoint: async () => ({ ok: false as const, errorClass: 'node_error' as const }),
    });
    const seen: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const line = format(...(args as [string, ...unknown[]]));
      seen.push(line);
      // The line that ends the overwrite cannot be written; every other one can.
      if (line.startsWith('[Recovery] Overwrite ')) throw new Error('log sink is closed');
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'pre_restore_failed' }]);
    expect(seen.some((line) => line.includes('Could not log the end of overwrite'))).toBe(true);
  });

  it('logs nothing when the overwrite succeeds', async () => {
    const { fake, seeded } = seededOne();
    const lines = await warnings(() => run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded }));
    expect(lines.filter((text) => text.includes('Overwrite'))).toEqual([]);
  });
});

describe('the staging target', () => {
  it('carries the intent label, so a wrong volume is never a target Sencho removes', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });
    const staging = fake.volumes.get(overwrite.stagingVolumeFor(seeded.intentId));
    // The pipeline removed it after verification; the intent record keeps its name.
    expect(staging).toBeUndefined();
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.stagingVolume)
      .toBe(overwrite.stagingVolumeFor(seeded.intentId));
    expect(intentLabels(seeded.intentId)[HELPER_LABEL_RESTORE_INTENT]).toBe(seeded.intentId);
  });
});

/** Clear every recovery table, so a loop can build more than one scenario. */
function resetTables(): void {
  const db = recoveryDbModule.recoveryDb();
  for (const table of ['recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_locks',
    'recovery_operations', 'recovery_point_verifications', 'recovery_point_holds', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM system_state WHERE key = 'recovery_active_repository_id'").run();
}

/** Walk an intent to one phase through the real table, from `recorded`. */
function walkTo(intentId: string, phase: import('../services/recovery/types').RestoreIntentPhase): void {
  const store = intents.RestoreIntentStore.getInstance();
  const path = ['staging', 'staged_verified', 'fenced', 'protecting', 'materializing', 'swapping', 'swapped'] as const;
  for (const step of path) {
    if (store.get(intentId)?.phase === phase) return;
    store.advance(intentId, step);
  }
}

describe('reconciling an overwrite a previous process left open', () => {
  async function reconcile(seeded: Seeded, fake: ReturnType<typeof fakeDocker>, helper: ReturnType<typeof scriptedHelper>) {
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    if (!intent) throw new Error('no intent');
    return overwrite.reconcileOverwriteIntent({
      nodeId: 1,
      nodeName: 'node-one',
      transport: 'local',
      docker: fake.docker,
      runner: () => helper.helper,
      points: points.RecoveryPointStore.getInstance(),
      repositories: repositories.RecoveryRepositoryStore.getInstance(),
      intents: intents.RestoreIntentStore.getInstance(),
      fence: fence.RestoreFenceStore.getInstance(),
      ownerNodeKey: ENGINE,
      knownStackNames: [],
      actor: 'system',
      authorizeStack: () => true,
      authorizeGlobal: () => true,
    }, intent);
  }

  it('removes the staging volume and rolls back before the fence, touching no workload', async () => {
    for (const phase of ['recorded', 'staging', 'staged_verified'] as const) {
      resetTables();
      const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
      const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
      const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
      const helper = successHelper();
      if (phase !== 'recorded') walkTo(seeded.intentId, phase);
      expect(await reconcile(seeded, fake, helper)).toBe('rolled_back');
      expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
      expect(fake.calls.filter((call) => call.startsWith('update:') || call.startsWith('stop:'))).toEqual([]);
      expect(fake.volumes.has(overwrite.stagingVolumeFor(seeded.intentId))).toBe(false);
    }
  });

  it('rolls a fenced overwrite back, releasing the fence and restarting what was running', async () => {
    for (const phase of ['fenced', 'protecting', 'materializing'] as const) {
      resetTables();
      const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
      const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
      const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
      const helper = successHelper();
      walkTo(seeded.intentId, phase);
      fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
      fake.containers.get('c1')!.State = 'exited';
      fake.containers.get('c1')!.HostConfig.RestartPolicy = { Name: 'no' };

      expect(await reconcile(seeded, fake, helper)).toBe('rolled_back');
      const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
      expect(intent?.phase).toBe('rolled_back');
      expect(intent?.fenceState).toBe('released');
      expect(fake.containers.get('c1')?.State).toBe('running');
      expect(fake.containers.get('c1')?.HostConfig.RestartPolicy.Name).toBe('always');
    }
  });

  it('rolls forward when the journal proves the swap committed', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = scriptedHelper({
      swapAnswers: [
        { action: 'status', exitCode: 0, status: 'swapped' },
        { action: 'commit', exitCode: 0, status: 'swapped' },
        { action: 'cleanup', exitCode: 0, status: 'cleaned' },
      ],
    });
    walkTo(seeded.intentId, 'swapping');
    // The fence was live when the process died.
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    fake.containers.get('c1')!.State = 'exited';
    fake.containers.get('c1')!.HostConfig.RestartPolicy = { Name: 'no' };

    expect(await reconcile(seeded, fake, helper)).toBe('committed');
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('committed');
    expect(intent?.fenceState).toBe('released');
    expect(fake.containers.get('c1')?.State).toBe('running');
    // Roll forward never undoes the swap.
    expect(helper.runs.map((entry) => entry.cmd[2])).not.toContain('rollback');
  });

  it('rolls back when the journal says the swap did not commit', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = scriptedHelper({
      swapAnswers: [
        { action: 'status', exitCode: 0, status: 'moving_originals' },
        { action: 'rollback', exitCode: 0, status: 'rolled_back' },
      ],
    });
    walkTo(seeded.intentId, 'swapping');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    fake.containers.get('c1')!.State = 'exited';
    fake.containers.get('c1')!.HostConfig.RestartPolicy = { Name: 'no' };
    expect(await reconcile(seeded, fake, helper)).toBe('rolled_back');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
    // The originals are proven back in place, so the workload may run again.
    expect(fake.containers.get('c1')?.State).toBe('running');
  });

  it('keeps the fence held and reports unknown when the journal is inconsistent', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = scriptedHelper({ swapAnswers: [{ action: 'status', exitCode: 0, status: 'inconsistent' }] });
    walkTo(seeded.intentId, 'swapping');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    fake.containers.get('c1')!.State = 'exited';

    expect(await reconcile(seeded, fake, helper)).toBe('unknown');
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('completion_unknown');
    expect(intent?.fenceState).not.toBe('released');
    expect(fake.calls).not.toContain('start:c1');
  });

  it('is idempotent: a second boot pass finds nothing left to settle', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    walkTo(seeded.intentId, 'staged_verified');
    const deps = {
      nodeId: 1,
      nodeName: 'node-one',
      transport: 'local' as const,
      docker: fake.docker,
      runner: () => successHelper().helper,
      points: points.RecoveryPointStore.getInstance(),
      repositories: repositories.RecoveryRepositoryStore.getInstance(),
      intents: intents.RestoreIntentStore.getInstance(),
      fence: fence.RestoreFenceStore.getInstance(),
      ownerNodeKey: ENGINE,
      knownStackNames: [],
      actor: 'system',
      authorizeStack: () => true,
      authorizeGlobal: () => true,
    };
    expect(await overwrite.reconcileOverwriteIntentsAtStartup(deps)).toEqual({ rolledBack: 1, committed: 0, unknown: 0 });
    const after = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(await overwrite.reconcileOverwriteIntentsAtStartup(deps)).toEqual({ rolledBack: 0, committed: 0, unknown: 0 });
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)).toEqual(after);
  });
});

describe('the operator resolve route', () => {
  function depsFor(fake: ReturnType<typeof fakeDocker>, helper: ReturnType<typeof scriptedHelper>) {
    return {
      nodeId: 1,
      nodeName: 'node-one',
      transport: 'local' as const,
      docker: fake.docker,
      runner: () => helper.helper,
      points: points.RecoveryPointStore.getInstance(),
      repositories: repositories.RecoveryRepositoryStore.getInstance(),
      intents: intents.RestoreIntentStore.getInstance(),
      fence: fence.RestoreFenceStore.getInstance(),
      ownerNodeKey: ENGINE,
      knownStackNames: [],
      actor: 'admin',
      authorizeStack: () => true,
      authorizeGlobal: () => true,
    };
  }

  it('retries a restore whose blocker is gone, and settles it forward', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = scriptedHelper({
      swapAnswers: [
        { action: 'status', exitCode: 0, status: 'swapped' },
        { action: 'commit', exitCode: 0, status: 'swapped' },
        { action: 'cleanup', exitCode: 0, status: 'cleaned' },
      ],
    });
    walkTo(seeded.intentId, 'swapping');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'completion_unknown', { outcomeClass: 'identity_unknown' });
    fake.containers.get('c1')!.State = 'exited';
    fake.containers.get('c1')!.HostConfig.RestartPolicy = { Name: 'no' };

    const resolved = await overwrite.resolveOverwriteIntent(depsFor(fake, helper), {
      intentId: seeded.intentId,
      action: 'retry',
    });
    expect(resolved.outcome).toBe('committed');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('committed');
    expect(fake.containers.get('c1')?.State).toBe('running');
  });

  it('releases the fence on acceptance and starts nothing', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = successHelper();
    walkTo(seeded.intentId, 'materializing');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'completion_unknown', { outcomeClass: 'fence_unavailable' });
    fake.containers.get('c1')!.State = 'exited';
    fake.containers.get('c1')!.HostConfig.RestartPolicy = { Name: 'no' };

    const resolved = await overwrite.resolveOverwriteIntent(depsFor(fake, helper), {
      intentId: seeded.intentId,
      action: 'release_fence',
    });
    expect(resolved.outcome).toBe('fence_released');
    // The policy comes back; the workload does not, because nobody proved the data.
    expect(fake.containers.get('c1')?.HostConfig.RestartPolicy.Name).toBe('always');
    expect(fake.containers.get('c1')?.State).toBe('exited');
    expect(fake.calls).not.toContain('start:c1');
  });

  it('refuses to resolve an intent that already settled', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const helper = successHelper();
    walkTo(seeded.intentId, 'staged_verified');
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'rolled_back');
    await expect(overwrite.resolveOverwriteIntent(depsFor(fake, helper), {
      intentId: seeded.intentId,
      action: 'release_fence',
    })).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});

function pipelineDeps(fake: ReturnType<typeof fakeDocker>, helper: ReturnType<typeof scriptedHelper>) {
  return {
    nodeId: 1,
    nodeName: 'node-one',
    transport: 'local' as const,
    docker: fake.docker,
    runner: () => helper.helper,
    points: points.RecoveryPointStore.getInstance(),
    repositories: repositories.RecoveryRepositoryStore.getInstance(),
    intents: intents.RestoreIntentStore.getInstance(),
    fence: fence.RestoreFenceStore.getInstance(),
    ownerNodeKey: ENGINE,
    knownStackNames: [],
    actor: 'admin',
    authorizeStack: () => true,
    authorizeGlobal: () => true,
  };
}

/** The storage's recorded dependent stacks, as a later observation would leave them. */
function observeDependents(createdAt: string, stackNames: string[]): void {
  identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE,
    kind: 'named_volume',
    locator: VOLUME,
    generationToken: `${createdAt}|63:42`,
    dependents: stackNames.map((stackName) => ({ stackName, serviceName: null })),
  });
}

function recordDependentStacks(intentId: string, stackNames: string[]): void {
  recoveryDbModule.recoveryDb()
    .prepare('UPDATE recovery_restore_intents SET dependent_stacks_json = ? WHERE id = ?')
    .run(JSON.stringify(stackNames), intentId);
}

describe('a stack that declares the volume without a container', () => {
  it('does not abort the overwrite: admission recorded it, and no fence member is needed', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const createdAt = fake.volumes.get(VOLUME)?.createdAt ?? '';
    const seeded = seed({ createdAt, members: [member] });
    // `stack-two` was taken down: its model still declares the volume.
    observeDependents(createdAt, [STACK, 'stack-two']);
    recordDependentStacks(seeded.intentId, [STACK, 'stack-two']);

    const { outcomes } = await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });

    expect(outcomes).toEqual([{ state: 'succeeded' }]);
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('committed');
    expect(intent?.dependentStacks).toEqual([STACK, 'stack-two']);
    expect(fake.containers.get('c1')?.State).toBe('running');
  });

  it('still aborts before the fence when a stack that admission never saw declares the volume', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const createdAt = fake.volumes.get(VOLUME)?.createdAt ?? '';
    const seeded = seed({ createdAt, members: [member] });
    recordDependentStacks(seeded.intentId, [STACK]);
    observeDependents(createdAt, [STACK, 'stack-late']);

    const { outcomes } = await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'dependents_changed' }]);
    expect(fake.calls.some((call) => call.startsWith('stop:') || call.startsWith('update:'))).toBe(false);
  });

  it('re-checks the same rule before the commit, and rolls back when a stack appeared meanwhile', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const createdAt = fake.volumes.get(VOLUME)?.createdAt ?? '';
    const seeded = seed({ createdAt, members: [member] });
    recordDependentStacks(seeded.intentId, [STACK, 'stack-two']);
    observeDependents(createdAt, [STACK, 'stack-two']);
    // The pre-restore point is taken after the fence and before the swap, so a
    // stack that starts to declare the volume then is seen only by the second check.
    const engine = scriptedEngine({
      createPoint: async () => {
        observeDependents(createdAt, [STACK, 'stack-two', 'stack-late']);
        return { ok: true as const, evidence: { ...DEFAULT_CAPTURE } };
      },
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'dependents_changed' }]);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
    expect(fake.containers.get('c1')?.State).toBe('running');
  });
});

describe('a staging volume that cannot be removed', () => {
  const stagingName = (intentId: string) => overwrite.stagingVolumeFor(intentId);

  function refuseStagingRemoval(fake: ReturnType<typeof fakeDocker>, refuse: { value: boolean }): void {
    fake.failOn = (call) => (refuse.value && call.startsWith('removeVolume:sencho-recovery-stage-')
      ? new Error('volume is busy')
      : null);
  }

  it('keeps a failed stage open, with its holds, instead of settling it rolled back', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const refuse = { value: true };
    refuseStagingRemoval(fake, refuse);
    const engine = scriptedEngine({
      restores: [async () => ({ ok: false as const, errorClass: 'integrity_mismatch' as const })],
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'integrity_mismatch' }]);
    const open = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(open?.phase).toBe('staging');
    expect(open?.outcomeClass).toBe('cleanup_failed');
    expect(fake.volumes.has(stagingName(seeded.intentId))).toBe(true);
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);
    expect(intents.RestoreIntentStore.getInstance().listUnsettled('staged_overwrite').map((row) => row.id))
      .toContain(seeded.intentId);
    // The target stays reserved while its staging volume is owed a removal.
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBe(seeded.intentId);

    // The next boot pass removes it and settles the intent for real.
    refuse.value = false;
    const reconciled = await overwrite.reconcileOverwriteIntentsAtStartup(pipelineDeps(fake, successHelper()));
    expect(reconciled.rolledBack).toBe(1);
    expect(fake.volumes.has(stagingName(seeded.intentId))).toBe(false);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toEqual([]);
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBeNull();
  });

  it('keeps an unverified stage open the same way', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    refuseStagingRemoval(fake, { value: true });
    const engine = scriptedEngine({
      restores: [async () => ({
        ok: true as const,
        evidence: { filesRestored: 1, bytesRestored: 1, verified: false },
      })],
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'attributes_not_restored' }]);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('staging');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.outcomeClass).toBe('cleanup_failed');
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBe(seeded.intentId);
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);
  });

  it('ends a verified stage whose copy is in use as cleanup_failed, stops nothing, and settles on retry', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    // Something mounts the staging volume once it exists.
    const engine = scriptedEngine({
      restores: [async () => {
        fake.containers.set('user', container({
          Id: 'user', State: 'running', Mounts: [{ Type: 'volume', Name: stagingName(seeded.intentId) }],
        }));
        return { ok: true as const, evidence: { filesRestored: 4, bytesRestored: 400, verified: true } };
      }],
    });
    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'cleanup_failed' }]);
    expect(fake.calls.some((call) => call.startsWith('stop:') || call.startsWith('update:'))).toBe(false);
    const open = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(open?.phase).toBe('staged_verified');
    expect(open?.outcomeClass).toBe('cleanup_failed');
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);
    expect(intents.RestoreIntentStore.getInstance().listUnsettled('staged_overwrite')).toHaveLength(1);

    // While it is in use a retry changes nothing; once it is free, the retry settles it.
    const stillBusy = await overwrite.resolveOverwriteIntent(
      pipelineDeps(fake, successHelper()),
      { intentId: seeded.intentId, action: 'retry' },
    );
    expect(stillBusy.outcome).toBe('unknown');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('staged_verified');
    fake.containers.delete('user');
    const settled = await overwrite.resolveOverwriteIntent(
      pipelineDeps(fake, successHelper()),
      { intentId: seeded.intentId, action: 'retry' },
    );
    expect(settled.outcome).toBe('rolled_back');
    expect(fake.volumes.has(stagingName(seeded.intentId))).toBe(false);
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toEqual([]);
  });

  it('does not settle a rollback while the staging volume is still there', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    fake.volumes.set(stagingName(seeded.intentId), {
      labels: intentLabels(seeded.intentId), createdAt: new Date().toISOString(),
    });
    walkTo(seeded.intentId, 'staged_verified');
    const refuse = { value: true };
    refuseStagingRemoval(fake, refuse);

    const outcome = await overwrite.rollbackIntent(pipelineDeps(fake, successHelper()), seeded.intentId);
    expect(outcome).toBe('cleanup_pending');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('staged_verified');
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);

    refuse.value = false;
    expect(await overwrite.rollbackIntent(pipelineDeps(fake, successHelper()), seeded.intentId)).toBe('rolled_back');
    expect(fake.volumes.has(stagingName(seeded.intentId))).toBe(false);
  });

  it('treats a volume that carries another label as not Sencho\'s to keep the intent for', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    fake.volumes.set(stagingName(seeded.intentId), {
      labels: intentLabels('someone-else'), createdAt: new Date().toISOString(),
    });
    walkTo(seeded.intentId, 'staged_verified');

    expect(await overwrite.rollbackIntent(pipelineDeps(fake, successHelper()), seeded.intentId)).toBe('rolled_back');
    expect(fake.volumes.has(stagingName(seeded.intentId))).toBe(true);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
  });

  it('keeps a reconciled fenced intent open too, after releasing its fence', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    fake.volumes.set(stagingName(seeded.intentId), {
      labels: intentLabels(seeded.intentId), createdAt: new Date().toISOString(),
    });
    walkTo(seeded.intentId, 'protecting');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    fake.containers.get('c1')!.State = 'exited';
    const refuse = { value: true };
    refuseStagingRemoval(fake, refuse);

    const first = await overwrite.reconcileOverwriteIntentsAtStartup(pipelineDeps(fake, successHelper()));
    expect(first.unknown).toBe(1);
    const open = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(open?.phase).toBe('protecting');
    expect(open?.fenceState).toBe('released');
    expect(fake.containers.get('c1')?.State).toBe('running');

    refuse.value = false;
    const second = await overwrite.reconcileOverwriteIntentsAtStartup(pipelineDeps(fake, successHelper()));
    expect(second.rolledBack).toBe(1);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
  });

  it('refuses release_fence on an intent that never fenced anything', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    walkTo(seeded.intentId, 'staged_verified');

    await expect(overwrite.resolveOverwriteIntent(
      pipelineDeps(fake, successHelper()),
      { intentId: seeded.intentId, action: 'release_fence' },
    )).rejects.toMatchObject({ errorClass: 'invalid_request', reason: 'no_fence' });
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('staged_verified');
  });
});

describe('a fence that cannot be released after the data committed', () => {
  /** Fail the release (the second policy update on a container), not the fence itself. */
  function failRelease(fake: ReturnType<typeof fakeDocker>, broken: { value: boolean }): void {
    let updates = 0;
    fake.failOn = (call) => {
      if (call !== 'update:c1') return null;
      updates += 1;
      return broken.value && updates > 1 ? new Error('daemon refused') : null;
    };
  }

  it('records fence_unavailable on the committed intent and keeps the volume reserved', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const broken = { value: true };
    failRelease(fake, broken);

    const { outcomes } = await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });

    expect(outcomes).toEqual([{ state: 'partial', errorClass: 'fence_unavailable' }]);
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('committed');
    expect(intent?.outcomeClass).toBe('fence_unavailable');
    expect(intent?.fenceState).toBe('release_failed');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(true);
    // A second overwrite would record the pinned `no` policy as the original.
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBe(seeded.intentId);

    // The next boot releases the fence, and the intent stops reporting the failure.
    broken.value = false;
    await overwrite.reconcileOverwriteIntentsAtStartup(pipelineDeps(fake, successHelper()));
    const settled = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(settled?.fenceState).toBe('released');
    expect(settled?.outcomeClass).toBeNull();
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBeNull();
    expect(fake.containers.get('c1')?.HostConfig.RestartPolicy).toEqual({ Name: 'always' });
  });

  it('keeps a rolled back intent reserved while its fence is held, and clears it on retry', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const broken = { value: true };
    failRelease(fake, broken);
    const engine = scriptedEngine({
      createPoint: async () => ({ ok: false as const, errorClass: 'node_error' as const }),
    });

    const { outcomes } = await run({ fake, helper: successHelper(), engine, seeded });

    expect(outcomes).toEqual([{ state: 'completion_unknown' }]);
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('rolled_back');
    expect(intent?.outcomeClass).toBe('fence_unavailable');
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBe(seeded.intentId);

    broken.value = false;
    const resolved = await overwrite.resolveOverwriteIntent(
      pipelineDeps(fake, successHelper()),
      { intentId: seeded.intentId, action: 'retry' },
    );
    expect(resolved.outcome).toBe('rolled_back');
    const settled = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(settled?.outcomeClass).toBeNull();
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBeNull();
  });
});

describe('a container start that is in flight when the fence goes up', () => {
  it('is waited for, so the observation records it running and the release restarts it', async () => {
    const member = container({ Id: 'c1', State: 'exited', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const registry = (await import('../services/NodeRegistry')).NodeRegistry.getInstance();
    vi.spyOn(registry, 'getDocker').mockReturnValue(fake.docker);

    // The start passed its check while no fence existed and has not reached the
    // daemon yet.
    const hold = gate();
    const atDaemon = gate();
    delayContainerCall(fake, 'start', 'c1', hold.promise, atDaemon.open);
    const start = DockerController.getInstance(1).startContainer('c1');
    await atDaemon.promise;

    const finished = run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });
    await vi.waitFor(() => {
      expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.fenceState).toBe('held');
    });
    // The fence is held and the pipeline is waiting: nothing has been stopped.
    expect(fake.calls).not.toContain('stop:c1');
    hold.open();
    await start;
    const { outcomes } = await finished;

    expect(outcomes).toEqual([{ state: 'succeeded' }]);
    expect(fake.calls.indexOf('start:c1')).toBeLessThan(fake.calls.indexOf('stop:c1'));
    // It was running when the fence observed it, so the release brought it back.
    expect(fake.containers.get('c1')?.State).toBe('running');
  });
});

describe('the fence window between the first recheck and the stop', () => {
  /**
   * Hold a start of an unrelated container in flight, so the pipeline waits
   * after it has recorded the fence, and hand back what the case needs to act
   * during that wait.
   */
  async function holdAStartInFlight(fake: ReturnType<typeof fakeDocker>) {
    const registry = (await import('../services/NodeRegistry')).NodeRegistry.getInstance();
    vi.spyOn(registry, 'getDocker').mockReturnValue(fake.docker);
    const hold = gate();
    const atDaemon = gate();
    delayContainerCall(fake, 'start', 'x', hold.promise, atDaemon.open);
    const start = DockerController.getInstance(1).startContainer('x');
    await atDaemon.promise;
    return { hold, start };
  }

  async function untilFenceHeld(intentId: string): Promise<void> {
    await vi.waitFor(() => {
      expect(intents.RestoreIntentStore.getInstance().get(intentId)?.fenceState).toBe('held');
    });
  }

  it('aborts without touching a member the operator stopped, when a new container appears meanwhile', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const other = container({ Id: 'x', State: 'exited' });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member, other] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const { hold, start } = await holdAStartInFlight(fake);

    const finished = run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });
    await untilFenceHeld(seeded.intentId);
    // The operator stops c1 and a second container mounts the volume.
    fake.containers.get('c1')!.State = 'exited';
    fake.containers.set('c2', container({ Id: 'c2', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] }));
    hold.open();
    await start;
    const { outcomes } = await finished;

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'dependents_changed' }]);
    // Nothing was applied, so nothing is released: c1 stays as the operator left it.
    expect(fake.calls.filter((call) => call.endsWith(':c1'))).toEqual([]);
    expect(fake.containers.get('c1')?.State).toBe('exited');
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('rolled_back');
    expect(intent?.fenceState).toBe('none');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(false);
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBeNull();
  });

  it('settles cleanly, with no fence left, when a member is removed meanwhile', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const other = container({ Id: 'x', State: 'exited' });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member, other] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const { hold, start } = await holdAStartInFlight(fake);

    const finished = run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });
    await untilFenceHeld(seeded.intentId);
    // A redeploy replaces c1 with a container of another id.
    fake.containers.delete('c1');
    fake.containers.set('c1-new', container({ Id: 'c1-new', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] }));
    hold.open();
    await start;
    const { outcomes } = await finished;

    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'dependents_changed' }]);
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('rolled_back');
    expect(intent?.fenceState).toBe('none');
    expect(intent?.outcomeClass).toBeNull();
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBeNull();
  });

  it('refuses the fence, before stopping anything, when a start does not answer in time', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const other = container({ Id: 'x', State: 'exited' });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member, other] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const { hold, start } = await holdAStartInFlight(fake);
    fence.setStartDrainTimeoutForTests(30);
    try {
      const { outcomes } = await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });
      expect(outcomes).toEqual([{ state: 'failed', errorClass: 'fence_unavailable' }]);
    } finally {
      fence.setStartDrainTimeoutForTests(120_000);
      hold.open();
      await start;
    }
    expect(fake.calls.filter((call) => call.endsWith(':c1'))).toEqual([]);
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('rolled_back');
    expect(intent?.fenceState).toBe('none');
  });

  it('refuses at once, stopping nothing, when the only start in flight has hung', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const other = container({ Id: 'x', State: 'exited' });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member, other] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    const { hold, start } = await holdAStartInFlight(fake);
    // The start is older than the hung threshold, and the cap is far longer than
    // the test: only an immediate refusal finishes inside it.
    fence.setStartDrainTimeoutForTests(60_000, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      const began = Date.now();
      const { outcomes } = await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });
      expect(Date.now() - began).toBeLessThan(10_000);
      expect(outcomes).toEqual([{ state: 'failed', errorClass: 'fence_unavailable' }]);
    } finally {
      fence.setStartDrainTimeoutForTests(120_000);
      hold.open();
      await start;
    }
    expect(fake.calls.filter((call) => call.endsWith(':c1'))).toEqual([]);
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('rolled_back');
    expect(intent?.fenceState).toBe('none');
  });
});

describe('the staging volume around the other phases', () => {
  const stagingName = (intentId: string) => overwrite.stagingVolumeFor(intentId);

  it('settles a rollback from the swap phases even if the staging volume is somehow still there', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    fake.volumes.set(stagingName(seeded.intentId), {
      labels: intentLabels(seeded.intentId), createdAt: new Date().toISOString(),
    });
    walkTo(seeded.intentId, 'swapping');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    fake.failOn = (call) => (call.startsWith('removeVolume:') ? new Error('volume is busy') : null);

    // The swap journal is gone after the rollback, so an open intent could never
    // be read again: it settles, and the leftover is logged.
    const outcome = await overwrite.rollbackIntent(pipelineDeps(fake, successHelper()), seeded.intentId);
    expect(outcome).toBe('rolled_back');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
  });

  it('answers unknown, and stays open, when the staging volume and the fence release both fail', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    fake.volumes.set(stagingName(seeded.intentId), {
      labels: intentLabels(seeded.intentId), createdAt: new Date().toISOString(),
    });
    walkTo(seeded.intentId, 'staged_verified');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    fake.failOn = (call) => (call.startsWith('removeVolume:') || call === 'update:c1' ? new Error('daemon refused') : null);

    const outcome = await overwrite.rollbackIntent(pipelineDeps(fake, successHelper()), seeded.intentId);
    expect(outcome).toBe('unknown');
    const open = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(open?.phase).toBe('staged_verified');
    expect(open?.fenceState).toBe('release_failed');
  });

  it('removes a staging volume that exists when its creation reported a failure', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    // Docker made the volume and the answer was lost.
    fake.volumes.set(stagingName(seeded.intentId), {
      labels: intentLabels(seeded.intentId), createdAt: new Date().toISOString(),
    });
    fake.failOn = (call) => (call.startsWith('createVolume:')
      ? Object.assign(new Error('socket hang up'), { statusCode: 500 })
      : null);

    const { outcomes } = await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });
    expect(outcomes).toEqual([{ state: 'failed', errorClass: 'node_error' }]);
    expect(fake.volumes.has(stagingName(seeded.intentId))).toBe(false);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
  });

  it('keeps that intent open when the volume it made cannot be removed', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    fake.volumes.set(stagingName(seeded.intentId), {
      labels: intentLabels(seeded.intentId), createdAt: new Date().toISOString(),
    });
    fake.failOn = (call) => {
      if (call.startsWith('createVolume:')) return Object.assign(new Error('socket hang up'), { statusCode: 500 });
      return call.startsWith('removeVolume:') ? new Error('volume is busy') : null;
    };

    await run({ fake, helper: successHelper(), engine: scriptedEngine(), seeded });
    const open = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(open?.phase).toBe('staging');
    expect(open?.outcomeClass).toBe('cleanup_failed');
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);
  });

  it('refuses release_fence on a fenced intent whose fence was never held', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    // A crash between recording the phase and holding the fence.
    walkTo(seeded.intentId, 'fenced');
    await expect(overwrite.resolveOverwriteIntent(
      pipelineDeps(fake, successHelper()),
      { intentId: seeded.intentId, action: 'release_fence' },
    )).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('fenced');
  });
});

describe('startup reconciliation and a fence it cannot release', () => {
  it('settles a proven rollback with fence_unavailable instead of calling the data unknown', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    walkTo(seeded.intentId, 'protecting');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    fake.containers.get('c1')!.State = 'exited';
    const broken = { value: true };
    fake.failOn = (call) => (broken.value && call === 'update:c1' ? new Error('daemon refused') : null);

    await overwrite.reconcileOverwriteIntentsAtStartup(pipelineDeps(fake, successHelper()));
    const first = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(first?.phase).toBe('rolled_back');
    expect(first?.outcomeClass).toBe('fence_unavailable');
    expect(first?.fenceState).toBe('release_failed');
    // Reserved while its fence is held, so no second overwrite records the pinned policy.
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBe(seeded.intentId);

    broken.value = false;
    await overwrite.reconcileOverwriteIntentsAtStartup(pipelineDeps(fake, successHelper()));
    const second = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(second?.phase).toBe('rolled_back');
    expect(second?.outcomeClass).toBeNull();
    expect(second?.fenceState).toBe('released');
    expect(fake.containers.get('c1')?.State).toBe('running');
  });

  it('does not restart the workloads of an intent that is still unproven', async () => {
    const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '', members: [member] });
    walkTo(seeded.intentId, 'swapping');
    fence.RestoreFenceStore.getInstance().setFenceState(seeded.intentId, 'held');
    fake.containers.get('c1')!.State = 'exited';
    const helper = scriptedHelper({ swapAnswers: [{ action: 'status', exitCode: 0, status: 'inconsistent' }] });

    const result = await overwrite.reconcileOverwriteIntentsAtStartup(pipelineDeps(fake, helper));
    expect(result.unknown).toBe(1);
    // The journal could not be proven, so the fence stays held until an operator decides.
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('completion_unknown');
    expect(intent?.fenceState).toBe('held');
    expect(fake.calls).not.toContain('start:c1');
    expect(fake.containers.get('c1')?.State).toBe('exited');
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);
  });
});

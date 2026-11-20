/**
 * Reconciliation, rollback and resolve of an overwrite of a host directory.
 *
 * Every step that touches the directory proves it again, and the proof must
 * find the directory the operator confirmed: the same device and inode on both
 * sides, and the generation token the intent recorded. A proof that cannot run,
 * a different directory at the path, or the same path recreated (an empty mount
 * point after a reboot, say) never moves data: the fence stays held and the
 * restore stays unknown. These cases drive each phase group through a fake
 * helper whose probe reports a real directory's identity.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { container, fakeDocker } from './__helpers__/overwriteFixture';
import type { RecoveryHelperRunner } from '../services/recovery/restic/helperRunner';

let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let identityStore: typeof import('../services/recovery/storageIdentity');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let intents: typeof import('../services/recovery/restoreIntents');
let fence: typeof import('../services/recovery/restoreFence');
let overwrite: typeof import('../services/recovery/overwriteRestore');
let fsRoots: typeof import('../services/recovery/fsRoots');
let hostRoots: typeof import('../services/recovery/hostRoots');
let DockerController: typeof import('../services/DockerController').default;
let SelfIdentityService: typeof import('../services/SelfIdentityService').default;

let tmpDir: string;
let scratch: string;
const ENGINE = 'docker-engine:fs-reconcile';
const BTIME = '1700000000.000000001';
const PHASE_PATH = ['staging', 'staged_verified', 'fenced', 'protecting', 'materializing', 'swapping', 'swapped'] as const;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-reconcile-')));
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  identityStore = await import('../services/recovery/storageIdentity');
  repositories = await import('../services/recovery/repositories');
  points = await import('../services/recovery/recoveryPoints');
  intents = await import('../services/recovery/restoreIntents');
  fence = await import('../services/recovery/restoreFence');
  overwrite = await import('../services/recovery/overwriteRestore');
  fsRoots = await import('../services/recovery/fsRoots');
  hostRoots = await import('../services/recovery/hostRoots');
  DockerController = (await import('../services/DockerController')).default;
  SelfIdentityService = (await import('../services/SelfIdentityService')).default;
});

afterAll(async () => {
  fs.rmSync(scratch, { recursive: true, force: true });
  await cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const db = recoveryDbModule.recoveryDb();
  for (const table of ['recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_locks',
    'recovery_operations', 'recovery_point_verifications', 'recovery_point_holds', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  vi.restoreAllMocks();
  vi.spyOn(DockerController, 'resolveProjectNameMap').mockResolvedValue(new Map());
  vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
});

interface Run {
  profile: string;
  cmd: readonly string[];
  target: unknown;
}

/**
 * A helper whose probe reports the real identity of `daemonSees` (or fails), and
 * whose swap steps answer from `swap`. Every run is recorded with its target.
 */
function helper(options: { daemonSees: () => string; probeFails?: boolean; btime?: string; swap?: Record<string, string> }) {
  const runs: Run[] = [];
  const runner = {
    run: async (spec: { profile: string; cmd: readonly string[]; mounts: { target?: unknown }; onStdoutLine?: (line: string) => void }) => {
      runs.push({ profile: spec.profile, cmd: spec.cmd, target: spec.mounts.target });
      if (spec.profile === 'probe') {
        if (options.probeFails) return { exitCode: 1, stderrTail: '', aborted: false, killed: false, guardRefused: false };
        const stat = fs.statSync(options.daemonSees(), { bigint: true });
        spec.onStdoutLine?.(JSON.stringify({
          dev: 1, ino: 1, uid: 0, gid: 0, mode: 16877, free: 1,
          dev_s: stat.dev.toString(), ino_s: stat.ino.toString(), btime: options.btime ?? BTIME,
        }));
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false, guardRefused: false };
      }
      if (spec.profile === 'swap') {
        const action = spec.cmd[2] ?? '';
        const status = options.swap?.[action];
        if (status === undefined) return { exitCode: 1, stderrTail: 'unscripted', aborted: false, killed: false, guardRefused: false };
        spec.onStdoutLine?.(JSON.stringify({ status, moved: 0 }));
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false, guardRefused: false };
      }
      return { exitCode: 1, stderrTail: 'unexpected', aborted: false, killed: false, guardRefused: false };
    },
    removeForeignEpochHelpers: async () => 0,
    countForeignEpochHelpers: async () => 0,
  } as unknown as RecoveryHelperRunner;
  return { runner, runs };
}

/** A bind-root overwrite of a real directory, walked to `phase`, with its one member fenced. */
async function seed(phase: typeof PHASE_PATH[number]) {
  const dir = fs.mkdtempSync(path.join(scratch, 'data-'));
  const stat = fs.statSync(dir, { bigint: true });
  const token = fsRoots.fsGenerationToken({ dev: stat.dev.toString(), ino: stat.ino.toString(), btime: BTIME });
  const repository = repositories.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE, kind: 'local_volume', locator: 'repo', failureDomain: 'same_failure_domain',
  });
  repositories.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE, kind: 'bind_root', locator: dir, generationToken: token, dependents: [],
  });
  const point = points.RecoveryPointStore.getInstance().begin({
    kind: 'root', storageId: storage.id, expectedGenerationToken: token, repositoryId: repository.id,
    trigger: 'manual', actor: 'admin', sourceOperationId: 'op-src', sourceNodeKey: ENGINE, engineId: 'restic',
  });
  points.RecoveryPointStore.getInstance().finalize(point.id, {
    status: 'succeeded',
    evidence: { snapshotId: 'snap-1', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'crash_consistent_live' },
  });
  const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'bind', Source: dir, RW: true } as never] });
  const fake = fakeDocker({ volumes: [], containers: [member] });
  const operationId = randomUUID();
  recoveryDbModule.recoveryDb().prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, error_class, process_epoch, created_at, updated_at)
    VALUES (?, ?, 'restore', ?, ?, 'admin', 'local', 'completion_unknown', 'interrupted', 'old', 1, 1)`)
    .run(operationId, randomUUID(), storage.id, point.id);
  const intent = intents.RestoreIntentStore.getInstance().recordOverwrite({
    operationId,
    pointId: point.id,
    targetVolume: fsRoots.fsTargetKey(storage.storageKey),
    targetPaths: { senchoPath: dir, hostPath: dir, aliases: [] },
    actor: 'admin',
    processEpoch: 'old',
    stagingVolume: `sencho-recovery-stage-${randomUUID()}`,
    expectedGenerationToken: token,
  });
  fence.RestoreFenceStore.getInstance().recordMembers(intent.id, [{
    containerId: 'c1', containerName: 'web-app-1', stackName: 'web', projectName: 'web',
    restartPolicy: { Name: 'always' }, wasRunning: true,
  }]);
  const store = intents.RestoreIntentStore.getInstance();
  for (const step of PHASE_PATH) {
    store.advance(intent.id, step);
    if (step === 'fenced') fence.RestoreFenceStore.getInstance().setFenceState(intent.id, 'held');
    if (step === phase) break;
  }
  return { intentId: intent.id, dir, fake };
}

function deps(fake: ReturnType<typeof fakeDocker>, runner: RecoveryHelperRunner) {
  return {
    nodeId: 1, nodeName: 'node-one', transport: 'local', docker: fake.docker, runner: () => runner,
    points: points.RecoveryPointStore.getInstance(),
    repositories: repositories.RecoveryRepositoryStore.getInstance(),
    intents: intents.RestoreIntentStore.getInstance(),
    fence: fence.RestoreFenceStore.getInstance(),
    ownerNodeKey: ENGINE, knownStackNames: [], actor: 'system:restore-reconcile',
    authorizeStack: () => true, authorizeGlobal: () => true,
  };
}

const intentOf = (id: string) => intents.RestoreIntentStore.getInstance().get(id)!;
const swapRuns = (runs: Run[]) => runs.filter((run) => run.profile === 'swap');

describe('reconciling an overwrite of a host directory', () => {
  it('rolls a swapped intent forward through the proven root when the directory is the one confirmed', async () => {
    const { intentId, dir, fake } = await seed('swapped');
    const { runner, runs } = helper({ daemonSees: () => dir, swap: { status: 'swapped', commit: 'swapped', cleanup: 'cleaned' } });
    expect(await overwrite.reconcileOverwriteIntent(deps(fake, runner), intentOf(intentId))).toBe('committed');
    const swaps = swapRuns(runs);
    expect(swaps.length).toBeGreaterThan(0);
    for (const run of swaps) expect(run.target).toBeInstanceOf(hostRoots.ProvenHostRoot);
  });

  it('moves nothing and keeps a swapped intent\'s phase when the proof cannot run', async () => {
    const { intentId, dir, fake } = await seed('swapped');
    const { runner, runs } = helper({ daemonSees: () => dir, probeFails: true, swap: { status: 'swapped' } });
    expect(await overwrite.reconcileOverwriteIntent(deps(fake, runner), intentOf(intentId))).toBe('unknown');
    expect(swapRuns(runs)).toEqual([]);
    expect(intentOf(intentId)).toMatchObject({ phase: 'swapped', fenceState: 'held' });
  });

  for (const phase of ['fenced', 'materializing', 'swapping'] as const) {
    it(`never rolls ${phase} back in a different directory at the same path`, async () => {
      const { intentId, dir, fake } = await seed(phase);
      // Another directory takes the path while Sencho is down. It is made while
      // the original still exists, so it cannot reuse its inode, and then moved in.
      const impostor = fs.mkdtempSync(path.join(scratch, 'impostor-'));
      fs.rmSync(dir, { recursive: true });
      fs.renameSync(impostor, dir);
      // The daemon and Sencho agree on what is at the path: only the recorded token can tell.
      const { runner, runs } = helper({ daemonSees: () => dir, swap: { rollback: 'rolled_back', status: 'planned' } });
      expect(await overwrite.reconcileOverwriteIntent(deps(fake, runner), intentOf(intentId))).toBe('unknown');
      expect(swapRuns(runs)).toEqual([]);
      expect(intentOf(intentId).fenceState).toBe('held');
      expect(fake.calls.filter((call) => call.startsWith('start:'))).toEqual([]);
    });
  }

  it('refuses the same inode with another birth time: a directory made again', async () => {
    const { intentId, dir, fake } = await seed('fenced');
    const { runner, runs } = helper({ daemonSees: () => dir, btime: '1800000000.000000002', swap: { rollback: 'rolled_back' } });
    expect(await overwrite.reconcileOverwriteIntent(deps(fake, runner), intentOf(intentId))).toBe('unknown');
    expect(swapRuns(runs)).toEqual([]);
    expect(intentOf(intentId)).toMatchObject({ phase: 'completion_unknown', fenceState: 'held' });
  });

  it('refuses the live rollback of a directory it cannot prove, and keeps the fence', async () => {
    const { intentId, dir, fake } = await seed('materializing');
    const { runner, runs } = helper({ daemonSees: () => dir, probeFails: true, swap: { rollback: 'rolled_back' } });
    expect(await overwrite.rollbackIntent(deps(fake, runner), intentId)).toBe('unknown');
    expect(swapRuns(runs)).toEqual([]);
    expect(intentOf(intentId)).toMatchObject({ phase: 'completion_unknown', fenceState: 'held' });
  });

  it('accepts the directory on release_fence without reading a journal it cannot prove', async () => {
    const { intentId, dir, fake } = await seed('swapped');
    const { runner, runs } = helper({ daemonSees: () => dir, probeFails: true, swap: { status: 'swapped', cleanup: 'cleaned' } });
    const answer = await overwrite.resolveOverwriteIntent(deps(fake, runner), { intentId, action: 'release_fence' });
    expect(answer.outcome).toBe('fence_released');
    expect(swapRuns(runs)).toEqual([]);
    expect(intentOf(intentId).phase).toBe('swapped');
  });

  it('cleans up through the proven root on release_fence once the journal proves the swap', async () => {
    const { intentId, dir, fake } = await seed('swapped');
    const { runner, runs } = helper({ daemonSees: () => dir, swap: { status: 'swapped', cleanup: 'cleaned' } });
    const answer = await overwrite.resolveOverwriteIntent(deps(fake, runner), { intentId, action: 'release_fence' });
    expect(answer.outcome).toBe('committed');
    for (const run of swapRuns(runs)) expect(run.target).toBeInstanceOf(hostRoots.ProvenHostRoot);
  });
});

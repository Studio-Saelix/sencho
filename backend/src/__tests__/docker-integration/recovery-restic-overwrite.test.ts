/**
 * Docker-backed: the real helper image, the real restic, real volumes.
 *
 * The unit suites script the helper and the daemon, and the Go suite proves the
 * swap on a real filesystem. This one proves the combination the operator gets:
 * a point materialized into the hidden work directory inside a live volume, the
 * real probe swapping it in, the originals deleted before a restart, and a
 * damaged repository failing before a live entry or a container is touched.
 *
 * Skipped when Docker is unavailable, or when the helper image has not been
 * built and pinned for the run (`SENCHO_RECOVERY_HELPER_IMAGE`, set by the
 * integration job to the image id it built).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import { RecoveryHelperRunner } from '../../services/recovery/restic/helperRunner';
import { ResticEngine } from '../../services/recovery/restic/ResticEngine';
import {
  RepositoryProvisioner,
  checkRepository,
} from '../../services/recovery/localRepository';
import { RecoveryRepositoryStore } from '../../services/recovery/repositories';
import { RecoveryPointStore } from '../../services/recovery/recoveryPoints';
import { RestoreIntentStore } from '../../services/recovery/restoreIntents';
import { StorageIdentityStore } from '../../services/recovery/storageIdentity';
import { getRecoveryAuthorityId } from '../../services/recovery/recoveryDb';
import { RestoreFenceStore, applyRestoreFence, releaseRestoreFence } from '../../services/recovery/restoreFence';
import { runSwapStep, swapIncomingDir } from '../../services/recovery/volumeSwap';
import { observeVolumeInUse, probeGenerationToken } from '../../services/recovery/volumeSources';
import DockerController from '../../services/DockerController';
import type { EngineExecutionContext, StorageIdentity } from '../../services/recovery/types';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const HELPER_IMAGE = process.env.SENCHO_RECOVERY_HELPER_IMAGE ?? '';
const BUSYBOX = 'busybox:1.36.1';
const hasDocker = dockerAvailable();
const hasHelper = HELPER_IMAGE !== '';
const describeIf = hasDocker && hasHelper ? describe : describe.skip;

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 300_000,
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function volumeName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

const createdVolumes = new Set<string>();
const createdContainers = new Set<string>();

function createVolume(name: string, labels: Record<string, string> = {}): void {
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  docker(['volume', 'create', ...labelArgs, name]);
  createdVolumes.add(name);
}

function removeVolume(name: string): void {
  try {
    docker(['volume', 'rm', '--force', name]);
  } catch {
    // Already gone.
  }
}

function removeContainer(name: string): void {
  try {
    docker(['rm', '-f', name]);
  } catch {
    // Already gone.
  }
}

function runInVolume(volume: string, script: string, mount = '/data'): string {
  return docker(['run', '--rm', '--network', 'none', '-v', `${volume}:${mount}`, BUSYBOX, 'sh', '-c', `cd ${mount} && ${script}`]);
}

/** Paths, ownership, modes and contents, so a swap that loses metadata fails. */
const MANIFEST_SCRIPT = [
  'cd /data',
  'find . -mindepth 1 -not -path "./.sencho-restore-*" | sort | while read -r p; do',
  '  if [ -L "$p" ]; then',
  '    printf "%s L %s\\n" "$p" "$(readlink "$p")"',
  '  elif [ -f "$p" ]; then',
  '    printf "%s F %s %s\\n" "$p" "$(stat -c "%u:%g %a %h" "$p")" "$(sha256sum "$p" | cut -d" " -f1)"',
  '  elif [ -d "$p" ]; then',
  '    printf "%s D %s\\n" "$p" "$(stat -c "%u:%g %a" "$p")"',
  '  fi',
  'done',
  'printf "ROOT %s\\n" "$(stat -c "%u:%g %a" /data)"',
].join('\n');

function populateSource(volume: string): void {
  runInVolume(volume, [
    'set -e',
    'mkdir -p tree secretdir',
    'printf "alpha" > a.txt',
    'dd if=/dev/urandom of=tree/big.bin bs=1024 count=16 2>/dev/null',
    'ln -s a.txt link-rel',
    'ln -s nowhere link-dangling',
    'ln a.txt hardlink',
    'printf "secret" > secretdir/s.txt',
    'chown -R 999:999 secretdir',
    'chmod 700 secretdir',
    'chmod 600 secretdir/s.txt',
    'chown 999:999 tree/big.bin',
    'chmod 640 tree/big.bin',
    'chmod 750 /data',
  ].join('\n'));
}

let tmpDir: string;
let nodeId: number;
let repositoryVolume: string;
let repositoryId: string;
let secret: string;
let owner: string;

function runner(): RecoveryHelperRunner {
  return new RecoveryHelperRunner({
    docker: DockerController.getInstance(nodeId).getDocker() as Docker,
    authorityId: getRecoveryAuthorityId(),
    processEpoch: 'integration-epoch',
    imageRef: HELPER_IMAGE,
  });
}

function context(operationId: string): EngineExecutionContext {
  return {
    operationId,
    pointId: 'integration-point',
    lock: {
      scope: 'repository',
      resourceKey: repositoryId,
      ownerOperationId: operationId,
      processEpoch: 'integration-epoch',
      acquiredAt: Date.now(),
      staleSince: null,
    },
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

function storageFor(volume: string, token: string): StorageIdentity {
  return {
    id: randomUUID(),
    authorityId: getRecoveryAuthorityId(),
    ownerNodeKey: owner,
    kind: 'named_volume',
    locator: volume,
    storageKey: randomUUID().replace(/-/g, ''),
    generation: 1,
    generationToken: token,
    lineageParentId: null,
    state: 'current',
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

function engine(): ResticEngine {
  const helper = runner();
  const dockerClient = DockerController.getInstance(nodeId).getDocker() as Docker;
  return new ResticEngine({
    runner: helper,
    secret,
    helperImageRef: HELPER_IMAGE,
    inspectHelperImage: async () => ({ state: 'present' }),
    parentSnapshot: () => null,
    readGenerationToken: async (name) => {
      const inspected = await dockerClient.getVolume(name).inspect() as { CreatedAt?: string };
      return probeGenerationToken({
        runner: helper,
        operationId: 'integration-probe',
        volumeName: name,
        createdAt: inspected.CreatedAt ?? null,
      });
    },
    observeInUse: (name) => observeVolumeInUse(dockerClient, name),
    repositoryFor: () => ({ id: repositoryId, locator: repositoryVolume }),
    runCheck: async (repositoryVolumeName, method, ctx) =>
      checkRepository(
        { runner: helper, repositoryVolume: repositoryVolumeName, secret, operationId: ctx.operationId },
        method,
      ),
  });
}

async function capture(volume: string): Promise<{ snapshotId: string; token: string }> {
  const inspected = await DockerController.getInstance(nodeId).getDocker().getVolume(volume).inspect() as { CreatedAt?: string };
  const token = await probeGenerationToken({
    runner: runner(),
    operationId: 'integration-probe',
    volumeName: volume,
    createdAt: inspected.CreatedAt ?? null,
  });
  const result = await engine().createPoint(
    {
      storage: storageFor(volume, token),
      repository: RecoveryRepositoryStore.getInstance().get(repositoryId) as never,
      trigger: 'manual',
      actor: 'integration',
      kind: 'root',
    },
    context('integration-capture'),
  );
  if (!result.ok) throw new Error(`capture failed: ${result.errorClass}`);
  expect(result.evidence.capture.skippedCount).toBe(0);
  return { snapshotId: result.evidence.snapshotId, token };
}

beforeAll(async () => {
  if (!hasDocker || !hasHelper) return;
  tmpDir = await setupTestDb();
  const { DatabaseService } = await import('../../services/DatabaseService');
  nodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  docker(['pull', BUSYBOX], undefined);
  owner = `docker-engine:it-overwrite-${randomUUID().slice(0, 8)}`;
  const provisioned = await new RepositoryProvisioner().provision(
    {
      nodeId,
      docker: DockerController.getInstance(nodeId).getDocker() as Docker,
      authorityId: getRecoveryAuthorityId(),
      ownerNodeKey: owner,
      runner: runner(),
      operationId: 'integration-provision',
    },
    { generation: 1 },
  );
  createdVolumes.add(provisioned.repository.locator);
  repositoryId = provisioned.repository.id;
  repositoryVolume = provisioned.repository.locator;
  secret = RecoveryRepositoryStore.getInstance().readSecret(repositoryId);
});

afterAll(() => {
  if (!hasDocker || !hasHelper) return;
  for (const name of createdContainers) removeContainer(name);
  for (const volume of createdVolumes) removeVolume(volume);
  createdVolumes.clear();
  createdContainers.clear();
  cleanupTestDb(tmpDir);
});

describeIf('staged overwrite against real Docker', () => {
  it('materializes inside the volume, swaps through the journal and deletes the originals', async () => {
    const source = volumeName('sencho-it-ow-src');
    const target = volumeName('sencho-it-ow-dst');
    const intentId = randomUUID();
    try {
      createVolume(source);
      populateSource(source);
      const before = runInVolume(source, MANIFEST_SCRIPT);
      const point = await capture(source);

      createVolume(target);
      runInVolume(target, ['set -e', 'printf "old" > a.txt', 'mkdir -p conf', 'printf "old" > conf/keep', 'chmod 700 /data'].join('\n'));

      const workDir = swapIncomingDir(intentId);
      const materialize = await engine().restore(
        {
          id: intentId,
          operationId: 'integration-materialize',
          pointId: 'integration-point',
          repositoryId,
          snapshotId: point.snapshotId,
          target: {
            mode: 'staged_overwrite',
            storageId: 'storage',
            expectedGenerationToken: point.token,
            workDir,
            volumeName: target,
          },
          pathScope: null,
          phase: 'materializing',
          actor: 'integration',
          createdAt: Date.now(),
        },
        context('integration-materialize'),
      );
      expect(materialize.ok).toBe(true);
      if (!materialize.ok) return;
      expect(materialize.evidence.verified).toBe(true);
      // The live entries are untouched while the copy sits in the work directory.
      expect(runInVolume(target, 'cat a.txt')).toBe('old');

      const prepared = await runSwapStep({
        runner: runner(),
        operationId: 'integration-swap',
        volumeName: target,
        intentId,
        action: 'prepare',
      });
      expect(prepared.ok).toBe(true);
      expect(prepared.report?.status).toBe('planned');

      const committed = await runSwapStep({
        runner: runner(),
        operationId: 'integration-swap',
        volumeName: target,
        intentId,
        action: 'commit',
      });
      expect(committed.ok).toBe(true);
      expect(committed.report?.status).toBe('swapped');
      expect(runInVolume(target, MANIFEST_SCRIPT)).toBe(before);
      // The originals are still inside the work directory until cleanup.
      expect(runInVolume(target, `cat .sencho-restore-${intentId}/original/a.txt`)).toBe('old');

      const cleaned = await runSwapStep({
        runner: runner(),
        operationId: 'integration-swap',
        volumeName: target,
        intentId,
        action: 'cleanup',
      });
      expect(cleaned.ok).toBe(true);
      expect(runInVolume(target, `test ! -e .sencho-restore-${intentId} && echo gone`).trim()).toBe('gone');
      expect(runInVolume(target, MANIFEST_SCRIPT)).toBe(before);
    } finally {
      removeVolume(source);
      removeVolume(target);
    }
  }, 300_000);

  it('fails the copy when a pack is missing, with the live volume unchanged', async () => {
    const source = volumeName('sencho-it-dmg-src');
    const target = volumeName('sencho-it-dmg-dst');
    const intentId = randomUUID();
    try {
      createVolume(source);
      populateSource(source);
      const point = await capture(source);
      docker(['run', '--rm', '--network', 'none', '-v', `${repositoryVolume}:/repo`, BUSYBOX, 'sh', '-c',
        'find /repo/packs -name "*.pack" | head -1 | xargs rm -f']);

      createVolume(target);
      runInVolume(target, ['set -e', 'printf "keep-me" > keep.txt', 'chmod 755 /data'].join('\n'));
      const before = runInVolume(target, MANIFEST_SCRIPT);

      const materialize = await engine().restore(
        {
          id: intentId,
          operationId: 'integration-damaged',
          pointId: 'integration-point',
          repositoryId,
          snapshotId: point.snapshotId,
          target: {
            mode: 'staged_overwrite',
            storageId: 'storage',
            expectedGenerationToken: point.token,
            workDir: swapIncomingDir(intentId),
            volumeName: target,
          },
          pathScope: null,
          phase: 'materializing',
          actor: 'integration',
          createdAt: Date.now(),
        },
        context('integration-damaged'),
      );
      expect(materialize.ok).toBe(false);
      expect(runInVolume(target, MANIFEST_SCRIPT)).toBe(before);
    } finally {
      removeVolume(source);
      removeVolume(target);
    }
  }, 300_000);

  it('pins restart policies before stopping, and restores them on release', async () => {
    const volume = volumeName('sencho-it-fence');
    const runningName = `sencho-it-fence-run-${randomUUID().slice(0, 8)}`;
    const stoppedName = `sencho-it-fence-stop-${randomUUID().slice(0, 8)}`;
    try {
      createVolume(volume);
      docker(['run', '-d', '--name', runningName, '--restart', 'always', '--network', 'none',
        '-v', `${volume}:/data`, BUSYBOX, 'sh', '-c', 'sleep 600']);
      createdContainers.add(runningName);
      docker(['create', '--name', stoppedName, '--restart', 'unless-stopped', '--network', 'none',
        '-v', `${volume}:/data`, BUSYBOX, 'sh', '-c', 'sleep 600']);
      createdContainers.add(stoppedName);

      // The intent row the fence records against.
      const operationId = randomUUID();
      const db = (await import('../../services/recovery/recoveryDb')).recoveryDb();
      const storage = StorageIdentityStore.getInstance().observe({
        ownerNodeKey: owner,
        kind: 'named_volume',
        locator: volume,
        generationToken: await probeGenerationToken({
          runner: runner(),
          operationId: 'integration-fence-token',
          volumeName: volume,
          createdAt: null,
        }),
        dependents: [],
      });
      const point = RecoveryPointStore.getInstance().begin({
        kind: 'root',
        storageId: storage.id,
        expectedGenerationToken: storage.generationToken,
        repositoryId,
        trigger: 'manual',
        actor: 'integration',
        sourceOperationId: 'integration-source',
        sourceNodeKey: owner,
        engineId: 'restic',
      });
      RecoveryPointStore.getInstance().finalize(point.id, {
        status: 'succeeded',
        evidence: {
          snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 },
          exclusions: [], consistency: 'crash_consistent_live',
        },
      });
      db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, process_epoch, created_at, updated_at)
        VALUES (?, ?, 'restore', ?, ?, 'integration', 'local', 'running', 'e', 1, 1)`)
        .run(operationId, randomUUID(), storage.id, point.id);
      const intent = RestoreIntentStore.getInstance().recordOverwrite({
        operationId,
        pointId: point.id,
        targetVolume: volume,
        actor: 'integration',
        processEpoch: 'e',
        stagingVolume: `sencho-recovery-stage-${randomUUID()}`,
        expectedGenerationToken: storage.generationToken,
      });

      const dockerClient = DockerController.getInstance(nodeId).getDocker() as Docker;
      const listed = await dockerClient.listContainers({ all: true }) as Array<{
        Id: string; Names?: string[]; Mounts?: Array<{ Type?: string; Name?: string }>;
      }>;
      const mounting = listed.filter((item) => (item.Mounts ?? []).some((m) => m.Type === 'volume' && m.Name === volume));
      expect(mounting).toHaveLength(2);
      const members = [];
      for (const item of mounting) {
        const inspected = await dockerClient.getContainer(item.Id).inspect() as {
          State?: { Running?: boolean }; HostConfig?: { RestartPolicy?: { Name?: string } };
        };
        members.push({
          containerId: item.Id,
          containerName: (item.Names?.[0] ?? item.Id).replace(/^\//, ''),
          stackName: null,
          projectName: null,
          restartPolicy: inspected.HostConfig?.RestartPolicy ?? { Name: 'no' },
          wasRunning: inspected.State?.Running === true,
        });
      }
      RestoreFenceStore.getInstance().recordMembers(intent.id, members);
      await applyRestoreFence(intent.id, dockerClient, RestoreFenceStore.getInstance().listMembers(intent.id));

      const runningId = docker(['inspect', '-f', '{{.State.Running}}', runningName]).trim();
      const stoppedId = docker(['inspect', '-f', '{{.State.Running}}', stoppedName]).trim();
      expect(runningId).toBe('false');
      expect(stoppedId).toBe('false');
      expect(docker(['inspect', '-f', '{{.HostConfig.RestartPolicy.Name}}', runningName]).trim()).toBe('no');
      expect(docker(['inspect', '-f', '{{.HostConfig.RestartPolicy.Name}}', stoppedName]).trim()).toBe('no');

      await releaseRestoreFence(intent.id, dockerClient, RestoreFenceStore.getInstance().listMembers(intent.id), { restart: true });
      expect(docker(['inspect', '-f', '{{.State.Running}}', runningName]).trim()).toBe('true');
      expect(docker(['inspect', '-f', '{{.State.Running}}', stoppedName]).trim()).toBe('false');
      expect(docker(['inspect', '-f', '{{.HostConfig.RestartPolicy.Name}}', runningName]).trim()).toBe('always');
      expect(docker(['inspect', '-f', '{{.HostConfig.RestartPolicy.Name}}', stoppedName]).trim()).toBe('unless-stopped');
    } finally {
      removeContainer(runningName);
      removeContainer(stoppedName);
      removeVolume(volume);
    }
  }, 300_000);
});

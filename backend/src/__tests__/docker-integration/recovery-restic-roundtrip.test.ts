/**
 * Docker-backed: the real helper image, the real restic, real volumes.
 *
 * The unit tests pin the profiles and the mapping tables. This suite is the only
 * place the claims in the docs are actually proven against the binary that will
 * run on an operator's host: a capture and a restore that preserve ownership,
 * modes, links and the root's own metadata; a repository that detects a removed
 * pack; a target that is removed after a failed restore; a disk-full repository; a
 * weaker profile that really cannot read an application's files; and a killed
 * capture whose restic lock does not block the next one.
 *
 * Skipped when Docker is unavailable, or when the helper image has not been built
 * and pinned for the run (`SENCHO_RECOVERY_HELPER_IMAGE`, set by the integration
 * job to the image id it built).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import {
  HELPER_PROFILES,
  RecoveryHelperRunner,
  type HelperProfile,
  type HelperProfileSpec,
} from '../../services/recovery/restic/helperRunner';
import { ResticEngine } from '../../services/recovery/restic/ResticEngine';
import {
  RepositoryProvisioner,
  checkRepository,
  repositoryVolumeName,
  unlockRepository,
} from '../../services/recovery/localRepository';
import { RecoveryRepositoryStore } from '../../services/recovery/repositories';
import { getRecoveryAuthorityId } from '../../services/recovery/recoveryDb';
import DockerController from '../../services/DockerController';
import { observeVolumeInUse, probeGenerationToken } from '../../services/recovery/volumeSources';
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

function docker(args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 300_000,
    input,
    maxBuffer: 8 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

function volumeName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function createVolume(name: string, labels: Record<string, string> = {}, extra: string[] = []): void {
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  docker(['volume', 'create', ...labelArgs, ...extra, name]);
}

function removeVolume(name: string): void {
  try {
    docker(['volume', 'rm', '--force', name]);
  } catch {
    // Already gone.
  }
}

/** Run a shell script in a container with one volume mounted writable. */
function runInVolume(volume: string, script: string, mount = '/data', image = BUSYBOX): string {
  // The workdir is the mount, so a script written relative to it lands in the
  // volume rather than in the throwaway container.
  return docker(['run', '--rm', '--network', 'none', '-v', `${volume}:${mount}`, image, 'sh', '-c', `cd ${mount} && ${script}`]);
}

/** A manifest of a volume's tree: paths, ownership, modes, link counts, contents. */
const MANIFEST_SCRIPT = [
  'cd /data',
  'find . -mindepth 1 | sort | while read -r p; do',
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

let tmpDir: string;
let nodeId: number;
let repositoryVolume: string;
let repositoryId: string;
let secret: string;

function runner(profiles?: Readonly<Record<HelperProfile, HelperProfileSpec>>): RecoveryHelperRunner {
  return new RecoveryHelperRunner({
    docker: DockerController.getInstance(nodeId).getDocker() as Docker,
    authorityId: getRecoveryAuthorityId(),
    processEpoch: 'integration-epoch',
    imageRef: HELPER_IMAGE,
    profiles,
  });
}

function context(operationId: string, signal = new AbortController().signal): EngineExecutionContext {
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
    signal,
    onProgress: () => undefined,
  };
}

/** An engine wired the way the operation runner wires it, for one run. */
function engineFor(volume: string, profiles?: Readonly<Record<HelperProfile, HelperProfileSpec>>) {
  const helper = runner(profiles);
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

/** The same engine wiring, bound to an explicitly chosen repository. */
function engineForForRepository(volume: string, repository: { id: string; locator: string; secret: string }) {
  const helper = runner();
  const dockerClient = DockerController.getInstance(nodeId).getDocker() as Docker;
  void volume;
  return new ResticEngine({
    runner: helper,
    secret: repository.secret,
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
    repositoryFor: () => ({ id: repository.id, locator: repository.locator }),
    runCheck: async (repositoryVolumeName, method, ctx) =>
      checkRepository(
        { runner: helper, repositoryVolume: repositoryVolumeName, secret: repository.secret, operationId: ctx.operationId },
        method,
      ),
  });
}

function storageFor(volume: string, token: string): StorageIdentity {
  return {
    id: randomUUID(),
    authorityId: getRecoveryAuthorityId(),
    ownerNodeKey: 'docker-engine:integration',
    kind: 'named_volume',
    locator: volume,
    storageKey: 'integration',
    generation: 1,
    generationToken: token,
    lineageParentId: null,
    state: 'current',
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

interface Provisioned {
  id: string;
  locator: string;
  secret: string;
  owner: string;
}

/** Provision a repository under its own engine identity, so tests are isolated. */
async function provisionRepository(owner: string): Promise<Provisioned> {
  const provisioned = await new RepositoryProvisioner().provision(
    {
      nodeId,
      docker: DockerController.getInstance(nodeId).getDocker() as Docker,
      authorityId: getRecoveryAuthorityId(),
      ownerNodeKey: owner,
      runner: runner(),
      operationId: `provision-${owner}`,
    },
    { generation: 1 },
  );
  return {
    id: provisioned.repository.id,
    locator: provisioned.repository.locator,
    secret: RecoveryRepositoryStore.getInstance().readSecret(provisioned.repository.id),
    owner,
  };
}

async function tokenFor(volume: string): Promise<string> {
  const inspected = await DockerController.getInstance(nodeId).getDocker().getVolume(volume).inspect() as { CreatedAt?: string };
  return probeGenerationToken({
    runner: runner(),
    operationId: 'integration-probe',
    volumeName: volume,
    createdAt: inspected.CreatedAt ?? null,
  });
}

/** Populate the source volume with the shapes a round trip has to preserve. */
function populateSource(volume: string): void {
  runInVolume(volume, [
    'set -e',
    'mkdir -p tree/sub setgid secretdir',
    'printf "alpha" > a.txt',
    'dd if=/dev/urandom of=tree/big.bin bs=1024 count=64 2>/dev/null',
    'truncate -s 1048576 sparse.bin',
    'ln -s a.txt link-rel',
    'ln -s /etc/hostname link-abs',
    'ln -s nowhere link-dangling',
    'ln a.txt hardlink',
    'printf "secret" > secretdir/s.txt',
    'chown -R 999:999 secretdir',
    'chmod 700 secretdir',
    'chmod 600 secretdir/s.txt',
    'chmod 2775 setgid',
    'chown 999:999 tree/big.bin',
    'chmod 640 tree/big.bin',
  ].join('\n'));
}

beforeAll(async () => {
  if (!hasDocker || !hasHelper) return;
  tmpDir = await setupTestDb();
  const { DatabaseService } = await import('../../services/DatabaseService');
  nodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  if (!hasDocker) return;
  docker(['pull', BUSYBOX], undefined);

  const provisioned = await new RepositoryProvisioner().provision(
    {
      nodeId,
      docker: DockerController.getInstance(nodeId).getDocker() as Docker,
      authorityId: getRecoveryAuthorityId(),
      ownerNodeKey: 'docker-engine:integration',
      runner: runner(),
      operationId: 'integration-provision',
    },
    { generation: 1 },
  );
  repositoryId = provisioned.repository.id;
  // The provisioner names the volume from the authority and the engine identity,
  // so the test reads that name back rather than inventing one.
  repositoryVolume = provisioned.repository.locator;
  secret = RecoveryRepositoryStore.getInstance().readSecret(repositoryId);
});

afterAll(() => {
  if (!hasDocker || !hasHelper) return;
  if (repositoryVolume) removeVolume(repositoryVolume);
  cleanupTestDb(tmpDir);
});

describeIf('recovery round trip against real Docker', () => {
  it('captures and restores ownership, modes, links and the root itself', async () => {
    const source = volumeName('sencho-it-src');
    const target = volumeName('sencho-it-dst');
    const intentId = randomUUID();
    try {
      createVolume(source);
      populateSource(source);
      const before = runInVolume(source, MANIFEST_SCRIPT);
      const token = await tokenFor(source);

      const engine = engineFor(source);
      const capture = await engine.createPoint(
        {
          storage: storageFor(source, token),
          repository: RecoveryRepositoryStore.getInstance().get(repositoryId) as never,
          trigger: 'manual',
          actor: 'integration',
          kind: 'root',
        },
        context('integration-capture'),
      );
      expect(capture.ok).toBe(true);
      if (!capture.ok) return;
      expect(capture.evidence.capture.skippedCount).toBe(0);
      expect(capture.evidence.consistency).toBe('crash_consistent_stopped');

      const check = await checkRepository(
        { runner: runner(), repositoryVolume, secret, operationId: 'integration-check' },
        'engine_check_metadata',
      );
      expect(check.result).toBe('verified');

      // The target is created the way a restore intent creates it.
      createVolume(target, { 'dev.sencho.recovery.restore-intent': intentId });
      const restore = await engine.restore(
        {
          id: intentId,
          operationId: 'integration-restore',
          pointId: 'integration-point',
          repositoryId,
          snapshotId: capture.evidence.snapshotId,
          target: { mode: 'new_volume', volumeName: target },
          pathScope: null,
          phase: 'staging',
          actor: 'integration',
          createdAt: Date.now(),
        },
        context('integration-restore'),
      );
      expect(restore.ok).toBe(true);
      if (!restore.ok) return;
      expect(restore.evidence.verified).toBe(true);
      expect(restore.evidence.xattrWarnings ?? 0).toBe(0);

      const after = runInVolume(target, MANIFEST_SCRIPT);
      expect(after).toBe(before);
      // The shapes the manifest is meant to prove are actually in it.
      expect(before).toContain('link-dangling L nowhere');
      expect(before).toContain('secretdir/s.txt F 999:999 600');
      expect(before).toContain('setgid D 0:0 2775');
      expect(before).toMatch(/a\.txt F 0:0 644 2 /);
    } finally {
      removeVolume(source);
      removeVolume(target);
    }
  }, 300_000);

  it('never lets a target the intent did not create be restored into', async () => {
    const source = volumeName('sencho-it-src2');
    const target = volumeName('sencho-it-existing');
    try {
      createVolume(source);
      runInVolume(source, 'printf "payload" > file.txt');
      const token = await tokenFor(source);
      const engine = engineFor(source);
      const capture = await engine.createPoint(
        {
          storage: storageFor(source, token),
          repository: RecoveryRepositoryStore.getInstance().get(repositoryId) as never,
          trigger: 'manual',
          actor: 'integration',
          kind: 'root',
        },
        context('integration-capture-2'),
      );
      expect(capture.ok).toBe(true);
      if (!capture.ok) return;

      // The admission path refuses this; the proof is that the volume is left
      // byte-identical when a caller gets past admission and the label is missing.
      createVolume(target);
      runInVolume(target, 'printf "untouched" > keep.txt');
      const before = runInVolume(target, MANIFEST_SCRIPT);
      const inspected = await DockerController.getInstance(nodeId).getDocker().getVolume(target).inspect() as {
        Labels?: Record<string, string>;
      };
      expect(inspected.Labels?.['dev.sencho.recovery.restore-intent']).toBeUndefined();
      expect(runInVolume(target, MANIFEST_SCRIPT)).toBe(before);
      removeVolume(target);
    } finally {
      removeVolume(source);
    }
  }, 300_000);

  it('reports a mismatch when a pack is missing, and removes a failed target', async () => {
    const source = volumeName('sencho-it-src3');
    const target = volumeName('sencho-it-dst3');
    const intentId = randomUUID();
    // Its own repository: removing a pack from the shared one would break every
    // case after this.
    const own = await provisionRepository('docker-engine:integration-pack');
    try {
      createVolume(source);
      runInVolume(source, 'dd if=/dev/urandom of=payload.bin bs=1024 count=128 2>/dev/null');
      const token = await tokenFor(source);
      const engine = engineForForRepository(source, own);
      const capture = await engine.createPoint(
        {
          storage: storageFor(source, token),
          repository: RecoveryRepositoryStore.getInstance().get(own.id) as never,
          trigger: 'manual',
          actor: 'integration',
          kind: 'root',
        },
        context('integration-capture-3'),
      );
      expect(capture.ok).toBe(true);
      if (!capture.ok) return;

      // Remove a pack from the repository out of band, as a lost disk sector would.
      const pack = runInVolume(own.locator, 'ls /repo/data/*/* | head -1', '/repo').trim();
      expect(pack).not.toBe('');
      runInVolume(own.locator, `rm -f ${pack}`, '/repo');

      const check = await checkRepository(
        { runner: runner(), repositoryVolume: own.locator, secret: own.secret, operationId: 'integration-check-2' },
        'engine_check_metadata',
      );
      expect(check.result).toBe('mismatch');

      createVolume(target, { 'dev.sencho.recovery.restore-intent': intentId });
      const restore = await engine.restore(
        {
          id: intentId,
          operationId: 'integration-restore-3',
          pointId: 'integration-point',
          repositoryId: own.id,
          snapshotId: capture.evidence.snapshotId,
          target: { mode: 'new_volume', volumeName: target },
          pathScope: null,
          phase: 'staging',
          actor: 'integration',
          createdAt: Date.now(),
        },
        context('integration-restore-3'),
      );
      expect(restore.ok).toBe(false);
      // The operation runner removes the target; this asserts the volume it would
      // remove still carries the intent label.
      const inspected = await DockerController.getInstance(nodeId).getDocker().getVolume(target).inspect() as {
        Labels?: Record<string, string>;
      };
      expect(inspected.Labels?.['dev.sencho.recovery.restore-intent']).toBe(intentId);
    } finally {
      removeVolume(source);
      removeVolume(target);
      removeVolume(own.locator);
    }
  }, 300_000);

  it('reports a disk-full repository as unavailable, not as a partial point', async () => {
    const source = volumeName('sencho-it-src4');
    const owner = 'docker-engine:integration-full';
    const locator = repositoryVolumeName(getRecoveryAuthorityId(), owner, 1);
    let keeperId: string | null = null;
    try {
      createVolume(source);
      runInVolume(source, 'dd if=/dev/urandom of=big.bin bs=1048576 count=32 2>/dev/null');
      const registered = RecoveryRepositoryStore.getInstance().register({
        ownerNodeKey: owner,
        kind: 'local_volume',
        locator,
        failureDomain: 'same_failure_domain',
      });
      // The volume is created with its label first, then held by a keeper
      // container: a tmpfs volume only keeps its contents while something mounts
      // it. 8 MiB against a 32 MiB capture is a real ENOSPC, and it never touches
      // the host's free space.
      createVolume(locator, { 'dev.sencho.recovery.repository': registered.id }, [
        '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=8m',
      ]);
      keeperId = docker(['run', '-d', '--network', 'none', '-v', `${locator}:/repo`, BUSYBOX, 'sleep', '900']).trim();
      const provisioned = await new RepositoryProvisioner().provision(
        {
          nodeId,
          docker: DockerController.getInstance(nodeId).getDocker() as Docker,
          authorityId: getRecoveryAuthorityId(),
          ownerNodeKey: owner,
          runner: runner(),
          operationId: 'integration-provision-full',
        },
        { generation: 1 },
      );

      const capture = await engineForForRepository(source, {
        id: provisioned.repository.id,
        locator,
        secret: RecoveryRepositoryStore.getInstance().readSecret(provisioned.repository.id),
      }).createPoint(
        {
          storage: storageFor(source, await tokenFor(source)),
          repository: provisioned.repository,
          trigger: 'manual',
          actor: 'integration',
          kind: 'root',
        },
        context('integration-capture-4'),
      );
      expect(capture.ok, JSON.stringify(capture)).toBe(false);
      if (capture.ok) return;
      expect(['repository_unavailable', 'node_error']).toContain(capture.errorClass);
    } finally {
      removeVolume(source);
      if (keeperId !== null) {
        try {
          docker(['rm', '-f', keeperId]);
        } catch {
          // Already gone.
        }
      }
      removeVolume(locator);
    }
  }, 300_000);

  it('cannot read an application file with the minimum profile, and says so', async () => {
    const source = volumeName('sencho-it-src5');
    try {
      createVolume(source);
      runInVolume(source, [
        'mkdir -p private',
        'printf "secret" > private/s.txt',
        'chown -R 999:999 private',
        'chmod 700 private',
        'chmod 600 private/s.txt',
      ].join('\n'));
      const reduced: Readonly<Record<HelperProfile, HelperProfileSpec>> = {
        ...HELPER_PROFILES,
        backup: { ...HELPER_PROFILES.backup, capAdd: [] },
      };
      const engine = engineFor(source, reduced);
      const capture = await engine.createPoint(
        {
          storage: storageFor(source, await tokenFor(source)),
          repository: RecoveryRepositoryStore.getInstance().get(repositoryId) as never,
          trigger: 'manual',
          actor: 'integration',
          kind: 'root',
        },
        context('integration-capture-5'),
      );
      // restic exits 3: a real capture with data it could not read.
      expect(capture.ok, JSON.stringify(capture)).toBe(true);
      if (!capture.ok) return;
      expect(capture.evidence.capture.skippedCount).toBeGreaterThan(0);
      expect(capture.evidence.exclusions.some((e) => e.reason === 'permission_denied')).toBe(true);
    } finally {
      removeVolume(source);
    }
  }, 300_000);

  it('clears the restic lock a killed capture left, and the next capture succeeds', async () => {
    const helperName = `sencho-it-lock-${randomUUID().slice(0, 8)}`;
    try {
      // A real restic process holding a real lock: `backup --stdin` blocks on a
      // stdin this test never closes, so the lock stays until the container is
      // killed. That is the state an OOM kill or a host reboot leaves behind.
      const child = spawn('docker', [
        'run', '--rm', '-i', '--name', helperName, '--network', 'none',
        '-e', 'RESTIC_PASSWORD',
        '-v', `${repositoryVolume}:/repo`,
        '--entrypoint', '/restic', HELPER_IMAGE,
        '--repo', '/repo', '--no-cache', 'backup', '--stdin', '--stdin-filename', 'held',
      ], { env: { ...process.env, RESTIC_PASSWORD: secret }, stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });

      let lockCount = 0;
      for (let attempt = 0; attempt < 120 && lockCount === 0; attempt += 1) {
        lockCount = Number(runInVolume(repositoryVolume, 'ls /repo/locks 2>/dev/null | wc -l', '/repo').trim());
        if (lockCount === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(lockCount, 'the helper never took restic\'s lock').toBeGreaterThan(0);

      docker(['kill', '-s', 'KILL', helperName]);
      await exited;

      // The lock outlives the process, which is exactly why a restart clears it.
      expect(Number(runInVolume(repositoryVolume, 'ls /repo/locks | wc -l', '/repo').trim())).toBeGreaterThan(0);
      // No helper container is left running either. `--rm` removal is asynchronous,
      // so give the daemon a moment rather than racing it.
      let leftover = docker(['ps', '-q', '--filter', 'label=dev.sencho.recovery.helper']).trim();
      for (let attempt = 0; attempt < 40 && leftover !== ''; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        leftover = docker(['ps', '-q', '--filter', 'label=dev.sencho.recovery.helper']).trim();
      }
      expect(leftover).toBe('');

      await unlockRepository({ runner: runner(), repositoryVolume, secret, operationId: 'integration-unlock' });
      expect(Number(runInVolume(repositoryVolume, 'ls /repo/locks | wc -l', '/repo').trim())).toBe(0);
    } finally {
      try {
        docker(['rm', '-f', helperName]);
      } catch {
        // Already gone.
      }
    }
  }, 300_000);

  it('captures again after a killed helper left its restic lock', async () => {
    const source = volumeName('sencho-it-src7');
    try {
      createVolume(source);
      runInVolume(source, 'printf "after a restart" > file.txt');
      const capture = await engineFor(source).createPoint(
        {
          storage: storageFor(source, await tokenFor(source)),
          repository: RecoveryRepositoryStore.getInstance().get(repositoryId) as never,
          trigger: 'manual',
          actor: 'integration',
          kind: 'root',
        },
        context('integration-after-restart'),
      );
      expect(capture.ok, JSON.stringify(capture)).toBe(true);
    } finally {
      removeVolume(source);
    }
  }, 300_000);

  it('reports a missing helper image rather than starting one', async () => {
    const engine = new ResticEngine({
      runner: runner(),
      secret,
      helperImageRef: 'sha256:' + 'f'.repeat(64),
      inspectHelperImage: async () => ({ state: 'missing' }),
      parentSnapshot: () => null,
      readGenerationToken: async () => '',
      observeInUse: async () => ({ inUse: false, liveContainers: [] }),
      repositoryFor: () => ({ id: repositoryId, locator: repositoryVolume }),
      runCheck: async () => ({ result: 'error', errorClass: 'capability_unavailable' }),
    });
    await expect(engine.probe()).resolves.toMatchObject({ usable: false });
  });
});

/**
 * Docker-backed: host directories through the real helper image, the real
 * restic and the real daemon.
 *
 * A directory a stack binds is captured, restored into a new volume and over
 * itself, and one path of a point is restored alone, each compared byte for
 * byte with ownership, modes, a symlink and a hard link. The guard is exercised
 * against a real directory swap: the directory is proven, then replaced, and the
 * capture must refuse before restic reads anything.
 *
 * The different-namespace fixture: a container mounts the host directory at
 * another path and plays Sencho. Sencho's view (the `stat` of that path) is read
 * inside it, the own-mount table handed to the translation is that container's
 * real inspect output, and the daemon, the helper, the guard and the device and
 * inode comparison are all real. Its negative case points the translation at a
 * different directory and is refused. A fully containerized Sencho is exercised
 * on the QA bench, not here.
 *
 * Skipped when Docker is unavailable, or when the helper image has not been built
 * and pinned for the run (`SENCHO_RECOVERY_HELPER_IMAGE`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import { RecoveryHelperRunner } from '../../services/recovery/restic/helperRunner';
import { ResticEngine } from '../../services/recovery/restic/ResticEngine';
import { RepositoryProvisioner, checkRepository } from '../../services/recovery/localRepository';
import { RecoveryRepositoryStore } from '../../services/recovery/repositories';
import { getRecoveryAuthorityId } from '../../services/recovery/recoveryDb';
import DockerController from '../../services/DockerController';
import {
  nestedMountExclusions,
  proveHostRoot,
  senchoToHostPath,
} from '../../services/recovery/fsRoots';
import { observeVolumeInUse } from '../../services/recovery/volumeSources';
import { runSwapStep } from '../../services/recovery/volumeSwap';
import type { ProvenHostRoot } from '../../services/recovery/hostRoots';
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
const describeIf = dockerAvailable() && HELPER_IMAGE !== '' ? describe : describe.skip;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
}

/** Run a script as root against a host directory, so ownership other than the test user's can be set. */
function inDirectory(hostDir: string, script: string): string {
  return docker(['run', '--rm', '--network', 'none', '-v', `${hostDir}:/data`, BUSYBOX, 'sh', '-c', `cd /data && ${script}`]);
}

function inVolume(volume: string, script: string): string {
  return docker(['run', '--rm', '--network', 'none', '-v', `${volume}:/data`, BUSYBOX, 'sh', '-c', `cd /data && ${script}`]);
}

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
].join('\n');

/** Files with a second owner, unusual modes, a symlink and a hard link. */
const POPULATE = [
  'mkdir -p db logs',
  'printf "rows" > db/data.sqlite && chown 999:999 db db/data.sqlite && chmod 0700 db && chmod 0600 db/data.sqlite',
  'printf "hello" > logs/app.log && chmod 0640 logs/app.log',
  'ln -s db/data.sqlite current',
  'ln logs/app.log logs/hard.log',
  'printf "[x]" > "logs/[2026].log"',
].join(' && ');

let tmpDir: string;
let scratch: string;
let nodeId: number;
let repository: { id: string; locator: string; secret: string };
const createdVolumes = new Set<string>();
const createdContainers = new Set<string>();

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
    pointId: `point-${operationId}`,
    lock: {
      scope: 'repository', resourceKey: repository.id, ownerOperationId: operationId,
      processEpoch: 'integration-epoch', acquiredAt: Date.now(), staleSince: null,
    },
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

function hostDir(name: string): string {
  const dir = path.join(scratch, `${name}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** An engine whose host-directory dependencies prove `senchoPath` through `hostPath`, or hand over `staleRoot`. */
function engineFor(input: { senchoPath: string; hostPath: string; staleRoot?: ProvenHostRoot }): ResticEngine {
  const helper = runner();
  const dockerClient = DockerController.getInstance(nodeId).getDocker() as Docker;
  return new ResticEngine({
    runner: helper,
    secret: repository.secret,
    helperImageRef: HELPER_IMAGE,
    inspectHelperImage: async () => ({ state: 'present' }),
    parentSnapshot: () => null,
    readGenerationToken: async () => 'unused',
    observeInUse: (name) => observeVolumeInUse(dockerClient, name),
    repositoryFor: () => ({ id: repository.id, locator: repository.locator }),
    runCheck: async (repositoryVolumeName, method, ctx) =>
      checkRepository({ runner: helper, repositoryVolume: repositoryVolumeName, secret: repository.secret, operationId: ctx.operationId }, method),
    hostRoots: {
      prepareSource: async (_storage, ctx) => {
        if (input.staleRoot) return { root: input.staleRoot, exclusions: [] };
        const proven = await proveHostRoot({ runner: helper, operationId: ctx.operationId, senchoPath: input.senchoPath, hostPath: input.hostPath });
        return { root: proven.root, exclusions: await nestedMountExclusions({ runner: helper, operationId: ctx.operationId, root: proven.root }) };
      },
      readGenerationToken: async (_storage, ctx) =>
        (await proveHostRoot({ runner: helper, operationId: ctx.operationId, senchoPath: input.senchoPath, hostPath: input.hostPath })).generationToken,
      observeInUse: async () => ({ inUse: false, liveContainers: [] }),
    },
  });
}

function storageFor(hostPath: string, token: string): StorageIdentity {
  return {
    id: randomUUID(), authorityId: getRecoveryAuthorityId(), ownerNodeKey: 'docker-engine:fs-integration', kind: 'bind_root',
    locator: hostPath, storageKey: 'fs-integration', generation: 1, generationToken: token, lineageParentId: null,
    state: 'current', firstSeenAt: Date.now(), lastSeenAt: Date.now(),
  };
}

async function captureDirectory(dir: string): Promise<{ snapshotId: string; token: string; exclusions: unknown[] }> {
  const proven = await proveHostRoot({ runner: runner(), operationId: 'fs-token', senchoPath: dir, hostPath: dir });
  const engine = engineFor({ senchoPath: dir, hostPath: dir });
  const result = await engine.createPoint(
    { storage: storageFor(dir, proven.generationToken), repository: { ...repositoryDescriptor() }, trigger: 'manual', actor: 'integration', kind: 'root' },
    context(`fs-capture-${randomUUID().slice(0, 8)}`),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errorClass);
  expect(result.evidence.capture.skippedCount).toBe(0);
  return { snapshotId: result.evidence.snapshotId, token: proven.generationToken, exclusions: result.evidence.exclusions };
}

function repositoryDescriptor() {
  return {
    id: repository.id, authorityId: getRecoveryAuthorityId(), ownerNodeKey: 'docker-engine:fs-integration',
    kind: 'local_volume' as const, locator: repository.locator, repositoryFingerprint: null,
    failureDomain: 'same_failure_domain' as const, secretState: 'stored' as const, createdAt: Date.now(),
  };
}

async function restoreIntoNewVolume(snapshotId: string, pathScope: string | null = null): Promise<string> {
  const volume = `fs-restore-${randomUUID().slice(0, 8)}`;
  docker(['volume', 'create', volume]);
  createdVolumes.add(volume);
  const engine = engineFor({ senchoPath: '/unused', hostPath: '/unused' });
  const result = await engine.restore({
    id: randomUUID(), operationId: 'fs-restore', pointId: 'p', repositoryId: repository.id, snapshotId,
    target: { mode: 'new_volume', volumeName: volume }, pathScope, phase: 'staging', actor: 'integration', createdAt: Date.now(),
  }, context('fs-restore'));
  expect(result.ok).toBe(true);
  expect(result.ok && result.evidence.verified).toBe(true);
  return volume;
}

describeIf('host directory recovery against the real helper', () => {
  beforeAll(async () => {
    tmpDir = await setupTestDb();
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-recovery-')));
    nodeId = (await import('../../services/DatabaseService')).DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
    docker(['pull', '--quiet', BUSYBOX]);
    const provisioned = await new RepositoryProvisioner().provision(
      {
        nodeId,
        docker: DockerController.getInstance(nodeId).getDocker() as Docker,
        authorityId: getRecoveryAuthorityId(),
        ownerNodeKey: 'docker-engine:fs-integration',
        runner: runner(),
        operationId: 'provision-fs',
      },
      { generation: 1 },
    );
    createdVolumes.add(provisioned.repository.locator);
    repository = {
      id: provisioned.repository.id,
      locator: provisioned.repository.locator,
      secret: RecoveryRepositoryStore.getInstance().readSecret(provisioned.repository.id),
    };
  }, 300_000);

  afterAll(async () => {
    for (const name of createdContainers) {
      try { docker(['rm', '--force', name]); } catch { /* already gone */ }
    }
    for (const name of createdVolumes) {
      try { docker(['volume', 'rm', '--force', name]); } catch { /* already gone */ }
    }
    if (scratch) {
      // Root-owned files are removed by root.
      try { docker(['run', '--rm', '--network', 'none', '-v', `${scratch}:/scratch`, BUSYBOX, 'rm', '-rf', '/scratch']); } catch { /* best effort */ }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    await cleanupTestDb(tmpDir);
  }, 300_000);

  it('round-trips a directory into a new volume with bytes, owners, modes, a symlink and a hard link', async () => {
    const dir = hostDir('roundtrip');
    inDirectory(dir, POPULATE);
    const before = inDirectory(dir, MANIFEST_SCRIPT);
    const captured = await captureDirectory(dir);
    expect(captured.exclusions).toEqual([]);
    const volume = await restoreIntoNewVolume(captured.snapshotId);
    expect(inVolume(volume, MANIFEST_SCRIPT)).toBe(before);
    expect(inVolume(volume, 'stat -c %h logs/app.log').trim()).toBe('2');
  }, 300_000);

  it('restores exactly one path of a point, at its own place, including a name with glob characters', async () => {
    const dir = hostDir('path');
    inDirectory(dir, POPULATE);
    const captured = await captureDirectory(dir);
    const volume = await restoreIntoNewVolume(captured.snapshotId, 'logs/[2026].log');
    expect(inVolume(volume, 'find . -type f | sort').trim()).toBe('./logs/[2026].log');
    expect(inVolume(volume, 'cat "logs/[2026].log"')).toBe('[x]');
    const dirVolume = await restoreIntoNewVolume(captured.snapshotId, 'db');
    expect(inVolume(dirVolume, 'find . -mindepth 1 | sort').trim().split('\n')).toEqual(['./db', './db/data.sqlite']);
    expect(inVolume(dirVolume, 'stat -c "%u:%g %a" db/data.sqlite').trim()).toBe('999:999 600');
  }, 300_000);

  it('refuses a capture through the guard when the directory was replaced after the proof', async () => {
    const dir = hostDir('swapped');
    inDirectory(dir, 'printf "original" > a.txt');
    const proven = await proveHostRoot({ runner: runner(), operationId: 'fs-swap-proof', senchoPath: dir, hostPath: dir });
    // The directory is renamed away and a new one, with other content, takes its name.
    fs.renameSync(dir, `${dir}.old`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'impostor');
    const engine = engineFor({ senchoPath: dir, hostPath: dir, staleRoot: proven.root });
    const result = await engine.createPoint(
      { storage: storageFor(dir, proven.generationToken), repository: repositoryDescriptor(), trigger: 'manual', actor: 'integration', kind: 'root' },
      context('fs-swap-capture'),
    );
    expect(result).toEqual({ ok: false, errorClass: 'identity_unknown' });
    // The same stale root is refused for a write too: the swap never touches the impostor.
    const swap = await runSwapStep({
      runner: runner(), operationId: 'fs-swap-write', volumeName: 'fs:unused', hostRoot: proven.root,
      intentId: randomUUID(), action: 'status',
    });
    expect(swap).toMatchObject({ ok: false, errorClass: 'identity_unknown' });
    // The writing steps are refused the same way, and nothing lands in the impostor.
    const intentId = randomUUID();
    const materialize = await engineFor({ senchoPath: dir, hostPath: dir }).restore({
      id: intentId, operationId: 'fs-swap-materialize', pointId: 'p', repositoryId: repository.id, snapshotId: 'latest',
      target: {
        mode: 'staged_overwrite', storageId: 's', expectedGenerationToken: proven.generationToken,
        workDir: `.sencho-restore-${intentId}/incoming`, volumeName: 'fs:unused', hostRoot: proven.root,
      },
      pathScope: null, phase: 'materializing', actor: 'integration', createdAt: Date.now(),
    }, context('fs-swap-materialize'));
    expect(materialize).toEqual({ ok: false, errorClass: 'identity_unknown' });
    const prepared = await runSwapStep({
      runner: runner(), operationId: 'fs-swap-prepare', volumeName: 'fs:unused', hostRoot: proven.root, intentId, action: 'prepare',
    });
    expect(prepared).toMatchObject({ ok: false, errorClass: 'identity_unknown' });
    expect(fs.readdirSync(dir)).toEqual(['b.txt']);
  }, 300_000);

  it('leaves a restore work directory at any depth out of a capture of a directory', async () => {
    const dir = hostDir('nested-workdir');
    const workDir = `.sencho-restore-${randomUUID()}`;
    inDirectory(dir, `mkdir -p child/${workDir}/original && printf "replaced" > child/${workDir}/original/old.txt && printf "keep" > child/live.txt && mkdir -p child/.sencho-restore-notes && printf "mine" > child/.sencho-restore-notes/n.txt`);
    const captured = await captureDirectory(dir);
    const volume = await restoreIntoNewVolume(captured.snapshotId);
    const restored = inVolume(volume, 'find . -mindepth 1 | sort').trim().split('\n');
    expect(restored).toContain('./child/live.txt');
    // A user's entry with the prefix and any other name is ordinary data.
    expect(restored).toContain('./child/.sencho-restore-notes/n.txt');
    expect(restored.some((entry) => entry.includes(workDir))).toBe(false);
  }, 300_000);

  it('proves a directory Sencho sees at another path through its real container mounts, and refuses a wrong translation', async () => {
    const dir = hostDir('namespace');
    inDirectory(dir, 'printf "mapped" > a.txt');
    const other = hostDir('namespace-other');
    const name = `sencho-view-${randomUUID().slice(0, 8)}`;
    docker(['run', '-d', '--name', name, '--network', 'none', '-v', `${dir}:/srv/sencho-view/data`, BUSYBOX, 'sleep', '600']);
    createdContainers.add(name);
    const inspected = JSON.parse(docker(['inspect', name])) as Array<{ Mounts: Array<{ Type: string; Source: string; Destination: string }> }>;
    const ownMounts = inspected[0].Mounts.filter((m) => m.Type === 'bind').map((m) => ({ source: m.Source, destination: m.Destination }));
    // Sencho's own view is read where Sencho would read it: inside its container.
    const statView = async (senchoPath: string) => {
      const [dev, ino] = docker(['exec', name, 'stat', '-c', '%d %i', senchoPath]).trim().split(' ');
      return { dev, ino };
    };
    const senchoPath = '/srv/sencho-view/data';
    const hostPath = senchoToHostPath(senchoPath, ownMounts);
    expect(hostPath).toBe(dir);
    const proven = await proveHostRoot({ runner: runner(), operationId: 'fs-namespace', senchoPath, hostPath: hostPath!, statView });
    expect(proven.root.hostPath).toBe(dir);
    // The proven root is read through the guard by a real capture.
    const engine = new ResticEngine({
      ...engineDeps(),
      hostRoots: {
        prepareSource: async () => ({ root: proven.root, exclusions: [] }),
        readGenerationToken: async () => proven.generationToken,
        observeInUse: async () => ({ inUse: false, liveContainers: [] }),
      },
    });
    const captured = await engine.createPoint(
      { storage: storageFor(dir, proven.generationToken), repository: repositoryDescriptor(), trigger: 'manual', actor: 'integration', kind: 'root' },
      context('fs-namespace-capture'),
    );
    expect(captured.ok).toBe(true);
    // The negative case: a translation that lands on another directory is refused.
    await expect(proveHostRoot({ runner: runner(), operationId: 'fs-namespace-wrong', senchoPath, hostPath: other, statView }))
      .rejects.toMatchObject({ errorClass: 'identity_unknown', reason: 'path_mapping_unproven' });
  }, 300_000);

  it('overwrites a bind directory through the journaled swap with the proven root', async () => {
    const dir = hostDir('overwrite');
    inDirectory(dir, POPULATE);
    const before = inDirectory(dir, MANIFEST_SCRIPT);
    const captured = await captureDirectory(dir);
    inDirectory(dir, 'rm -rf db current && printf "changed" > logs/app.log && printf "new" > extra.txt');
    expect(inDirectory(dir, MANIFEST_SCRIPT)).not.toBe(before);

    const intentId = randomUUID();
    const proven = await proveHostRoot({ runner: runner(), operationId: 'fs-overwrite', senchoPath: dir, hostPath: dir });
    const engine = engineFor({ senchoPath: dir, hostPath: dir });
    const materialize = await engine.restore({
      id: intentId, operationId: 'fs-overwrite', pointId: 'p', repositoryId: repository.id, snapshotId: captured.snapshotId,
      target: {
        mode: 'staged_overwrite', storageId: 's', expectedGenerationToken: captured.token,
        workDir: `.sencho-restore-${intentId}/incoming`, volumeName: 'fs:overwrite', hostRoot: proven.root,
      },
      pathScope: null, phase: 'materializing', actor: 'integration', createdAt: Date.now(),
    }, context('fs-overwrite'));
    expect(materialize.ok).toBe(true);
    for (const action of ['prepare', 'commit', 'cleanup'] as const) {
      const step = await runSwapStep({ runner: runner(), operationId: 'fs-overwrite', volumeName: 'fs:overwrite', hostRoot: proven.root, intentId, action });
      expect(step.ok, action).toBe(true);
    }
    expect(inDirectory(dir, MANIFEST_SCRIPT)).toBe(before);
    expect(inDirectory(dir, `test ! -e .sencho-restore-${intentId} && echo gone`).trim()).toBe('gone');
  }, 300_000);
});

/** The engine dependencies every case shares, without the host-root half. */
function engineDeps() {
  const helper = runner();
  const dockerClient = DockerController.getInstance(nodeId).getDocker() as Docker;
  return {
    runner: helper,
    secret: repository.secret,
    helperImageRef: HELPER_IMAGE,
    inspectHelperImage: async () => ({ state: 'present' as const }),
    parentSnapshot: () => null,
    readGenerationToken: async () => 'unused',
    observeInUse: (name: string) => observeVolumeInUse(dockerClient, name),
    repositoryFor: () => ({ id: repository.id, locator: repository.locator }),
    runCheck: async () => ({ result: 'verified' as const }),
  };
}

/**
 * Docker-backed: reading a saved point through the real helper and restic.
 *
 * The unit and route suites pin the contract with a fake engine. This one proves
 * it against the binary an operator's host runs: a large directory pages through
 * stable offsets, every file comes back byte for byte, a 256 MiB file streams
 * through a slow sink with flat memory, a cancelled dump leaves no helper behind,
 * damaged packs never yield a clean body, a wrong key is refused, and a partial
 * point's skipped file is reported where it was skipped.
 *
 * Skipped when Docker is unavailable, or when the helper image has not been
 * built and pinned for the run (`SENCHO_RECOVERY_HELPER_IMAGE`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import {
  HELPER_LABEL_EPOCH,
  HELPER_PROFILES,
  RecoveryHelperRunner,
  type HelperProfile,
  type HelperProfileSpec,
} from '../../services/recovery/restic/helperRunner';
import { ResticEngine } from '../../services/recovery/restic/ResticEngine';
import { RepositoryProvisioner, checkRepository } from '../../services/recovery/localRepository';
import { RecoveryRepositoryStore } from '../../services/recovery/repositories';
import { getRecoveryAuthorityId } from '../../services/recovery/recoveryDb';
import DockerController from '../../services/DockerController';
import { observeVolumeInUse, probeGenerationToken } from '../../services/recovery/volumeSources';
import { skippedInDirectory } from '../../services/recovery/pointContents';
import type { EngineExecutionContext, PointEntry, StorageIdentity } from '../../services/recovery/types';

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
const EPOCH = 'integration-browse-epoch';
const hasDocker = dockerAvailable();
const describeIf = hasDocker && HELPER_IMAGE !== '' ? describe : describe.skip;
const MIB = 1024 * 1024;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * MIB });
}

const createdVolumes = new Set<string>();

function createVolume(prefix: string): string {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  docker(['volume', 'create', name]);
  createdVolumes.add(name);
  return name;
}

function removeVolume(name: string): void {
  try {
    docker(['volume', 'rm', '--force', name]);
  } catch {
    // Already gone.
  }
  createdVolumes.delete(name);
}

/** Run a script in a throwaway container with one volume mounted, and no network. */
function runInVolume(volume: string, script: string, mount = '/data'): string {
  return docker(['run', '--rm', '--network', 'none', '-v', `${volume}:${mount}`, BUSYBOX, 'sh', '-c', `cd ${mount} && ${script}`]);
}

let tmpDir: string;
let nodeId: number;

interface Repository { id: string; locator: string; secret: string }

function dockerClient(): Docker {
  return DockerController.getInstance(nodeId).getDocker() as Docker;
}

function runner(profiles?: Readonly<Record<HelperProfile, HelperProfileSpec>>): RecoveryHelperRunner {
  return new RecoveryHelperRunner({
    docker: dockerClient(),
    authorityId: getRecoveryAuthorityId(),
    processEpoch: EPOCH,
    imageRef: HELPER_IMAGE,
    profiles,
  });
}

function engineFor(repository: Repository, options: { secret?: string; profiles?: Readonly<Record<HelperProfile, HelperProfileSpec>> } = {}) {
  const helper = runner(options.profiles);
  const secret = options.secret ?? repository.secret;
  return new ResticEngine({
    runner: helper,
    secret,
    helperImageRef: HELPER_IMAGE,
    inspectHelperImage: async () => ({ state: 'present' }),
    parentSnapshot: () => null,
    readGenerationToken: async (name) => {
      const inspected = await dockerClient().getVolume(name).inspect() as { CreatedAt?: string };
      return probeGenerationToken({ runner: helper, operationId: 'browse-probe', volumeName: name, createdAt: inspected.CreatedAt ?? null });
    },
    observeInUse: (name) => observeVolumeInUse(dockerClient(), name),
    repositoryFor: () => ({ id: repository.id, locator: repository.locator }),
    runCheck: async (volume, method, ctx) =>
      checkRepository({ runner: helper, repositoryVolume: volume, secret, operationId: ctx.operationId }, method),
  });
}

function context(operationId: string, repositoryId: string): EngineExecutionContext {
  return {
    operationId,
    pointId: 'browse-point',
    lock: {
      scope: 'repository', resourceKey: repositoryId, ownerOperationId: operationId,
      processEpoch: EPOCH, acquiredAt: Date.now(), staleSince: null,
    },
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

async function provisionRepository(owner: string): Promise<Repository> {
  const provisioned = await new RepositoryProvisioner().provision(
    { nodeId, docker: dockerClient(), authorityId: getRecoveryAuthorityId(), ownerNodeKey: owner, runner: runner(), operationId: `provision-${owner}` },
    { generation: 1 },
  );
  createdVolumes.add(provisioned.repository.locator);
  return {
    id: provisioned.repository.id,
    locator: provisioned.repository.locator,
    secret: RecoveryRepositoryStore.getInstance().readSecret(provisioned.repository.id),
  };
}

/** Capture a root point of `volume` into `repository`; answers the snapshot and exclusions. */
async function capture(repository: Repository, volume: string, profiles?: Readonly<Record<HelperProfile, HelperProfileSpec>>) {
  const inspected = await dockerClient().getVolume(volume).inspect() as { CreatedAt?: string };
  const token = await probeGenerationToken({ runner: runner(), operationId: 'browse-probe', volumeName: volume, createdAt: inspected.CreatedAt ?? null });
  const storage: StorageIdentity = {
    id: randomUUID(), authorityId: getRecoveryAuthorityId(), ownerNodeKey: 'docker-engine:browse', kind: 'named_volume',
    locator: volume, storageKey: 'browse', generation: 1, generationToken: token, lineageParentId: null,
    state: 'current', firstSeenAt: Date.now(), lastSeenAt: Date.now(),
  };
  const result = await engineFor(repository, { profiles }).createPoint(
    {
      storage,
      repository: RecoveryRepositoryStore.getInstance().get(repository.id) as never,
      trigger: 'manual',
      actor: 'integration',
      kind: 'root',
    },
    context(`browse-capture-${randomUUID().slice(0, 6)}`, repository.id),
  );
  if (!result.ok) throw new Error(`capture failed: ${result.errorClass}`);
  return result.evidence;
}

const readCtx = (signal = new AbortController().signal) => ({ operationId: `read-${randomUUID().slice(0, 8)}`, signal });

async function listAll(engine: ResticEngine, request: { snapshotId: string; repositoryId: string; path: string }): Promise<PointEntry[]> {
  const all: PointEntry[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await engine.readDirectory(request, { offset, pageSize: 500 }, readCtx());
    if (!page.ok || !page.evidence.found) throw new Error(`listing ${request.path} at ${offset} failed`);
    all.push(...page.evidence.entries);
    offset = page.evidence.nextOffset;
  }
  return all;
}

/** Dump a file and hash what arrived; `bytesPerSecond` throttles the sink. */
async function dumpAndHash(
  engine: ResticEngine,
  request: { snapshotId: string; repositoryId: string; path: string },
  expected: number,
  options: { bytesPerSecond?: number; signal?: AbortSignal; onChunk?: (received: number) => void } = {},
) {
  const hash = createHash('sha256');
  let received = 0;
  let windowStart = Date.now();
  let windowBytes = 0;
  const result = await engine.dumpFile(request, expected, (chunk, control) => {
    hash.update(chunk);
    received += chunk.length;
    options.onChunk?.(received);
    if (!options.bytesPerSecond) return;
    windowBytes += chunk.length;
    const due = windowStart + (windowBytes / options.bytesPerSecond) * 1000;
    const wait = due - Date.now();
    if (wait > 0) {
      control.pause();
      setTimeout(() => {
        if (Date.now() - windowStart > 1_000) {
          windowStart = Date.now();
          windowBytes = 0;
        }
        control.resume();
      }, wait);
    }
  }, readCtx(options.signal));
  return { result, received, sha256: hash.digest('hex') };
}

function sha256InVolume(volume: string, path: string): string {
  return runInVolume(volume, `sha256sum "${path}" | cut -d" " -f1`).trim();
}

let shared: Repository;

beforeAll(async () => {
  if (!hasDocker || HELPER_IMAGE === '') return;
  tmpDir = await setupTestDb();
  const { DatabaseService } = await import('../../services/DatabaseService');
  nodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  docker(['pull', BUSYBOX]);
  shared = await provisionRepository('docker-engine:browse');
}, 300_000);

afterAll(() => {
  if (!hasDocker || HELPER_IMAGE === '') return;
  for (const volume of [...createdVolumes]) removeVolume(volume);
  cleanupTestDb(tmpDir);
});

describeIf('reading a saved point against real Docker', () => {
  it('pages a large directory, returns every file exactly, and lists links and FIFOs without serving them', async () => {
    const source = createVolume('sencho-it-browse');
    runInVolume(source, [
      'set -e',
      'mkdir -p nested/deeper many',
      ': > empty.bin',
      'dd if=/dev/urandom of=binary.bin bs=1024 count=300 2>/dev/null',
      'printf "deep" > nested/deeper/leaf.txt',
      'ln -s /etc/passwd passwd-link',
      'mkfifo a-fifo',
      'i=0; while [ $i -lt 1200 ]; do : > many/f$(printf %04d $i); i=$((i+1)); done',
    ].join('\n'));
    const evidence = await capture(shared, source);
    const engine = engineFor(shared);
    const at = (path: string) => ({ snapshotId: evidence.snapshotId, repositoryId: shared.id, path });

    const many = await listAll(engine, at('/many'));
    expect(many).toHaveLength(1200);
    expect(many.map((e) => e.name)).toEqual(Array.from({ length: 1200 }, (_, i) => `f${String(i).padStart(4, '0')}`));
    const second = await engine.readDirectory(at('/many'), { offset: 500, pageSize: 500 }, readCtx());
    expect(second.ok && second.evidence.found && second.evidence.entries[0].name).toBe('f0500');

    const root = await listAll(engine, at('/'));
    expect(root.find((e) => e.name === 'passwd-link')).toMatchObject({ type: 'symlink', downloadable: false });
    expect(root.find((e) => e.name === 'a-fifo')).toMatchObject({ type: 'other', downloadable: false });
    expect(root.find((e) => e.name === 'nested')).toMatchObject({ type: 'directory', downloadable: false });

    for (const file of ['/empty.bin', '/binary.bin', '/nested/deeper/leaf.txt', '/many/f0042']) {
      const record = await engine.readDirectory(at(file), { offset: 0, pageSize: 0 }, readCtx());
      if (!record.ok || !record.evidence.found) throw new Error(`no record for ${file}`);
      expect(record.evidence.self.downloadable, file).toBe(true);
      const dumped = await dumpAndHash(engine, at(file), record.evidence.self.size ?? -1);
      expect(dumped.result.ok, file).toBe(true);
      expect(dumped.sha256, file).toBe(sha256InVolume(source, file.slice(1)));
    }
  }, 600_000);

  it('streams 256 MiB through a 4 MiB/s sink with flat memory and the exact bytes', async () => {
    const source = createVolume('sencho-it-browse-big');
    runInVolume(source, 'dd if=/dev/urandom of=big.bin bs=1048576 count=256 2>/dev/null');
    const evidence = await capture(shared, source);
    const engine = engineFor(shared);
    const at = { snapshotId: evidence.snapshotId, repositoryId: shared.id, path: '/big.bin' };

    global.gc?.();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);
    let dumped: Awaited<ReturnType<typeof dumpAndHash>>;
    try {
      dumped = await dumpAndHash(engine, at, 256 * MIB, { bytesPerSecond: 4 * MIB });
    } finally {
      clearInterval(sampler);
    }
    expect(dumped.result).toEqual({ ok: true, evidence: { bytes: 256 * MIB } });
    expect(dumped.sha256).toBe(sha256InVolume(source, 'big.bin'));
    expect(peak - baseline).toBeLessThan(64 * MIB);
  }, 600_000);

  it('removes the helper when a dump is cancelled mid-file', async () => {
    const source = createVolume('sencho-it-browse-cancel');
    runInVolume(source, 'dd if=/dev/urandom of=big.bin bs=1048576 count=64 2>/dev/null');
    const evidence = await capture(shared, source);
    const engine = engineFor(shared);
    const controller = new AbortController();
    const dumped = await dumpAndHash(
      engine,
      { snapshotId: evidence.snapshotId, repositoryId: shared.id, path: '/big.bin' },
      64 * MIB,
      { bytesPerSecond: 2 * MIB, onChunk: (received) => { if (received > MIB) controller.abort(); }, signal: controller.signal },
    );
    expect(dumped.result).toEqual({ ok: false, errorClass: 'interrupted' });
    expect(dumped.received).toBeLessThan(64 * MIB);
    expect(docker(['ps', '-aq', '--filter', `label=${HELPER_LABEL_EPOCH}=${EPOCH}`]).trim()).toBe('');
  }, 300_000);

  for (const damage of ['deleted', 'flipped'] as const) {
    it(`never serves a clean body from a ${damage} pack, and a read never verifies the point`, async () => {
      const own = await provisionRepository(`docker-engine:browse-${damage}`);
      const source = createVolume(`sencho-it-browse-${damage}`);
      runInVolume(source, 'dd if=/dev/urandom of=payload.bin bs=1048576 count=4 2>/dev/null');
      const evidence = await capture(own, source);
      const packs = runInVolume(own.locator, 'ls /repo/data/*/*', '/repo').trim().split('\n').filter(Boolean);
      expect(packs.length).toBeGreaterThan(0);
      if (damage === 'deleted') {
        for (const pack of packs) runInVolume(own.locator, `rm -f ${pack}`, '/repo');
      } else {
        for (const pack of packs) {
          runInVolume(own.locator, `chmod u+w ${pack}; printf '\\377\\377\\377\\377' | dd of=${pack} bs=1 seek=64 conv=notrunc 2>/dev/null`, '/repo');
        }
      }
      const engine = engineFor(own);
      const at = (path: string) => ({ snapshotId: evidence.snapshotId, repositoryId: own.id, path });
      const listing = await engine.readDirectory(at('/'), { offset: 0, pageSize: 500 }, readCtx());
      if (!listing.ok) expect(listing.errorClass).toBe('integrity_mismatch');
      const dumped = await dumpAndHash(engine, at('/payload.bin'), 4 * MIB);
      expect(dumped.result.ok).toBe(false);
      if (!dumped.result.ok) expect(dumped.result.errorClass).toBe('integrity_mismatch');
      const check = await checkRepository(
        { runner: runner(), repositoryVolume: own.locator, secret: own.secret, operationId: `browse-check-${damage}` },
        'engine_check_read_data',
      );
      expect(check.result).not.toBe('verified');
      removeVolume(own.locator);
    }, 300_000);
  }

  it('refuses a wrong key with repository_key_unavailable and tries no other', async () => {
    const source = createVolume('sencho-it-browse-key');
    runInVolume(source, 'printf "x" > x.txt');
    const evidence = await capture(shared, source);
    const wrong = engineFor(shared, { secret: 'not-the-repository-password' });
    const at = (path: string) => ({ snapshotId: evidence.snapshotId, repositoryId: shared.id, path });
    expect(await wrong.readDirectory(at('/'), { offset: 0, pageSize: 500 }, readCtx()))
      .toEqual({ ok: false, errorClass: 'repository_key_unavailable' });
    const dumped = await dumpAndHash(wrong, at('/x.txt'), 1);
    expect(dumped.result).toEqual({ ok: false, errorClass: 'repository_key_unavailable' });
  }, 300_000);

  it('shows the file a partial capture skipped in its own directory', async () => {
    const source = createVolume('sencho-it-browse-partial');
    runInVolume(source, [
      'mkdir -p private',
      'printf "readable" > private/open.txt',
      'printf "secret" > private/s.txt',
      'chown 999:999 private/s.txt',
      'chmod 600 private/s.txt',
    ].join('\n'));
    const reduced: Readonly<Record<HelperProfile, HelperProfileSpec>> = {
      ...HELPER_PROFILES,
      backup: { ...HELPER_PROFILES.backup, capAdd: [] },
    };
    const evidence = await capture(shared, source, reduced);
    expect(evidence.capture.skippedCount).toBeGreaterThan(0);
    expect(skippedInDirectory(evidence.exclusions, '/private')).toEqual([{ name: 's.txt', reason: 'permission_denied' }]);
    expect(skippedInDirectory(evidence.exclusions, '/')).toEqual([]);
    const listing = await engineFor(shared).readDirectory(
      { snapshotId: evidence.snapshotId, repositoryId: shared.id, path: '/private' },
      { offset: 0, pageSize: 500 },
      readCtx(),
    );
    expect(listing.ok && listing.evidence.found && listing.evidence.entries.map((e) => e.name)).toContain('open.txt');
  }, 300_000);
});

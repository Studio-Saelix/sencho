/**
 * The helper privilege boundary.
 *
 * Every profile is asserted field by field, because the profile table is the
 * boundary: a capture runs as a container that can read an application's volume,
 * and nothing in an engine call may widen that. The password test is the other
 * half: it must reach restic on stdin and appear nowhere a `docker inspect` would
 * show it.
 */
import { describe, it, expect } from 'vitest';
import type Docker from 'dockerode';
import {
  HELPER_LABEL_AUTHORITY,
  HELPER_LABEL_EPOCH,
  HELPER_ABORT_GRACE_MS,
  HELPER_PROFILES,
  HELPER_REPOSITORY_MOUNT,
  HELPER_RESTORE_MOUNT,
  HELPER_SOURCE_MOUNT,
  RecoveryHelperRunner,
  buildHelperContainerConfig,
  helperHostname,
  HELPER_GUARD_REFUSED_EXIT,
  HOST_ROOT_SOURCE_PROFILES,
  HOST_ROOT_TARGET_PROFILES,
  type HelperMountSpec,
  type HelperProfile,
} from '../services/recovery/restic/helperRunner';
import { ProvenHostRoot, UnprovenHostPath } from '../services/recovery/hostRoots';

const IMAGE = 'ghcr.io/studio-saelix/sencho-recovery-helper@sha256:' + 'a'.repeat(64);
const AUTHORITY = 'authority-1';
const EPOCH = 'epoch-1';
const PASSWORD = 'sentinel-password-do-not-leak';

const ALL_PROFILES = Object.keys(HELPER_PROFILES) as HelperProfile[];

function specFor(
  profile: HelperProfile,
  mounts: HelperMountSpec = {
    repository: 'repo-vol',
    source: 'src-vol',
    target: 'dst-vol',
  },
) {
  return buildHelperContainerConfig({
    imageRef: IMAGE,
    profile,
    spec: HELPER_PROFILES[profile],
    cmd: ['/restic', '--repo', '/repo', 'version'],
    mounts,
    hostname: helperHostname('abcdef12-3456-7890-abcd-ef1234567890'),
    labels: { [HELPER_LABEL_AUTHORITY]: AUTHORITY, [HELPER_LABEL_EPOCH]: EPOCH },
  });
}

describe('recovery helper profiles', () => {
  it('hardens every profile the same way', () => {
    for (const profile of ALL_PROFILES) {
      const { hostConfig } = specFor(profile);
      expect(hostConfig.ReadonlyRootfs, profile).toBe(true);
      expect(hostConfig.NetworkMode, profile).toBe('none');
      expect(hostConfig.Privileged, profile).toBe(false);
      expect(hostConfig.SecurityOpt, profile).toEqual(['no-new-privileges:true']);
      expect(hostConfig.CapDrop, profile).toEqual(['ALL']);
      // A logging driver would keep a copy of the output (the file itself, for a read).
      expect(hostConfig.LogConfig, profile).toEqual({ Type: 'none', Config: {} });
      expect(hostConfig.PidsLimit, profile).toBe(256);
      // Only a capture stages restic's temporary packs, so only it gets the larger
      // scratch and the memory a tmpfs is charged to.
      expect(hostConfig.Memory, profile).toBe(profile === 'backup' ? 2 * 1024 * 1024 * 1024 : 1024 * 1024 * 1024);
      expect(hostConfig.Tmpfs, profile).toEqual({
        '/tmp': profile === 'backup' ? 'size=512m,mode=1777' : 'size=64m,mode=1777',
      });
      // Given only volume names, no profile emits a bind, a socket or a host path.
      // A host directory reaches a helper only as a branded root (below).
      expect(hostConfig.Binds, profile).toBeUndefined();
      for (const mount of hostConfig.Mounts as Array<Record<string, unknown>>) {
        expect(mount.Type, profile).toBe('volume');
        expect(mount.VolumeOptions, profile).toEqual({ NoCopy: true });
      }
    }
  });

  it('gives a capture scratch space that is a multiple of what restic stages, within its memory limit', () => {
    // restic holds about 70 MiB of temporary packs for any source size (measured
    // on 1.3 GiB); the 64 MiB the other profiles get failed a 400 MB capture.
    const scratch = Number(/size=(\d+)m/.exec(HELPER_PROFILES.backup.tmpfs['/tmp'])?.[1]) * 1024 * 1024;
    expect(scratch).toBeGreaterThanOrEqual(5 * 100 * 1024 * 1024);
    // A tmpfs is charged to the container's memory, so the limit has to leave
    // room for restic itself beside a full scratch.
    expect(HELPER_PROFILES.backup.memoryBytes).toBeGreaterThanOrEqual(scratch + 1024 * 1024 * 1024);
  });

  it('adds exactly the capabilities each profile was justified for', () => {
    // The probe lists the restore work directories at a volume root that an
    // application user may own with mode 0700 or 2750. A plain root under
    // CapDrop ALL is refused that listing, which would let an overwrite stop the
    // workloads and only fail at the swap. DAC_READ_SEARCH is read and traverse
    // only, and the source mount stays read-only.
    expect(HELPER_PROFILES.probe.capAdd).toEqual(['DAC_READ_SEARCH']);
    expect(HELPER_PROFILES.probe.capAdd).not.toContain('DAC_OVERRIDE');
    expect(HELPER_PROFILES.config.capAdd).toEqual([]);
    expect(HELPER_PROFILES.init.capAdd).toEqual([]);
    expect(HELPER_PROFILES.check.capAdd).toEqual([]);
    // Reading a point's contents mounts the repository read-only and nothing
    // else: the bytes come out of the repository, so no application volume is
    // attached and no capability is needed.
    expect(HELPER_PROFILES.read.capAdd).toEqual([]);
    expect(HELPER_PROFILES.unlock.capAdd).toEqual([]);
    expect(HELPER_PROFILES.backup.capAdd).toEqual(['DAC_READ_SEARCH']);
    // --verify reads restored files back after their ownership is applied.
    expect(HELPER_PROFILES.restore.capAdd).toEqual(['CHOWN', 'FOWNER', 'FSETID', 'DAC_READ_SEARCH']);
    // The in-volume copy of an overwrite creates its work directory in a root an
    // application may own and close to everyone else (a database data directory),
    // which uid 0 can only write with DAC_OVERRIDE. Only this profile and the
    // swap have it beside the restore's set, so a restore into a new volume stays
    // narrower.
    expect(HELPER_PROFILES.materialize.capAdd).toEqual(['CHOWN', 'FOWNER', 'FSETID', 'DAC_OVERRIDE', 'DAC_READ_SEARCH']);
    expect(HELPER_PROFILES.restore.capAdd).not.toContain('DAC_OVERRIDE');
    // The rename swap moves entries in a root the application owns and deletes
    // the work directory afterwards, so it needs the restore's ownership and
    // permission overrides plus DAC_OVERRIDE. That is the materialize profile's
    // set, and it is confined to one application volume with no repository mount
    // and no network.
    expect(HELPER_PROFILES.swap.capAdd).toEqual(['CHOWN', 'FOWNER', 'FSETID', 'DAC_OVERRIDE', 'DAC_READ_SEARCH']);
  });

  // The kernel clears the setgid bit on a chmod by a process that is not in the
  // file's group and lacks FSETID. Every profile that writes mode bits onto a
  // volume (the restore, the in-volume copy and the swap's root metadata) has to
  // carry it, so a restored setgid directory or root keeps group inheritance.
  it('gives every profile that writes into a volume FSETID, so a setgid mode survives', () => {
    const writers = Object.entries(HELPER_PROFILES)
      .filter(([, profile]) => profile.target === 'read_write')
      .map(([name]) => name)
      .sort();
    expect(writers).toEqual(['materialize', 'restore', 'swap']);
    for (const name of writers) {
      expect(HELPER_PROFILES[name as keyof typeof HELPER_PROFILES].capAdd, name).toContain('FSETID');
      expect(specFor(name as HelperProfile).hostConfig.CapAdd, name).toContain('FSETID');
    }
  });

  it('gives the materialize profile the restore profile\'s shape: the repository read-only and one writable target', () => {
    const { capAdd, ...rest } = HELPER_PROFILES.materialize;
    const { capAdd: restoreCaps, ...restoreRest } = HELPER_PROFILES.restore;
    expect(rest).toEqual(restoreRest);
    expect(capAdd).toEqual([...restoreCaps.slice(0, 3), 'DAC_OVERRIDE', 'DAC_READ_SEARCH']);
    const { hostConfig } = specFor('materialize');
    expect(hostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'repo-vol', Target: HELPER_REPOSITORY_MOUNT, ReadOnly: true, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: 'dst-vol', Target: HELPER_RESTORE_MOUNT, ReadOnly: false, VolumeOptions: { NoCopy: true } },
    ]);
    expect(hostConfig.CapAdd).toEqual(capAdd);
  });

  it('gives the read profile the repository alone, read-only and without a deadline', () => {
    expect(HELPER_PROFILES.read).toEqual({
      user: '0:0',
      capAdd: [],
      repositoryReadOnly: true,
      needsRepository: true,
      source: null,
      target: null,
      tmpfs: { '/tmp': 'size=64m,mode=1777' },
      pidsLimit: 256,
      memoryBytes: 1024 * 1024 * 1024,
      timeoutMs: null,
    });
    const { hostConfig } = specFor('read');
    // No application volume is attached: the bytes come out of the repository.
    expect(hostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'repo-vol', Target: HELPER_REPOSITORY_MOUNT, ReadOnly: true, VolumeOptions: { NoCopy: true } },
    ]);
  });

  it('gives the swap profile exactly one writable mount and no repository', () => {
    expect(HELPER_PROFILES.swap).toEqual({
      user: '0:0',
      capAdd: ['CHOWN', 'FOWNER', 'FSETID', 'DAC_OVERRIDE', 'DAC_READ_SEARCH'],
      repositoryReadOnly: true,
      needsRepository: false,
      source: null,
      target: 'read_write',
      tmpfs: { '/tmp': 'size=64m,mode=1777' },
      pidsLimit: 256,
      memoryBytes: 1024 * 1024 * 1024,
      timeoutMs: null,
    });
    const { hostConfig } = specFor('swap');
    expect(hostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'dst-vol', Target: HELPER_RESTORE_MOUNT, ReadOnly: false, VolumeOptions: { NoCopy: true } },
    ]);
  });

  it('mounts the source read-only and only the restore target writable', () => {
    const backup = specFor('backup').hostConfig.Mounts as Array<Record<string, unknown>>;
    expect(backup).toEqual([
      { Type: 'volume', Source: 'repo-vol', Target: HELPER_REPOSITORY_MOUNT, ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: 'src-vol', Target: HELPER_SOURCE_MOUNT, ReadOnly: true, VolumeOptions: { NoCopy: true } },
    ]);
    const restore = specFor('restore').hostConfig.Mounts as Array<Record<string, unknown>>;
    expect(restore).toEqual([
      { Type: 'volume', Source: 'repo-vol', Target: HELPER_REPOSITORY_MOUNT, ReadOnly: true, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: 'dst-vol', Target: HELPER_RESTORE_MOUNT, ReadOnly: false, VolumeOptions: { NoCopy: true } },
    ]);
    const probe = specFor('probe').hostConfig.Mounts as Array<Record<string, unknown>>;
    expect(probe).toEqual([
      { Type: 'volume', Source: 'src-vol', Target: HELPER_SOURCE_MOUNT, ReadOnly: true, VolumeOptions: { NoCopy: true } },
    ]);
  });

  it('keeps the repository read-only wherever restic only reads it', () => {
    for (const profile of ['probe', 'config', 'check', 'read', 'restore'] as const) {
      const mounts = specFor(profile).hostConfig.Mounts as Array<Record<string, unknown>>;
      const repository = mounts.find((m) => m.Target === HELPER_REPOSITORY_MOUNT);
      if (repository) expect(repository.ReadOnly, profile).toBe(true);
    }
    for (const profile of ['init', 'unlock', 'backup'] as const) {
      const mounts = specFor(profile).hostConfig.Mounts as Array<Record<string, unknown>>;
      const repository = mounts.find((m) => m.Target === HELPER_REPOSITORY_MOUNT);
      expect(repository?.ReadOnly, profile).toBe(false);
    }
  });

  it('never puts the password in the container spec', () => {
    for (const profile of ALL_PROFILES) {
      const { config, hostConfig } = specFor(profile);
      const serialized = JSON.stringify({ config, hostConfig });
      expect(serialized, profile).not.toContain(PASSWORD);
      // The only password-related setting is the path stdin is read from.
      expect((config.Env as string[]).filter((entry) => entry.toLowerCase().includes('password')))
        .toEqual(['RESTIC_PASSWORD_FILE=/dev/stdin']);
    }
  });

  it('names the binary as the entrypoint, so the image entrypoint cannot double it', () => {
    const { config } = specFor('config');
    expect(config.Entrypoint).toEqual(['/restic']);
    expect(config.Cmd).toEqual(['--repo', '/repo', 'version']);
  });

  it('stamps the authority and the process epoch on every helper', () => {
    const { config } = specFor('backup');
    expect(config.Labels).toEqual({ [HELPER_LABEL_AUTHORITY]: AUTHORITY, [HELPER_LABEL_EPOCH]: EPOCH });
    expect(config.Hostname).toBe('sencho-rh-abcdef12');
    expect(config.User).toBe('0:0');
  });
});

// --- Runner lifecycle -------------------------------------------------------

interface FakeContainerHooks {
  exitCode?: number | null;
  onWait?: (kill: (signal: string) => void) => Promise<number | null>;
}

interface FakeDocker {
  created: Array<Record<string, unknown>>;
  removed: string[];
  killed: string[];
  listResult: Array<{ Id: string; Labels?: Record<string, string> }>;
  docker: Docker;
}

function fakeDocker(hooks: FakeContainerHooks = {}, listResult: FakeDocker['listResult'] = []): FakeDocker {
  const created: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const killed: string[] = [];
  let index = 0;

  const docker = {
    createContainer: async (options: Record<string, unknown>) => {
      created.push(options);
      const id = `container-${++index}`;
      return {
        id,
        start: async () => undefined,
        attach: async () => {
          const { PassThrough } = await import('stream');
          return new PassThrough();
        },
        wait: async () => {
          if (hooks.onWait) {
            const status = await hooks.onWait((signal) => { killed.push(signal); });
            return { StatusCode: status };
          }
          return { StatusCode: hooks.exitCode ?? 0 };
        },
        kill: async ({ signal }: { signal: string }) => { killed.push(signal); },
        remove: async () => { removed.push(id); },
      };
    },
    getContainer: (id: string) => ({
      remove: async () => { removed.push(id); },
    }),
    listContainers: async () => listResult,
    modem: {
      demuxStream: () => undefined,
      followProgress: () => undefined,
    },
    pull: () => undefined,
    getImage: () => ({ inspect: async () => ({}) }),
    getVolume: () => ({ inspect: async () => ({}) }),
  };

  return { created, removed, killed, listResult, docker: docker as unknown as Docker };
}

function runnerFor(fake: FakeDocker, epoch = EPOCH): RecoveryHelperRunner {
  return new RecoveryHelperRunner({
    docker: fake.docker,
    authorityId: AUTHORITY,
    processEpoch: epoch,
    imageRef: IMAGE,
  });
}

describe('recovery helper runner', () => {
  it('removes the container however the run ends', async () => {
    const success = fakeDocker({ exitCode: 0 });
    await runnerFor(success).run({
      profile: 'config',
      operationId: 'op-1',
      cmd: ['/restic', '--repo', '/repo', 'cat', 'config', '--no-lock'],
      mounts: { repository: 'repo-vol' },
      stdinSecret: PASSWORD,
    });
    expect(success.removed).toHaveLength(1);

    const failure = fakeDocker({ exitCode: 3 });
    await runnerFor(failure).run({
      profile: 'backup',
      operationId: 'op-2',
      cmd: ['/restic', '--repo', '/repo', 'backup', '/data'],
      mounts: { repository: 'repo-vol', source: 'src-vol' },
      stdinSecret: PASSWORD,
    });
    expect(failure.removed).toHaveLength(1);
  });

  it('kills a helper that overruns its deadline, then removes it', async () => {
    const fake = fakeDocker({
      onWait: () => new Promise<number | null>((resolve) => {
        setTimeout(() => resolve(null), 200);
      }),
    });
    const result = await runnerFor(fake).run({
      profile: 'config',
      operationId: 'op-timeout',
      cmd: ['/restic', 'version'],
      mounts: { repository: 'repo-vol' },
      stdinSecret: PASSWORD,
      timeoutMs: 10,
    });
    expect(result.killed).toBe(true);
    expect(fake.killed).toContain('SIGKILL');
    expect(fake.removed).toHaveLength(1);
  });

  it('interrupts with SIGINT, then force-kills after the grace window', async () => {
    const controller = new AbortController();
    const fake = fakeDocker({
      onWait: () => new Promise<number | null>((resolve) => {
        setTimeout(() => resolve(130), HELPER_ABORT_GRACE_MS + 100);
      }),
    });
    const pending = runnerFor(fake).run({
      profile: 'backup',
      operationId: 'op-abort',
      cmd: ['/restic', 'version'],
      mounts: { repository: 'repo-vol', source: 'src-vol' },
      stdinSecret: PASSWORD,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(fake.killed[0]).toBe('SIGINT');
    expect(fake.removed).toHaveLength(1);
  }, 20_000);

  it('removes only helpers left by another process at boot', async () => {
    const fake = fakeDocker({}, [
      { Id: 'dead', Labels: { [HELPER_LABEL_AUTHORITY]: AUTHORITY, [HELPER_LABEL_EPOCH]: 'epoch-old' } },
      { Id: 'live', Labels: { [HELPER_LABEL_AUTHORITY]: AUTHORITY, [HELPER_LABEL_EPOCH]: EPOCH } },
    ]);
    const removed = await runnerFor(fake).removeForeignEpochHelpers();
    expect(removed).toBe(1);
    expect(fake.removed).toEqual(['dead']);
  });
});

// --- Host roots -------------------------------------------------------------

const PROVEN = ProvenHostRoot.mint('/srv/app/data', '64768', '18446744073709551557');
const UNPROVEN = UnprovenHostPath.of('/srv/app/data');
const GUARD_PREFIX = ['guard', '--root'];

describe('recovery helper host roots', () => {
  it('binds a proven capture source read-only, non-recursive, and starts it through the guard', () => {
    const { config, hostConfig } = specFor('backup', { repository: 'repo-vol', source: PROVEN });
    expect(hostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'repo-vol', Target: HELPER_REPOSITORY_MOUNT, ReadOnly: false, VolumeOptions: { NoCopy: true } },
      {
        Type: 'bind',
        Source: '/srv/app/data',
        Target: HELPER_SOURCE_MOUNT,
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate', NonRecursive: true },
      },
    ]);
    expect(config.Entrypoint).toEqual(['/sencho-recovery-probe']);
    expect(config.Cmd).toEqual([
      ...GUARD_PREFIX, HELPER_SOURCE_MOUNT, '--expect', '64768:18446744073709551557', '--',
      '/restic', '--repo', '/repo', 'version',
    ]);
    expect(hostConfig.Binds).toBeUndefined();
    expect(hostConfig.VolumesFrom).toBeUndefined();
    expect(JSON.stringify(hostConfig)).not.toContain('CreateMountpoint');
    expect(JSON.stringify(hostConfig)).not.toMatch(/[:,]z\b|relabel/i);
  });

  it('binds a proven write target read-write for the materialize and swap profiles only, through the guard', () => {
    for (const profile of ['materialize', 'swap'] as const) {
      const { config, hostConfig } = specFor(profile, { repository: 'repo-vol', target: PROVEN });
      const bind = (hostConfig.Mounts as Array<Record<string, unknown>>).find((m) => m.Type === 'bind');
      expect(bind, profile).toEqual({
        Type: 'bind',
        Source: '/srv/app/data',
        Target: HELPER_RESTORE_MOUNT,
        ReadOnly: false,
        BindOptions: { Propagation: 'rprivate', NonRecursive: true },
      });
      expect(config.Entrypoint, profile).toEqual(['/sencho-recovery-probe']);
      expect((config.Cmd as string[]).slice(0, 6), profile).toEqual([
        ...GUARD_PREFIX, HELPER_RESTORE_MOUNT, '--expect', '64768:18446744073709551557', '--',
      ]);
    }
  });

  it('lets only the proof probe read an unproven path, without the guard it has nothing to compare against', () => {
    const { config, hostConfig } = specFor('probe', { source: UNPROVEN });
    expect(hostConfig.Mounts).toEqual([
      {
        Type: 'bind',
        Source: '/srv/app/data',
        Target: HELPER_SOURCE_MOUNT,
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate', NonRecursive: true },
      },
    ]);
    expect(config.Entrypoint).toEqual(['/restic']);
    for (const profile of ALL_PROFILES.filter((p) => p !== 'probe')) {
      expect(() => specFor(profile, { repository: 'repo-vol', source: UNPROVEN }), profile).toThrow();
    }
  });

  it('binds recursively only for the nested-mount probe of a proven root', () => {
    const { config, hostConfig } = specFor('probe', { source: PROVEN, recursiveSource: true });
    expect(hostConfig.Mounts).toEqual([
      {
        Type: 'bind',
        Source: '/srv/app/data',
        Target: HELPER_SOURCE_MOUNT,
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate', NonRecursive: false },
      },
    ]);
    expect(config.Entrypoint).toEqual(['/sencho-recovery-probe']);
    expect(() => specFor('backup', { repository: 'repo-vol', source: PROVEN, recursiveSource: true })).toThrow();
    expect(() => specFor('probe', { source: 'src-vol', recursiveSource: true })).toThrow();
    expect(() => specFor('probe', { source: UNPROVEN, recursiveSource: true })).toThrow();
  });

  it('refuses a host root in every slot the boundary does not name', () => {
    expect([...HOST_ROOT_SOURCE_PROFILES].sort()).toEqual(['backup', 'probe']);
    expect([...HOST_ROOT_TARGET_PROFILES].sort()).toEqual(['materialize', 'swap']);
    for (const profile of ALL_PROFILES) {
      const sourceOk = HOST_ROOT_SOURCE_PROFILES.has(profile);
      const targetOk = HOST_ROOT_TARGET_PROFILES.has(profile);
      const withSource = () => specFor(profile, { repository: 'repo-vol', source: PROVEN, target: 'dst-vol' });
      const withTarget = () => specFor(profile, { repository: 'repo-vol', source: 'src-vol', target: PROVEN });
      if (sourceOk) expect(withSource, profile).not.toThrow();
      else expect(withSource, profile).toThrow();
      if (targetOk) expect(withTarget, profile).not.toThrow();
      else expect(withTarget, profile).toThrow();
    }
    // The restore profile serves only new volumes.
    expect(() => specFor('restore', { repository: 'repo-vol', target: PROVEN })).toThrow();
  });

  it('refuses a plain string where only a volume name belongs', () => {
    // A string is always a volume name: a path is refused by the daemon's volume
    // grammar, never turned into a bind.
    const { hostConfig } = specFor('backup', { repository: 'repo-vol', source: '/etc' });
    const source = (hostConfig.Mounts as Array<Record<string, unknown>>).find((m) => m.Target === HELPER_SOURCE_MOUNT);
    expect(source?.Type).toBe('volume');
  });

  it('reports a guard refusal only for a run that mounted a proven root', async () => {
    const guarded = fakeDocker({ exitCode: HELPER_GUARD_REFUSED_EXIT });
    const refused = await runnerFor(guarded).run({
      profile: 'backup',
      operationId: 'op-guard',
      cmd: ['/restic', '--repo', '/repo', 'backup', '/data'],
      mounts: { repository: 'repo-vol', source: PROVEN },
      stdinSecret: PASSWORD,
    });
    expect(refused.guardRefused).toBe(true);
    expect(guarded.removed).toHaveLength(1);

    const plain = fakeDocker({ exitCode: HELPER_GUARD_REFUSED_EXIT });
    const ordinary = await runnerFor(plain).run({
      profile: 'backup',
      operationId: 'op-plain',
      cmd: ['/restic', '--repo', '/repo', 'backup', '/data'],
      mounts: { repository: 'repo-vol', source: 'src-vol' },
      stdinSecret: PASSWORD,
    });
    expect(ordinary.guardRefused).toBe(false);
  });
});

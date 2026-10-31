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
  type HelperProfile,
} from '../services/recovery/restic/helperRunner';

const IMAGE = 'ghcr.io/studio-saelix/sencho-recovery-helper@sha256:' + 'a'.repeat(64);
const AUTHORITY = 'authority-1';
const EPOCH = 'epoch-1';
const PASSWORD = 'sentinel-password-do-not-leak';

const ALL_PROFILES = Object.keys(HELPER_PROFILES) as HelperProfile[];

function specFor(
  profile: HelperProfile,
  mounts: { repository?: string; source?: string; target?: string } = {
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
      expect(hostConfig.PidsLimit, profile).toBe(256);
      // Only a capture stages restic's temporary packs, so only it gets the larger
      // scratch and the memory a tmpfs is charged to.
      expect(hostConfig.Memory, profile).toBe(profile === 'backup' ? 2 * 1024 * 1024 * 1024 : 1024 * 1024 * 1024);
      expect(hostConfig.Tmpfs, profile).toEqual({
        '/tmp': profile === 'backup' ? 'size=512m,mode=1777' : 'size=64m,mode=1777',
      });
      // No bind, no socket, no host path: only named volumes.
      expect(hostConfig.Binds, profile).toBeUndefined();
      for (const mount of hostConfig.Mounts as Array<Record<string, unknown>>) {
        expect(mount.Type, profile).toBe('volume');
        expect(mount.VolumeOptions, profile).toEqual({ NoCopy: true });
      }
    }
  });

  it('gives a capture scratch space that is a multiple of what restic stages, within its memory limit', () => {
    // A 10-core host peaks near 100 MiB of temporary packs for any source size;
    // the 64 MiB the other profiles get failed a 400 MB capture.
    const scratch = Number(/size=(\d+)m/.exec(HELPER_PROFILES.backup.tmpfs['/tmp'])?.[1]) * 1024 * 1024;
    expect(scratch).toBeGreaterThanOrEqual(5 * 100 * 1024 * 1024);
    // A tmpfs is charged to the container's memory, so the limit has to leave
    // room for restic itself beside a full scratch.
    expect(HELPER_PROFILES.backup.memoryBytes).toBeGreaterThanOrEqual(scratch + 1024 * 1024 * 1024);
  });

  it('adds exactly the capabilities each profile was justified for', () => {
    expect(HELPER_PROFILES.probe.capAdd).toEqual([]);
    expect(HELPER_PROFILES.config.capAdd).toEqual([]);
    expect(HELPER_PROFILES.init.capAdd).toEqual([]);
    expect(HELPER_PROFILES.check.capAdd).toEqual([]);
    expect(HELPER_PROFILES.unlock.capAdd).toEqual([]);
    expect(HELPER_PROFILES.backup.capAdd).toEqual(['DAC_READ_SEARCH']);
    // --verify reads restored files back after their ownership is applied.
    expect(HELPER_PROFILES.restore.capAdd).toEqual(['CHOWN', 'FOWNER', 'FSETID', 'DAC_READ_SEARCH']);
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
    for (const profile of ['probe', 'config', 'check', 'restore'] as const) {
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

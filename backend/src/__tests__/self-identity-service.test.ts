/**
 * Unit tests for SelfIdentityService. Covers happy-path inspect, missing
 * HOSTNAME (dev mode), Dockerode 404 (also dev mode), and the isOwn* matchers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockContainer, mockDocker } = vi.hoisted(() => {
  const mockContainer = {
    inspect: vi.fn(),
  };
  const mockDocker = {
    getContainer: vi.fn(() => mockContainer),
    listImages: vi.fn().mockResolvedValue([]),
    listVolumes: vi.fn().mockResolvedValue({ Volumes: [] }),
    listNetworks: vi.fn().mockResolvedValue([]),
    listContainers: vi.fn().mockResolvedValue([]),
  };
  return { mockContainer, mockDocker };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => mockDocker,
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));
vi.mock('util', () => ({ promisify: () => vi.fn() }));

import SelfIdentityService from '../services/SelfIdentityService';

const FULL_CONTAINER_ID = 'a'.repeat(64);
const FULL_IMAGE_ID_HEX = 'b'.repeat(64);
const FULL_NETWORK_ID = 'c'.repeat(64);

const originalHostname = process.env.HOSTNAME;

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset (not clearAllMocks) drops implementations set by prior
  // mockResolvedValue/mockResolvedValueOnce calls, otherwise resolutions
  // leak across tests.
  mockContainer.inspect.mockReset();
  SelfIdentityService.getInstance().resetForTesting();
});

afterEach(() => {
  // restoreAllMocks() puts vi.spyOn'd statics (readContainerIdFromCgroup,
  // console.warn) back to their real implementations so the next test
  // exercises real code paths.
  vi.restoreAllMocks();
  if (originalHostname === undefined) delete process.env.HOSTNAME;
  else process.env.HOSTNAME = originalHostname;
});

describe('SelfIdentityService.initialize', () => {
  it('populates identity when HOSTNAME is set and inspect resolves', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockResolvedValue({
      Id: FULL_CONTAINER_ID,
      Name: '/sencho',
      Image: 'sha256:' + FULL_IMAGE_ID_HEX,
      Config: { Labels: { 'com.docker.compose.project': 'sencho' } },
      NetworkSettings: {
        Networks: {
          sencho_mesh: { NetworkID: FULL_NETWORK_ID },
        },
      },
      Mounts: [
        { Type: 'volume', Name: 'sencho_data' },
        { Type: 'bind', Source: '/host/path', Destination: '/app/compose' },
      ],
    });

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();

    const id = svc.getIdentity();
    expect(id.containerId).toBe(FULL_CONTAINER_ID);
    expect(id.containerName).toBe('sencho');
    expect(id.composeProjectName).toBe('sencho');
    expect(id.imageId).toBe(FULL_IMAGE_ID_HEX);
    expect(id.networkNames).toEqual(['sencho_mesh']);
    expect(id.volumeNames).toEqual(['sencho_data']);
  });

  it('shares an in-flight initialization across concurrent callers', async () => {
    process.env.HOSTNAME = 'sencho-1';
    let resolveInspect: (value: unknown) => void = () => {};
    mockContainer.inspect.mockReturnValue(new Promise(resolve => {
      resolveInspect = resolve;
    }));

    const svc = SelfIdentityService.getInstance();
    const first = svc.initialize();
    const second = svc.initialize();

    expect(mockContainer.inspect).toHaveBeenCalledTimes(1);
    resolveInspect({
      Id: FULL_CONTAINER_ID,
      Name: '/sencho',
      Image: 'sha256:' + FULL_IMAGE_ID_HEX,
      Config: { Labels: { 'com.docker.compose.project': 'sencho' } },
      NetworkSettings: { Networks: { sencho_mesh: { NetworkID: FULL_NETWORK_ID } } },
      Mounts: [{ Type: 'volume', Name: 'sencho_data' }],
    });
    await Promise.all([first, second]);

    expect(svc.getIdentity().containerId).toBe(FULL_CONTAINER_ID);
    expect(svc.getIdentity().composeProjectName).toBe('sencho');
  });

  it('stays empty when HOSTNAME is unset (dev mode)', async () => {
    delete process.env.HOSTNAME;
    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    expect(svc.getIdentity().containerId).toBeNull();
    expect(svc.getIdentity().imageId).toBeNull();
    expect(mockContainer.inspect).not.toHaveBeenCalled();
  });

  it('stays empty when HOSTNAME inspect 404s and cgroup probe has no container ID (dev mode)', async () => {
    process.env.HOSTNAME = 'my-laptop';
    const err: Error & { statusCode?: number } = Object.assign(new Error('no such container'), { statusCode: 404 });
    mockContainer.inspect.mockRejectedValue(err);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    expect(svc.getIdentity().containerId).toBeNull();
  });

  it('falls back to /proc/self/cgroup when HOSTNAME inspect 404s (custom --hostname)', async () => {
    process.env.HOSTNAME = 'my-custom-name';
    const err404: Error & { statusCode?: number } = Object.assign(new Error('no such container'), { statusCode: 404 });
    // First call (HOSTNAME) 404s; second call (cgroup-resolved ID) succeeds.
    mockContainer.inspect
      .mockRejectedValueOnce(err404)
      .mockResolvedValueOnce({
        Id: FULL_CONTAINER_ID,
        Name: '/sencho',
        Image: 'sha256:' + FULL_IMAGE_ID_HEX,
        NetworkSettings: { Networks: { sencho_mesh: { NetworkID: FULL_NETWORK_ID } } },
        Mounts: [{ Type: 'volume', Name: 'sencho_data' }],
      });
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(FULL_CONTAINER_ID);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    expect(svc.getIdentity().containerId).toBe(FULL_CONTAINER_ID);
    expect(mockDocker.getContainer).toHaveBeenNthCalledWith(1, 'my-custom-name');
    expect(mockDocker.getContainer).toHaveBeenNthCalledWith(2, FULL_CONTAINER_ID);
  });

  it('stays empty when HOSTNAME 404s and cgroup probe resolves but inspect 404s on that ID too', async () => {
    process.env.HOSTNAME = 'sencho-1';
    const err404: Error & { statusCode?: number } = Object.assign(new Error('no such container'), { statusCode: 404 });
    mockContainer.inspect.mockRejectedValue(err404);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(FULL_CONTAINER_ID);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    expect(svc.getIdentity().containerId).toBeNull();
  });

  it('stays empty and logs on non-404 inspect failure', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockRejectedValue(new Error('docker daemon unreachable'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    expect(svc.getIdentity().containerId).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('captures the compose service and working directory labels', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockResolvedValue({
      Id: FULL_CONTAINER_ID,
      Name: '/sencho',
      Image: 'sha256:' + FULL_IMAGE_ID_HEX,
      Config: {
        Labels: {
          'com.docker.compose.project': 'sencho',
          'com.docker.compose.service': 'app',
          'com.docker.compose.project.working_dir': '/srv/compose/sencho',
        },
      },
      NetworkSettings: { Networks: {} },
      Mounts: [],
    });

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();

    expect(svc.getComposeLocation()).toEqual({ service: 'app', workingDir: '/srv/compose/sencho' });
  });

  it('reads an empty Compose label as missing', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockResolvedValue({
      Id: FULL_CONTAINER_ID,
      Name: '/sencho',
      Image: 'sha256:' + FULL_IMAGE_ID_HEX,
      Config: {
        Labels: {
          'com.docker.compose.project': '',
          'com.docker.compose.service': '',
          'com.docker.compose.project.working_dir': '',
        },
      },
      NetworkSettings: { Networks: {} },
      Mounts: [],
    });

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();

    expect(svc.getComposeLocation()).toEqual({ service: null, workingDir: null });
    expect(svc.getIdentity().composeProjectName).toBeNull();
  });

  it('parses /proc/self/cgroup formats (cgroupv1 docker, cgroupv2 docker, podman libpod)', async () => {
    const tmp = await import('os');
    const fsp = await import('fs/promises');
    const path = await import('path');
    const dir = await fsp.mkdtemp(path.join(tmp.tmpdir(), 'sencho-cgroup-'));

    const cgroupV1 = path.join(dir, 'cgv1');
    await fsp.writeFile(cgroupV1, `12:cpuset:/docker/${FULL_CONTAINER_ID}\n11:memory:/docker/${FULL_CONTAINER_ID}\n`);
    expect(await SelfIdentityService.readContainerIdFromCgroup(cgroupV1)).toBe(FULL_CONTAINER_ID);

    const cgroupV2 = path.join(dir, 'cgv2');
    await fsp.writeFile(cgroupV2, `0::/system.slice/docker-${FULL_CONTAINER_ID}.scope\n`);
    expect(await SelfIdentityService.readContainerIdFromCgroup(cgroupV2)).toBe(FULL_CONTAINER_ID);

    const podman = path.join(dir, 'podman');
    await fsp.writeFile(podman, `0::/user.slice/user-1000.slice/libpod-${FULL_CONTAINER_ID}.scope\n`);
    expect(await SelfIdentityService.readContainerIdFromCgroup(podman)).toBe(FULL_CONTAINER_ID);

    const noMatch = path.join(dir, 'empty');
    await fsp.writeFile(noMatch, '0::/system.slice/sshd.service\n');
    expect(await SelfIdentityService.readContainerIdFromCgroup(noMatch)).toBeNull();

    expect(await SelfIdentityService.readContainerIdFromCgroup(path.join(dir, 'does-not-exist'))).toBeNull();
    // A directory is a read error, not "not found": it must surface.
    await expect(SelfIdentityService.readContainerIdFromCgroup(dir)).rejects.toThrow();

    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('parses the container id from the engine bind mounts in /proc/self/mountinfo', async () => {
    const tmp = await import('os');
    const fsp = await import('fs/promises');
    const path = await import('path');
    const dir = await fsp.mkdtemp(path.join(tmp.tmpdir(), 'sencho-mountinfo-'));

    const info = path.join(dir, 'mountinfo');
    await fsp.writeFile(info, [
      '1001 995 8:1 /var/lib/docker/containers/' + FULL_CONTAINER_ID + '/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/sda1 rw',
      '1002 995 8:1 /var/lib/docker/containers/' + FULL_CONTAINER_ID + '/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw',
    ].join('\n'));
    expect(await SelfIdentityService.readContainerIdFromMountinfo(info)).toBe(FULL_CONTAINER_ID);

    const none = path.join(dir, 'none');
    await fsp.writeFile(none, '22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n');
    expect(await SelfIdentityService.readContainerIdFromMountinfo(none)).toBeNull();
    expect(await SelfIdentityService.readContainerIdFromMountinfo(path.join(dir, 'does-not-exist'))).toBeNull();
    // A directory is not "not found": it is a read error and must surface.
    await expect(SelfIdentityService.readContainerIdFromMountinfo(dir)).rejects.toThrow();

    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('resolves through mountinfo when HOSTNAME is custom and the cgroup shows no id (cgroup v2 private namespace)', async () => {
    process.env.HOSTNAME = 'sencho';
    const err404: Error & { statusCode?: number } = Object.assign(new Error('no such container'), { statusCode: 404 });
    mockContainer.inspect
      .mockRejectedValueOnce(err404)
      .mockResolvedValueOnce({
        Id: FULL_CONTAINER_ID,
        Name: '/sencho',
        Image: 'sha256:' + FULL_IMAGE_ID_HEX,
        Config: { Labels: { 'com.docker.compose.project': 'sencho' } },
        NetworkSettings: { Networks: {} },
        Mounts: [],
      });
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(FULL_CONTAINER_ID);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    expect(svc.getState()).toBe('resolved');
    expect(svc.getIdentity().containerId).toBe(FULL_CONTAINER_ID);
    expect(mockDocker.getContainer).toHaveBeenNthCalledWith(2, FULL_CONTAINER_ID);
  });

  it('is unresolved, retried, and not cached as "not in Docker" when the cgroup cannot be read', async () => {
    process.env.HOSTNAME = 'sencho';
    mockContainer.inspect.mockRejectedValue(Object.assign(new Error('no such container'), { statusCode: 404 }));
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);
    const cgroup = vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup')
      .mockRejectedValueOnce(Object.assign(new Error('input/output error'), { code: 'EIO' }))
      .mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    expect(await svc.ensureResolved()).toBe('unresolved');
    expect(svc.getUnresolvedReason()).toContain('cgroup read failed');
    expect(await svc.ensureResolved()).toBe('none');
    expect(cgroup).toHaveBeenCalledTimes(2);
  });

  it('is unresolved, retried, and not cached as "not in Docker" when mountinfo cannot be read', async () => {
    process.env.HOSTNAME = 'sencho';
    mockContainer.inspect.mockRejectedValue(Object.assign(new Error('no such container'), { statusCode: 404 }));
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    const mountinfo = vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo')
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      .mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    expect(await svc.ensureResolved()).toBe('unresolved');
    expect(svc.getUnresolvedReason()).toContain('mountinfo read failed');
    expect(await svc.ensureResolved()).toBe('none');
    expect(mountinfo).toHaveBeenCalledTimes(2);
  });

  it('is idempotent: re-initialize is a no-op', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockResolvedValue({
      Id: FULL_CONTAINER_ID,
      Name: '/sencho',
      Image: 'sha256:' + FULL_IMAGE_ID_HEX,
      NetworkSettings: { Networks: {} },
      Mounts: [],
    });

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    await svc.initialize();
    expect(mockContainer.inspect).toHaveBeenCalledTimes(1);
  });
});

describe('SelfIdentityService matchers', () => {
  beforeEach(async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockResolvedValue({
      Id: FULL_CONTAINER_ID,
      Name: '/sencho',
      Image: 'sha256:' + FULL_IMAGE_ID_HEX,
      NetworkSettings: {
        Networks: { sencho_mesh: { NetworkID: FULL_NETWORK_ID } },
      },
      Mounts: [{ Type: 'volume', Name: 'sencho_data' }],
    });
    SelfIdentityService.getInstance().resetForTesting();
    await SelfIdentityService.getInstance().initialize();
  });

  it('isOwnImage matches full sha256 ref, hex-only, and short prefix', () => {
    const svc = SelfIdentityService.getInstance();
    expect(svc.isOwnImage('sha256:' + FULL_IMAGE_ID_HEX)).toBe(true);
    expect(svc.isOwnImage(FULL_IMAGE_ID_HEX)).toBe(true);
    expect(svc.isOwnImage(FULL_IMAGE_ID_HEX.slice(0, 12))).toBe(true);
    expect(svc.isOwnImage('d'.repeat(64))).toBe(false);
  });

  it('isOwnImage does not match repo:tag strings (callers should pass IDs)', () => {
    const svc = SelfIdentityService.getInstance();
    expect(svc.isOwnImage('ghcr.io/studio-saelix/sencho:latest')).toBe(false);
    expect(svc.isOwnImage('saelix/sencho:1.0')).toBe(false);
  });

  it('isOwnNetwork matches by ID and by name', () => {
    const svc = SelfIdentityService.getInstance();
    expect(svc.isOwnNetwork(FULL_NETWORK_ID)).toBe(true);
    expect(svc.isOwnNetwork(FULL_NETWORK_ID.slice(0, 12))).toBe(true);
    expect(svc.isOwnNetwork('sencho_mesh')).toBe(true);
    expect(svc.isOwnNetwork('bridge')).toBe(false);
  });

  it('isOwnNetwork does not falsely match a non-hex network name that overlaps a cached ID prefix', () => {
    // The cached network ID is 64 chars of 'c'. A network named "ccc" is NOT
    // a hex ID input (length below 12), so prefix matching must not fire.
    const svc = SelfIdentityService.getInstance();
    expect(svc.isOwnNetwork('ccc')).toBe(false);
    expect(svc.isOwnNetwork('cc')).toBe(false);
  });

  it('isOwnVolume matches by name only', () => {
    const svc = SelfIdentityService.getInstance();
    expect(svc.isOwnVolume('sencho_data')).toBe(true);
    expect(svc.isOwnVolume('other_volume')).toBe(false);
  });

  it('isOwnContainer matches full, short prefix, and name', () => {
    const svc = SelfIdentityService.getInstance();
    expect(svc.isOwnContainer(FULL_CONTAINER_ID)).toBe(true);
    expect(svc.isOwnContainer(FULL_CONTAINER_ID.slice(0, 12))).toBe(true);
    expect(svc.isOwnContainer('sencho')).toBe(true);
    expect(svc.isOwnContainer('e'.repeat(64))).toBe(false);
  });
});

describe('SelfIdentityService matchers when empty (dev mode)', () => {
  beforeEach(async () => {
    delete process.env.HOSTNAME;
    SelfIdentityService.getInstance().resetForTesting();
    await SelfIdentityService.getInstance().initialize();
  });

  it('returns false for every isOwn* call so today\'s behavior is preserved', () => {
    const svc = SelfIdentityService.getInstance();
    expect(svc.isOwnImage('sha256:' + FULL_IMAGE_ID_HEX)).toBe(false);
    expect(svc.isOwnNetwork('sencho_mesh')).toBe(false);
    expect(svc.isOwnVolume('sencho_data')).toBe(false);
    expect(svc.isOwnContainer(FULL_CONTAINER_ID)).toBe(false);
  });
});

describe('SelfIdentityService identity state', () => {
  const inspectResult = {
    Id: FULL_CONTAINER_ID,
    Name: '/sencho',
    Image: 'sha256:' + FULL_IMAGE_ID_HEX,
    Config: { Labels: { 'com.docker.compose.project': 'sencho' } },
    NetworkSettings: { Networks: {} },
    Mounts: [],
  };

  it('is unresolved, not none, when Docker did not answer the probes', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockRejectedValue(new Error('403 forbidden'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();

    expect(svc.getState()).toBe('unresolved');
    expect(svc.getUnresolvedReason()).toContain('403 forbidden');
  });

  it('is none, and stays none without asking Docker again, when the probes answer "not a container"', async () => {
    process.env.HOSTNAME = 'my-laptop';
    mockContainer.inspect.mockRejectedValue(Object.assign(new Error('no such container'), { statusCode: 404 }));
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    expect(await svc.ensureResolved()).toBe('none');
    expect(await svc.ensureResolved()).toBe('none');
    await svc.initialize();

    expect(mockContainer.inspect).toHaveBeenCalledTimes(1);
    expect(svc.getUnresolvedReason()).toBeNull();
  });

  it('still tries the cgroup id after a non-404 HOSTNAME failure', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect
      .mockRejectedValueOnce(new Error('temporary proxy error'))
      .mockResolvedValueOnce(inspectResult);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(FULL_CONTAINER_ID);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();

    expect(svc.getState()).toBe('resolved');
    expect(svc.getIdentity().containerId).toBe(FULL_CONTAINER_ID);
    expect(mockDocker.getContainer).toHaveBeenNthCalledWith(2, FULL_CONTAINER_ID);
  });

  it('is unresolved, not none, when HOSTNAME is not a container and the cgroup id inspect fails', async () => {
    process.env.HOSTNAME = 'custom-hostname';
    mockContainer.inspect
      .mockRejectedValueOnce(Object.assign(new Error('no such container'), { statusCode: 404 }))
      .mockRejectedValueOnce(new Error('403 forbidden'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(FULL_CONTAINER_ID);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();

    expect(svc.getState()).toBe('unresolved');
    expect(svc.getUnresolvedReason()).toContain('cgroup inspect failed');
  });

  it('is unresolved, never the "not a container" default, when identification itself throws, and recovers', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockResolvedValue(inspectResult);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cgroup = vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockRejectedValueOnce(new Error('proc unreadable'));
    mockContainer.inspect.mockRejectedValueOnce(Object.assign(new Error('no such container'), { statusCode: 404 }));

    const svc = SelfIdentityService.getInstance();
    expect(await svc.ensureResolved()).toBe('unresolved');
    expect(svc.getUnresolvedReason()).toContain('proc unreadable');

    cgroup.mockResolvedValue(FULL_CONTAINER_ID);
    expect(await svc.ensureResolved()).toBe('resolved');
  });

  it('does not cache a failure: ensureResolved retries at once and recovers', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(inspectResult);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    expect(svc.getState()).toBe('unresolved');

    expect(await svc.ensureResolved()).toBe('resolved');
    expect(svc.isOwnContainer(FULL_CONTAINER_ID)).toBe(true);
    expect(svc.getUnresolvedReason()).toBeNull();
  });

  it('keeps a plain initialize() from re-asking Docker on every call inside the retry gap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      process.env.HOSTNAME = 'sencho-1';
      mockContainer.inspect.mockRejectedValue(new Error('connection reset'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

      const svc = SelfIdentityService.getInstance();
      await svc.initialize();
      await svc.initialize();
      expect(mockContainer.inspect).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 6_000);
      mockContainer.inspect.mockResolvedValue(inspectResult);
      await svc.initialize();

      expect(mockContainer.inspect).toHaveBeenCalledTimes(2);
      expect(svc.getState()).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never downgrades a resolved identity', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockResolvedValue(inspectResult);

    const svc = SelfIdentityService.getInstance();
    await svc.initialize();
    mockContainer.inspect.mockRejectedValue(new Error('boom'));

    expect(await svc.ensureResolved()).toBe('resolved');
    expect(mockContainer.inspect).toHaveBeenCalledTimes(1);
  });

  it('getBindMounts reports an unresolved identity as unverified, not as "not containerized"', async () => {
    process.env.HOSTNAME = 'sencho-1';
    mockContainer.inspect.mockRejectedValue(new Error('connection reset'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);

    await expect(SelfIdentityService.getInstance().getBindMounts()).rejects.toThrow('cannot read mounts');
  });
});


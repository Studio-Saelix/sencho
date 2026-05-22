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

vi.mock('child_process', () => ({ exec: vi.fn() }));
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
    expect(id.imageId).toBe(FULL_IMAGE_ID_HEX);
    expect(id.networkNames).toEqual(['sencho_mesh']);
    expect(id.volumeNames).toEqual(['sencho_data']);
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

    await fsp.rm(dir, { recursive: true, force: true });
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

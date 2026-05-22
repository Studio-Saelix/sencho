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
  SelfIdentityService.getInstance().resetForTesting();
});

afterEach(() => {
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

  it('stays empty when inspect throws 404 (Sencho process running outside Docker)', async () => {
    process.env.HOSTNAME = 'my-laptop';
    const err: Error & { statusCode?: number } = Object.assign(new Error('no such container'), { statusCode: 404 });
    mockContainer.inspect.mockRejectedValue(err);

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

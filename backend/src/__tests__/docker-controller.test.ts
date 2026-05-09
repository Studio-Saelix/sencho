/**
 * Unit tests for DockerController — validateApiData, state-safe container ops,
 * disk usage, classified resources, orphan detection, and error paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockDocker } = vi.hoisted(() => {
  const mockDocker = {
    df: vi.fn(),
    listImages: vi.fn().mockResolvedValue([]),
    listVolumes: vi.fn().mockResolvedValue({ Volumes: [] }),
    listNetworks: vi.fn().mockResolvedValue([]),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn(),
    getImage: vi.fn(),
    getVolume: vi.fn(),
    getNetwork: vi.fn(),
    pruneContainers: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    pruneImages: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    pruneNetworks: vi.fn().mockResolvedValue({}),
    pruneVolumes: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    createNetwork: vi.fn(),
  };
  return { mockDocker };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => mockDocker,
      getDefaultNodeId: () => 1,
    }),
  },
}));

// Prevent COMPOSE_DIR related issues
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => vi.fn(),
}));

import DockerController from '../services/DockerController';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── validateApiData ────────────────────────────────────────────────────

describe('DockerController - validateApiData', () => {
  it('throws when response is a string (HTML from wrong port)', async () => {
    mockDocker.listImages.mockResolvedValue('<html>Not Docker</html>');

    const dc = DockerController.getInstance(1);
    await expect(dc.getImages()).rejects.toThrow('Invalid response from Docker API');
  });

  it('passes through valid object data', async () => {
    const imageData = [{ Id: 'sha256:abc', RepoTags: ['nginx:latest'], Size: 100 }];
    mockDocker.listImages.mockResolvedValue(imageData);

    const dc = DockerController.getInstance(1);
    const result = await dc.getImages();
    expect(result).toEqual(imageData);
  });
});

// ── State-safe container operations ────────────────────────────────────

describe('DockerController - startContainer', () => {
  it('starts a container successfully', async () => {
    const mockStart = vi.fn().mockResolvedValue(undefined);
    mockDocker.getContainer.mockReturnValue({ start: mockStart });

    const dc = DockerController.getInstance(1);
    await dc.startContainer('abc123');

    expect(mockStart).toHaveBeenCalled();
  });

  it('silently ignores 304 already-started error', async () => {
    const mockStart = vi.fn().mockRejectedValue({ statusCode: 304 });
    mockDocker.getContainer.mockReturnValue({ start: mockStart });

    const dc = DockerController.getInstance(1);
    await expect(dc.startContainer('abc123')).resolves.toBeUndefined();
  });

  it('rethrows other errors', async () => {
    const mockStart = vi.fn().mockRejectedValue(new Error('container not found'));
    mockDocker.getContainer.mockReturnValue({ start: mockStart });

    const dc = DockerController.getInstance(1);
    await expect(dc.startContainer('abc123')).rejects.toThrow('container not found');
  });
});

describe('DockerController - stopContainer', () => {
  it('stops a container successfully', async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    mockDocker.getContainer.mockReturnValue({ stop: mockStop });

    const dc = DockerController.getInstance(1);
    await dc.stopContainer('abc123');

    expect(mockStop).toHaveBeenCalled();
  });

  it('silently ignores 304 already-stopped error', async () => {
    const mockStop = vi.fn().mockRejectedValue({ statusCode: 304 });
    mockDocker.getContainer.mockReturnValue({ stop: mockStop });

    const dc = DockerController.getInstance(1);
    await expect(dc.stopContainer('abc123')).resolves.toBeUndefined();
  });

  it('rethrows other errors', async () => {
    const err = new Error('permission denied');
    const mockStop = vi.fn().mockRejectedValue(err);
    mockDocker.getContainer.mockReturnValue({ stop: mockStop });

    const dc = DockerController.getInstance(1);
    await expect(dc.stopContainer('abc123')).rejects.toThrow('permission denied');
  });
});

// ── removeContainers ───────────────────────────────────────────────────

describe('DockerController - removeContainers', () => {
  it('removes multiple containers and returns results', async () => {
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    mockDocker.getContainer.mockReturnValue({ remove: mockRemove });

    const dc = DockerController.getInstance(1);
    const results = await dc.removeContainers(['c1', 'c2']);

    expect(results).toEqual([
      { id: 'c1', success: true },
      { id: 'c2', success: true },
    ]);
  });

  it('returns failure result for containers that cannot be removed', async () => {
    let callCount = 0;
    mockDocker.getContainer.mockImplementation(() => ({
      remove: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('in use');
        return Promise.resolve();
      }),
    }));

    const dc = DockerController.getInstance(1);
    const results = await dc.removeContainers(['c1', 'c2']);

    expect(results[0]).toEqual({ id: 'c1', success: true });
    expect(results[1]).toMatchObject({ id: 'c2', success: false, error: 'in use' });
  });
});

// ── getDiskUsage ───────────────────────────────────────────────────────

describe('DockerController - getDiskUsage', () => {
  it('calculates reclaimable space correctly', async () => {
    mockDocker.df.mockResolvedValue({
      Images: [
        { Id: 'img1', Containers: 0, Size: 500 },       // reclaimable (unused)
        { Id: 'img2', Containers: 1, Size: 300 },       // not reclaimable (in use)
      ],
      Containers: [
        { State: 'running', SizeRw: 100 },              // not reclaimable (running)
        { State: 'exited', SizeRw: 200 },                // reclaimable (stopped)
      ],
      Volumes: [
        { UsageData: { RefCount: 0, Size: 400 } },      // reclaimable (unused)
        { UsageData: { RefCount: 1, Size: 300 } },      // not reclaimable (in use)
      ],
      BuildCache: [
        { ID: 'bc1', InUse: false, Size: 600 },          // reclaimable
        { ID: 'bc2', InUse: true, Size: 250 },           // not reclaimable
      ],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableImages).toBe(500);
    expect(usage.reclaimableContainers).toBe(200);
    expect(usage.reclaimableVolumes).toBe(400);
    expect(usage.reclaimableBuildCache).toBe(600);
    expect(usage.reclaimableBuildCacheCount).toBe(1);
  });

  it('handles empty arrays gracefully', async () => {
    mockDocker.df.mockResolvedValue({
      Images: [],
      Containers: [],
      Volumes: [],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableImages).toBe(0);
    expect(usage.reclaimableContainers).toBe(0);
    expect(usage.reclaimableVolumes).toBe(0);
  });

  it('handles missing fields gracefully', async () => {
    mockDocker.df.mockResolvedValue({});

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableImages).toBe(0);
    expect(usage.reclaimableContainers).toBe(0);
    expect(usage.reclaimableVolumes).toBe(0);
  });
});

// ── pruneSystem ────────────────────────────────────────────────────────

describe('DockerController - pruneSystem', () => {
  it('prunes containers and returns reclaimed bytes', async () => {
    mockDocker.pruneContainers.mockResolvedValue({ SpaceReclaimed: 1024 });

    const dc = DockerController.getInstance(1);
    const result = await dc.pruneSystem('containers');

    expect(result).toEqual({ success: true, reclaimedBytes: 1024 });
  });

  it('prunes images with dangling false filter', async () => {
    mockDocker.pruneImages.mockResolvedValue({ SpaceReclaimed: 2048 });

    const dc = DockerController.getInstance(1);
    await dc.pruneSystem('images');

    expect(mockDocker.pruneImages).toHaveBeenCalledWith({
      filters: expect.objectContaining({ dangling: { 'false': true } }),
    });
  });

  it('includes label filter when provided', async () => {
    mockDocker.pruneContainers.mockResolvedValue({ SpaceReclaimed: 0 });

    const dc = DockerController.getInstance(1);
    await dc.pruneSystem('containers', 'com.example=true');

    expect(mockDocker.pruneContainers).toHaveBeenCalledWith({
      filters: { label: ['com.example=true'] },
    });
  });

  it('prunes volumes with all true filter', async () => {
    mockDocker.pruneVolumes.mockResolvedValue({ SpaceReclaimed: 4096 });

    const dc = DockerController.getInstance(1);
    await dc.pruneSystem('volumes');

    expect(mockDocker.pruneVolumes).toHaveBeenCalledWith({
      filters: { all: ['true'] },
    });
  });
});

// ── getClassifiedResources ─────────────────────────────────────────────

describe('DockerController - getClassifiedResources', () => {
  it('classifies managed and unmanaged images', async () => {
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img1', RepoTags: ['nginx:latest'], Size: 100, Containers: 1 },
      { Id: 'img2', RepoTags: ['redis:latest'], Size: 200, Containers: 1 },
      { Id: 'img3', RepoTags: ['old:v1'], Size: 50, Containers: 0 },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      { ImageID: 'img1', Labels: { 'com.docker.compose.project': 'my-stack' } },
      { ImageID: 'img2', Labels: { 'com.docker.compose.project': 'unknown-stack' } },
    ]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [] });
    mockDocker.listNetworks.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getClassifiedResources(['my-stack']);

    const managed = result.images.find(i => i.Id === 'img1');
    expect(managed!.managedStatus).toBe('managed');
    expect(managed!.managedBy).toBe('my-stack');

    const unmanaged = result.images.find(i => i.Id === 'img2');
    expect(unmanaged!.managedStatus).toBe('unmanaged');

    const unused = result.images.find(i => i.Id === 'img3');
    expect(unused!.managedStatus).toBe('unused');
  });

  it('classifies system networks', async () => {
    mockDocker.listImages.mockResolvedValue([]);
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [] });
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
      { Id: 'n2', Name: 'host', Driver: 'host', Scope: 'local' },
      { Id: 'n3', Name: 'none', Driver: 'null', Scope: 'local' },
      { Id: 'n4', Name: 'my-stack_default', Driver: 'bridge', Scope: 'local', Labels: { 'com.docker.compose.project': 'my-stack' } },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getClassifiedResources(['my-stack']);

    expect(result.networks.filter(n => n.managedStatus === 'system')).toHaveLength(3);
    expect(result.networks.find(n => n.Name === 'my-stack_default')!.managedStatus).toBe('managed');
  });

  it('classifies managed and unmanaged volumes', async () => {
    mockDocker.listImages.mockResolvedValue([]);
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.listNetworks.mockResolvedValue([]);
    mockDocker.listVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'my-stack_data', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/my-stack_data', Labels: { 'com.docker.compose.project': 'my-stack' } },
        { Name: 'random_vol', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/random', Labels: {} },
      ],
    });

    const dc = DockerController.getInstance(1);
    const result = await dc.getClassifiedResources(['my-stack']);

    expect(result.volumes.find(v => v.Name === 'my-stack_data')!.managedStatus).toBe('managed');
    expect(result.volumes.find(v => v.Name === 'random_vol')!.managedStatus).toBe('unmanaged');
  });
});

// ── getOrphanContainers ────────────────────────────────────────────────

describe('DockerController - getOrphanContainers', () => {
  it('returns containers whose project label is not in known stacks', async () => {
    mockDocker.listContainers.mockResolvedValue([
      { Id: 'c1', Names: ['/c1'], State: 'running', Status: 'Up', Image: 'nginx', Labels: { 'com.docker.compose.project': 'orphan-stack' } },
      { Id: 'c2', Names: ['/c2'], State: 'running', Status: 'Up', Image: 'redis', Labels: { 'com.docker.compose.project': 'known-stack' } },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getOrphanContainers(['known-stack']);

    expect(result['orphan-stack']).toHaveLength(1);
    expect(result['orphan-stack'][0].Id).toBe('c1');
    expect(result['known-stack']).toBeUndefined();
  });

  it('returns empty when all containers belong to known stacks', async () => {
    mockDocker.listContainers.mockResolvedValue([
      { Id: 'c1', Names: ['/c1'], State: 'running', Status: 'Up', Image: 'nginx', Labels: { 'com.docker.compose.project': 'my-stack' } },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getOrphanContainers(['my-stack']);

    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ── Docker daemon unreachable ──────────────────────────────────────────

describe('DockerController - error paths', () => {
  it('propagates connection errors from Docker daemon', async () => {
    mockDocker.listContainers.mockRejectedValue(
      new Error('connect ECONNREFUSED /var/run/docker.sock')
    );

    const dc = DockerController.getInstance(1);
    await expect(dc.getOrphanContainers(['x'])).rejects.toThrow('ECONNREFUSED');
  });

  it('propagates errors from df() call', async () => {
    mockDocker.df.mockRejectedValue(new Error('daemon not running'));

    const dc = DockerController.getInstance(1);
    await expect(dc.getDiskUsage()).rejects.toThrow('daemon not running');
  });
});

// ── inspectNetwork ────────────────────────────────────────────────────

describe('DockerController - inspectNetwork', () => {
  it('returns full network details from Docker API', async () => {
    const inspectData = {
      Id: 'abc123',
      Name: 'my-network',
      Driver: 'bridge',
      Scope: 'local',
      IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] },
      Containers: {
        'ctr1': { Name: 'web', IPv4Address: '172.20.0.2/16', MacAddress: '02:42:ac:14:00:02' },
      },
    };
    mockDocker.getNetwork.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectData) });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectNetwork('abc123');

    expect(result).toEqual(inspectData);
    expect(mockDocker.getNetwork).toHaveBeenCalledWith('abc123');
  });

  it('propagates errors when network not found', async () => {
    mockDocker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error('network not found')),
    });

    const dc = DockerController.getInstance(1);
    await expect(dc.inspectNetwork('nonexistent')).rejects.toThrow('network not found');
  });
});

// ── createNetwork ─────────────────────────────────────────────────────

describe('DockerController - createNetwork', () => {
  it('creates a network with valid options', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'new-net-123' });

    const dc = DockerController.getInstance(1);
    const result = await dc.createNetwork({ Name: 'test-network', Driver: 'bridge' });

    expect(result).toEqual({ id: 'new-net-123' });
    expect(mockDocker.createNetwork).toHaveBeenCalledWith({ Name: 'test-network', Driver: 'bridge' });
  });

  it('rejects empty network name', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '' })).rejects.toThrow('Invalid network name');
  });

  it('rejects network name with invalid characters', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '../escape' })).rejects.toThrow('Invalid network name');
  });

  it('accepts names with hyphens, underscores, and dots', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'ok-123' });

    const dc = DockerController.getInstance(1);
    await dc.createNetwork({ Name: 'my-net_v2.0' });

    expect(mockDocker.createNetwork).toHaveBeenCalledWith({ Name: 'my-net_v2.0' });
  });

  it('propagates Docker daemon errors', async () => {
    mockDocker.createNetwork.mockRejectedValue(new Error('network with name test already exists'));

    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: 'test' })).rejects.toThrow('already exists');
  });

  it('rejects names starting with a dot', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '.hidden' })).rejects.toThrow('Invalid network name');
  });

  it('rejects names starting with a hyphen', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '-leading-dash' })).rejects.toThrow('Invalid network name');
  });

  it('rejects names with spaces', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: 'has spaces' })).rejects.toThrow('Invalid network name');
  });

  it('rejects names with slashes (path traversal)', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: 'foo/bar' })).rejects.toThrow('Invalid network name');
  });

  it('passes IPAM config through to Docker', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'ipam-net' });

    const dc = DockerController.getInstance(1);
    const options = {
      Name: 'ipam-test',
      Driver: 'bridge' as const,
      IPAM: { Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1' }] },
      Internal: true,
      Attachable: true,
    };
    await dc.createNetwork(options);

    expect(mockDocker.createNetwork).toHaveBeenCalledWith(options);
  });

  it('passes labels through to Docker', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'labeled-net' });

    const dc = DockerController.getInstance(1);
    const options = {
      Name: 'labeled',
      Labels: { env: 'test', team: 'infra' },
    };
    await dc.createNetwork(options);

    expect(mockDocker.createNetwork).toHaveBeenCalledWith(options);
  });

  it('accepts single-character name', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'single' });

    const dc = DockerController.getInstance(1);
    await dc.createNetwork({ Name: 'a' });

    expect(mockDocker.createNetwork).toHaveBeenCalledWith({ Name: 'a' });
  });
});

// ── inspectNetwork edge cases ─────────────────────────────────────────

describe('DockerController - inspectNetwork edge cases', () => {
  it('returns network with empty containers map', async () => {
    const inspectData = {
      Id: 'empty-net',
      Name: 'isolated',
      Driver: 'bridge',
      Containers: {},
    };
    mockDocker.getNetwork.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectData) });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectNetwork('empty-net');

    expect(result.Containers).toEqual({});
  });

  it('returns network with multiple containers', async () => {
    const inspectData = {
      Id: 'multi-net',
      Name: 'busy-network',
      Driver: 'bridge',
      Containers: {
        'c1': { Name: 'web', IPv4Address: '172.20.0.2/16' },
        'c2': { Name: 'db', IPv4Address: '172.20.0.3/16' },
        'c3': { Name: 'cache', IPv4Address: '172.20.0.4/16' },
      },
    };
    mockDocker.getNetwork.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectData) });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectNetwork('multi-net');

    expect(Object.keys(result.Containers ?? {})).toHaveLength(3);
  });

  it('propagates Docker daemon connection errors', async () => {
    mockDocker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error('Cannot connect to Docker daemon')),
    });

    const dc = DockerController.getInstance(1);
    await expect(dc.inspectNetwork('any-id')).rejects.toThrow('Cannot connect to Docker daemon');
  });
});

// --- inspectImage --------------------------------------------------------------

describe('DockerController - inspectImage', () => {
  it('returns combined inspect + history payload', async () => {
    const inspectData = {
      Id: 'sha256:abc12345',
      RepoTags: ['nginx:1.27'],
      Size: 187_000_000,
      Architecture: 'amd64',
      Os: 'linux',
      Config: { Cmd: ['nginx', '-g', 'daemon off;'] },
    };
    const historyData = [
      { Id: 'layer1', Created: 1700000000, CreatedBy: '/bin/sh -c #(nop) ADD file:abc', Size: 72_000_000, Tags: null, Comment: '' },
      { Id: 'layer2', Created: 1700000010, CreatedBy: 'ENV NGINX_VERSION=1.27', Size: 0, Tags: null, Comment: '' },
    ];
    mockDocker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue(inspectData),
      history: vi.fn().mockResolvedValue(historyData),
    });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectImage('sha256:abc12345');

    expect(result.inspect).toEqual(inspectData);
    expect(result.history).toEqual(historyData);
    expect(mockDocker.getImage).toHaveBeenCalledWith('sha256:abc12345');
  });

  it('propagates 404 from Dockerode when image is missing', async () => {
    mockDocker.getImage.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(Object.assign(new Error('No such image: missing'), { statusCode: 404 })),
      history: vi.fn().mockResolvedValue([]),
    });

    const dc = DockerController.getInstance(1);
    await expect(dc.inspectImage('missing')).rejects.toThrow('No such image');
  });

  it('returns empty history when an image has none', async () => {
    mockDocker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: 'sha256:empty', Size: 0 }),
      history: vi.fn().mockResolvedValue([]),
    });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectImage('sha256:empty');

    expect(result.history).toEqual([]);
    expect(result.inspect.Id).toBe('sha256:empty');
  });
});

// --- createNetwork validation --------------------------------------------------

describe('createNetwork', () => {
  it('rejects empty network name', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '' })).rejects.toThrow('Invalid network name');
  });

  it('rejects names with invalid characters', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: 'net work' })).rejects.toThrow('Invalid network name');
    await expect(dc.createNetwork({ Name: '../escape' })).rejects.toThrow('Invalid network name');
    await expect(dc.createNetwork({ Name: 'net;rm' })).rejects.toThrow('Invalid network name');
  });

  it('accepts valid network names and passes through to Docker', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'new-net-id' });
    const dc = DockerController.getInstance(1);
    const result = await dc.createNetwork({ Name: 'my-network_v2' });
    expect(result.id).toBe('new-net-id');
    expect(mockDocker.createNetwork).toHaveBeenCalledWith({ Name: 'my-network_v2' });
  });
});

// --- removeContainers mixed results -------------------------------------------

describe('removeContainers', () => {
  it('returns mixed results when some removals fail', async () => {
    mockDocker.getContainer.mockImplementation((id: string) => {
      if (id === 'fail-id') {
        return { remove: vi.fn().mockRejectedValue(new Error('no such container')) };
      }
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });

    const dc = DockerController.getInstance(1);
    const results = await dc.removeContainers(['ok-id-000000', 'fail-id']);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: 'ok-id-000000', success: true });
    expect(results[1]).toMatchObject({ id: 'fail-id', success: false });
  });

  it('returns empty array for empty input', async () => {
    const dc = DockerController.getInstance(1);
    const results = await dc.removeContainers([]);
    expect(results).toEqual([]);
  });
});

// ── Network connect / disconnect helpers ───────────────────────────────

describe('DockerController - connectContainerToNetwork', () => {
  it('attaches a container to a network with no static IP', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234');

    expect(mockDocker.getNetwork).toHaveBeenCalledWith('sencho_mesh');
    expect(connect).toHaveBeenCalledWith({ Container: 'sencho-host-1234' });
  });

  it('attaches with a static IPv4 address when provided', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234', { ipv4Address: '172.30.0.2' });

    expect(connect).toHaveBeenCalledWith({
      Container: 'sencho-host-1234',
      EndpointConfig: { IPAMConfig: { IPv4Address: '172.30.0.2' } },
    });
  });

  it('treats 403 already-connected as success (idempotent)', async () => {
    const connect = vi.fn().mockRejectedValue({ statusCode: 403, message: 'endpoint already exists' });
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await expect(dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234')).resolves.toBeUndefined();
  });

  it('rethrows non-idempotent errors', async () => {
    const connect = vi.fn().mockRejectedValue({ statusCode: 500, message: 'server error' });
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await expect(dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234')).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it('rethrows a 403 whose message is unrelated to already-attached', async () => {
    const connect = vi.fn().mockRejectedValue({ statusCode: 403, message: 'host-mode container cannot join network' });
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await expect(dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234')).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('DockerController - disconnectContainerFromNetwork', () => {
  it('detaches a container from a network with force=true', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    mockDocker.getNetwork.mockReturnValue({ disconnect });

    const dc = DockerController.getInstance(1);
    await dc.disconnectContainerFromNetwork('sencho_mesh', 'sencho-host-1234');

    expect(mockDocker.getNetwork).toHaveBeenCalledWith('sencho_mesh');
    expect(disconnect).toHaveBeenCalledWith({ Container: 'sencho-host-1234', Force: true });
  });

  it('treats 404 not-connected as success (idempotent)', async () => {
    const disconnect = vi.fn().mockRejectedValue({ statusCode: 404, message: 'no such network endpoint' });
    mockDocker.getNetwork.mockReturnValue({ disconnect });

    const dc = DockerController.getInstance(1);
    await expect(dc.disconnectContainerFromNetwork('sencho_mesh', 'sencho-host-1234')).resolves.toBeUndefined();
  });

  it('rethrows non-idempotent errors', async () => {
    const disconnect = vi.fn().mockRejectedValue({ statusCode: 500, message: 'server error' });
    mockDocker.getNetwork.mockReturnValue({ disconnect });

    const dc = DockerController.getInstance(1);
    await expect(dc.disconnectContainerFromNetwork('sencho_mesh', 'sencho-host-1234')).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

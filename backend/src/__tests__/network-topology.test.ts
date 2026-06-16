/**
 * Unit tests for DockerController.getTopologyData() - network topology
 * data assembly, filtering, container-to-network mapping, and edge cases.
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

// Prevent COMPOSE_DIR filesystem reads (resolveProjectNameMap reads compose files).
// With these mocked, fs.readFile returns ENOENT and the map falls back to
// { stackName: stackName } for each stack passed in.
vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));
vi.mock('util', () => ({ promisify: () => vi.fn() }));

import DockerController from '../services/DockerController';
import { CacheService } from '../services/CacheService';

beforeEach(() => {
  vi.clearAllMocks();
  // The project-name-map is cached for 60 seconds. Invalidate between tests so
  // that different stack-name inputs do not leak across tests.
  CacheService.getInstance().invalidate('project-name-map');
});

// ── Basic happy path ──────────────────────────────────────────────────

describe('DockerController.getTopologyData - basic', () => {
  it('returns networks with their containers', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      {
        Id: 'net-a',
        Name: 'app_default',
        Driver: 'bridge',
        Scope: 'local',
        Labels: { 'com.docker.compose.project': 'app' },
      },
      {
        Id: 'net-b',
        Name: 'monitoring_default',
        Driver: 'bridge',
        Scope: 'local',
        Labels: { 'com.docker.compose.project': 'monitoring' },
      },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/app-web'],
        State: 'running',
        Image: 'nginx:latest',
        Labels: { 'com.docker.compose.project': 'app' },
        NetworkSettings: {
          Networks: { app_default: { NetworkID: 'net-a', IPAddress: '172.20.0.2' } },
        },
      },
      {
        Id: 'c2',
        Names: ['/monitoring-prom'],
        State: 'running',
        Image: 'prom/prometheus',
        Labels: { 'com.docker.compose.project': 'monitoring' },
        NetworkSettings: {
          Networks: { monitoring_default: { NetworkID: 'net-b', IPAddress: '172.21.0.5' } },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData(['app', 'monitoring'], false);

    expect(result).toHaveLength(2);

    const appNet = result.find(n => n.Id === 'net-a')!;
    expect(appNet.Name).toBe('app_default');
    expect(appNet.managedStatus).toBe('managed');
    expect(appNet.managedBy).toBe('app');
    expect(appNet.containers).toHaveLength(1);
    expect(appNet.containers[0]).toMatchObject({
      id: 'c1',
      name: 'app-web',
      ip: '172.20.0.2',
      state: 'running',
      image: 'nginx:latest',
      stack: 'app',
    });

    const monNet = result.find(n => n.Id === 'net-b')!;
    expect(monNet.containers).toHaveLength(1);
    expect(monNet.containers[0].name).toBe('monitoring-prom');
  });

  it('returns empty array when no networks exist', async () => {
    mockDocker.listNetworks.mockResolvedValue([]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result).toEqual([]);
  });

  it('returns networks with empty containers array when no containers are connected', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'net-x', Name: 'isolated', Driver: 'bridge', Scope: 'local', Labels: {} },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result).toHaveLength(1);
    expect(result[0].containers).toEqual([]);
  });
});

// ── System network filtering ──────────────────────────────────────────

describe('DockerController.getTopologyData - system network filtering', () => {
  const systemNetworks = [
    { Id: 'sys-bridge', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
    { Id: 'sys-host', Name: 'host', Driver: 'host', Scope: 'local' },
    { Id: 'sys-none', Name: 'none', Driver: 'null', Scope: 'local' },
  ];
  const userNetwork = {
    Id: 'net-user',
    Name: 'app_default',
    Driver: 'bridge',
    Scope: 'local',
    Labels: { 'com.docker.compose.project': 'app' },
  };
  const bridgeContainer = {
    Id: 'c-bridge',
    Names: ['/host-container'],
    State: 'running',
    Image: 'busybox',
    Labels: {},
    NetworkSettings: {
      Networks: { bridge: { NetworkID: 'sys-bridge', IPAddress: '172.17.0.2' } },
    },
  };
  const userContainer = {
    Id: 'c-user',
    Names: ['/app-svc'],
    State: 'running',
    Image: 'nginx',
    Labels: { 'com.docker.compose.project': 'app' },
    NetworkSettings: {
      Networks: { app_default: { NetworkID: 'net-user', IPAddress: '172.20.0.2' } },
    },
  };

  it('excludes system networks when includeSystem is false', async () => {
    mockDocker.listNetworks.mockResolvedValue([...systemNetworks, userNetwork]);
    mockDocker.listContainers.mockResolvedValue([bridgeContainer, userContainer]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData(['app'], false);

    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe('app_default');
    // Bridge container is not visible because its only network was filtered out
    expect(result[0].containers.find(c => c.id === 'c-bridge')).toBeUndefined();
  });

  it('includes system networks when includeSystem is true', async () => {
    mockDocker.listNetworks.mockResolvedValue([...systemNetworks, userNetwork]);
    mockDocker.listContainers.mockResolvedValue([bridgeContainer, userContainer]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData(['app'], true);

    expect(result).toHaveLength(4);
    const bridge = result.find(n => n.Name === 'bridge')!;
    expect(bridge.managedStatus).toBe('system');
    expect(bridge.containers).toHaveLength(1);
    expect(bridge.containers[0].id).toBe('c-bridge');
  });

  it('system networks always have managedStatus system and managedBy null', async () => {
    mockDocker.listNetworks.mockResolvedValue(systemNetworks);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], true);

    expect(result).toHaveLength(3);
    for (const net of result) {
      expect(net.managedStatus).toBe('system');
      expect(net.managedBy).toBeNull();
    }
  });
});

// ── Stack resolution ──────────────────────────────────────────────────

describe('DockerController.getTopologyData - stack resolution', () => {
  it('classifies networks with matching compose project label as managed', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      {
        Id: 'n1',
        Name: 'my-stack_default',
        Driver: 'bridge',
        Scope: 'local',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData(['my-stack'], false);

    expect(result[0].managedStatus).toBe('managed');
    expect(result[0].managedBy).toBe('my-stack');
  });

  it('classifies unlabeled networks as unmanaged', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'custom-net', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData(['my-stack'], false);

    expect(result[0].managedStatus).toBe('unmanaged');
    expect(result[0].managedBy).toBeNull();
  });

  it('classifies networks with unrecognized project label as unmanaged', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      {
        Id: 'n1',
        Name: 'other_default',
        Driver: 'bridge',
        Scope: 'local',
        Labels: { 'com.docker.compose.project': 'other-stack' },
      },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData(['my-stack'], false);

    expect(result[0].managedStatus).toBe('unmanaged');
    expect(result[0].managedBy).toBeNull();
  });

  it('resolves container stack from compose project label', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      {
        Id: 'n1',
        Name: 'my-stack_default',
        Driver: 'bridge',
        Scope: 'local',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/my-svc'],
        State: 'running',
        Image: 'nginx',
        Labels: { 'com.docker.compose.project': 'my-stack' },
        NetworkSettings: {
          Networks: { my_stack_default: { NetworkID: 'n1', IPAddress: '172.20.0.2' } },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData(['my-stack'], false);

    expect(result[0].containers[0].stack).toBe('my-stack');
  });

  it('container stack is null when no compose label matches', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'custom', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/standalone'],
        State: 'running',
        Image: 'busybox',
        Labels: {},
        NetworkSettings: {
          Networks: { custom: { NetworkID: 'n1', IPAddress: '172.25.0.2' } },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].containers[0].stack).toBeNull();
  });
});

// ── Container deduplication ──────────────────────────────────────────

describe('DockerController.getTopologyData - container deduplication', () => {
  it('container on multiple networks appears in each network container list', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'net-a', Name: 'frontend', Driver: 'bridge', Scope: 'local' },
      { Id: 'net-b', Name: 'backend', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'multi',
        Names: ['/api-gateway'],
        State: 'running',
        Image: 'gateway:1.0',
        Labels: {},
        NetworkSettings: {
          Networks: {
            frontend: { NetworkID: 'net-a', IPAddress: '172.30.0.2' },
            backend: { NetworkID: 'net-b', IPAddress: '172.31.0.2' },
          },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result).toHaveLength(2);
    expect(result.find(n => n.Id === 'net-a')!.containers).toHaveLength(1);
    expect(result.find(n => n.Id === 'net-b')!.containers).toHaveLength(1);
  });

  it('container IP is network-specific', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'net-a', Name: 'frontend', Driver: 'bridge', Scope: 'local' },
      { Id: 'net-b', Name: 'backend', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'multi',
        Names: ['/api-gateway'],
        State: 'running',
        Image: 'gateway:1.0',
        Labels: {},
        NetworkSettings: {
          Networks: {
            frontend: { NetworkID: 'net-a', IPAddress: '172.30.0.2' },
            backend: { NetworkID: 'net-b', IPAddress: '172.31.0.2' },
          },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    const frontendEntry = result.find(n => n.Id === 'net-a')!.containers[0];
    const backendEntry = result.find(n => n.Id === 'net-b')!.containers[0];
    expect(frontendEntry.ip).toBe('172.30.0.2');
    expect(backendEntry.ip).toBe('172.31.0.2');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────

describe('DockerController.getTopologyData - edge cases', () => {
  it('handles containers with missing NetworkSettings', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'user-net', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      { Id: 'c1', Names: ['/orphan'], State: 'running', Image: 'busybox', Labels: {} },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].containers).toEqual([]);
  });

  it('handles containers with empty Networks object', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'user-net', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/orphan'],
        State: 'running',
        Image: 'busybox',
        Labels: {},
        NetworkSettings: { Networks: {} },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].containers).toEqual([]);
  });

  it('skips network entries without NetworkID', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'user-net', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/svc'],
        State: 'running',
        Image: 'busybox',
        Labels: {},
        NetworkSettings: {
          Networks: {
            'broken-net': { NetworkID: undefined, IPAddress: '10.0.0.1' },
            'user-net': { NetworkID: 'n1', IPAddress: '172.20.0.2' },
          },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].containers).toHaveLength(1);
    expect(result[0].containers[0].ip).toBe('172.20.0.2');
  });

  it('falls back to truncated container ID when Names is empty', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'user-net', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'abc123def4567890abcdef1234567890',
        Names: [],
        State: 'running',
        Image: 'busybox',
        Labels: {},
        NetworkSettings: {
          Networks: { 'user-net': { NetworkID: 'n1', IPAddress: '172.20.0.2' } },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].containers[0].name).toBe('abc123def456');
  });

  it('falls back to truncated container ID when Names is undefined', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'user-net', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'deadbeef00112233445566778899aabb',
        State: 'running',
        Image: 'busybox',
        Labels: {},
        NetworkSettings: {
          Networks: { 'user-net': { NetworkID: 'n1', IPAddress: '172.20.0.2' } },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].containers[0].name).toBe('deadbeef0011');
  });

  it('defaults Driver to bridge when absent from network data', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'user-net', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].Driver).toBe('bridge');
  });

  it('defaults State to unknown when absent from container data', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'user-net', Driver: 'bridge', Scope: 'local' },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/svc'],
        Image: 'busybox',
        Labels: {},
        NetworkSettings: {
          Networks: { 'user-net': { NetworkID: 'n1', IPAddress: '172.20.0.2' } },
        },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].containers[0].state).toBe('unknown');
  });

  it('defaults Scope to local when absent from network data', async () => {
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'user-net', Driver: 'bridge' },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getTopologyData([], false);

    expect(result[0].Scope).toBe('local');
  });
});

// ── Error handling ────────────────────────────────────────────────────

describe('DockerController.getTopologyData - error handling', () => {
  it('propagates Docker API errors from listNetworks', async () => {
    mockDocker.listNetworks.mockRejectedValue(new Error('Cannot connect to Docker daemon'));
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    await expect(dc.getTopologyData([], false)).rejects.toThrow('Cannot connect to Docker daemon');
  });

  it('propagates Docker API errors from listContainers', async () => {
    mockDocker.listNetworks.mockResolvedValue([]);
    mockDocker.listContainers.mockRejectedValue(new Error('Docker daemon unavailable'));

    const dc = DockerController.getInstance(1);
    await expect(dc.getTopologyData([], false)).rejects.toThrow('Docker daemon unavailable');
  });

  it('throws when Docker returns HTML string for networks (wrong port)', async () => {
    mockDocker.listNetworks.mockResolvedValue('<html>Not Docker</html>');
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    await expect(dc.getTopologyData([], false)).rejects.toThrow('Invalid response from Docker API');
  });

  it('throws when Docker returns HTML string for containers (wrong port)', async () => {
    mockDocker.listNetworks.mockResolvedValue([]);
    mockDocker.listContainers.mockResolvedValue('<html>Not Docker</html>');

    const dc = DockerController.getInstance(1);
    await expect(dc.getTopologyData([], false)).rejects.toThrow('Invalid response from Docker API');
  });
});

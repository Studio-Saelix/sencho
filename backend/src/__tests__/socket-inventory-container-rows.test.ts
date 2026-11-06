/**
 * DockerController.listContainersForSocketInventory: Docker metadata is
 * untrusted, so every field is narrowed, bounded, and degrades to list-level
 * data instead of throwing. The read path must only list and inspect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDocker } = vi.hoisted(() => ({
  mockDocker: {
    listContainers: vi.fn(),
    getContainer: vi.fn(),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => mockDocker,
      getDefaultNodeId: () => 1,
      getComposeDir: () => '/compose',
    }),
  },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({ getStacks: async () => [] }),
  },
}));

import DockerController from '../services/DockerController';

beforeEach(() => {
  vi.clearAllMocks();
  mockDocker.listContainers.mockResolvedValue([]);
  mockDocker.getContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) });
});

function listed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'abc123def456',
    Names: ['/alpha-proxy-1'],
    Image: 'tecnativa/docker-socket-proxy:latest',
    ImageID: 'sha256:image1',
    State: 'running',
    Status: 'Up 2 hours',
    Labels: { 'com.docker.compose.project': 'alpha', 'com.docker.compose.service': 'proxy' },
    Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 2375, Type: 'tcp' }],
    NetworkSettings: {
      Networks: {
        alpha_default: { NetworkID: 'net1', IPAddress: '172.18.0.2' },
      },
    },
    ...overrides,
  };
}

function inspected(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'abc123def456',
    Image: 'sha256:image1',
    Config: {
      Image: 'tecnativa/docker-socket-proxy:latest',
      Labels: { 'com.docker.compose.service': 'proxy' },
      Env: ['CONTAINERS=1'],
      ExposedPorts: { '2375/tcp': {} },
    },
    State: { Status: 'running', Health: { Status: 'healthy' } },
    Mounts: [
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false },
    ],
    NetworkSettings: {
      Ports: { '2375/tcp': [{ HostIp: '0.0.0.0', HostPort: '2375' }] },
      Networks: { alpha_default: { NetworkID: 'net1', IPAddress: '172.18.0.2' } },
    },
    HostConfig: { Privileged: false, ReadonlyRootfs: true },
    ...overrides,
  };
}

describe('listContainersForSocketInventory', () => {
  it('returns the runtime metadata the inventory classifies', async () => {
    mockDocker.listContainers.mockResolvedValue([listed()]);
    mockDocker.getContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspected()) });

    const { rows: [row] } = await DockerController.getInstance(1).listContainersForSocketInventory();
    expect(row).toMatchObject({
      id: 'abc123def456',
      name: 'alpha-proxy-1',
      state: 'running',
      status: 'Up 2 hours',
      image: 'tecnativa/docker-socket-proxy:latest',
      imageId: 'sha256:image1',
      composeProject: 'alpha',
      service: 'proxy',
      health: 'healthy',
      inspectFailed: false,
      privileged: false,
      readonlyRootfs: true,
    });
    expect(row.labels).toEqual({
      'com.docker.compose.project': 'alpha',
      'com.docker.compose.service': 'proxy',
    });
    expect(row.mounts).toEqual([{
      type: 'bind',
      source: '/var/run/docker.sock',
      destination: '/var/run/docker.sock',
      readOnly: true,
      name: null,
    }]);
    expect(row.ports).toEqual([
      { privatePort: 2375, publicPort: 2375, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(row.exposedPorts).toEqual(['2375/tcp']);
    expect(row.networks).toEqual([{ name: 'alpha_default', id: 'net1', ipAddress: '172.18.0.2' }]);
    expect(row.env).toEqual(['CONTAINERS=1']);
  });

  it('falls back to list metadata and marks the row when inspect fails', async () => {
    mockDocker.listContainers.mockResolvedValue([listed()]);
    mockDocker.getContainer.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error('proxy read refused')),
    });
    const { rows: [row] } = await DockerController.getInstance(1).listContainersForSocketInventory();
    expect(row).toMatchObject({
      id: 'abc123def456',
      name: 'alpha-proxy-1',
      state: 'running',
      image: 'tecnativa/docker-socket-proxy:latest',
      inspectFailed: true,
      labels: {
        'com.docker.compose.project': 'alpha',
        'com.docker.compose.service': 'proxy',
      },
      mounts: [],
      env: [],
    });
    expect(row.ports).toEqual([
      { privatePort: 2375, publicPort: 2375, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(row.networks).toEqual([{ name: 'alpha_default', id: 'net1', ipAddress: '172.18.0.2' }]);
  });

  it('does not throw on adversarial labels, mounts, ports, networks, or names', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'adversarial1',
        Names: null,
        Labels: ['com.docker.compose.project=alpha', 'novalue'],
        Ports: [null, { PrivatePort: 'not-a-number' }, { PrivatePort: 2375, PublicPort: 0 }],
        NetworkSettings: { Networks: { broken: null, other: 'not-an-object' } },
      },
    ]);
    mockDocker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        Config: { Labels: null, Env: null, ExposedPorts: null },
        State: null,
        Mounts: [null, { Type: 'bind', Source: null, Destination: null }],
        NetworkSettings: { Ports: { '2375/tcp': [null, { HostIp: null, HostPort: '' }] } },
        HostConfig: null,
      }),
    });

    const { rows: [row] } = await DockerController.getInstance(1).listContainersForSocketInventory();
    expect(row.id).toBe('adversarial1');
    expect(row.name).toBe('');
    expect(row.labels).toEqual({ 'com.docker.compose.project': 'alpha', novalue: '' });
    expect(row.mounts).toEqual([{
      type: 'bind',
      source: null,
      destination: null,
      // A missing read/write flag is read as writable, never as a safe mount.
      readOnly: false,
      name: null,
    }]);
    expect(row.ports).toEqual([
      { privatePort: 2375, publicPort: null, ip: '', protocol: 'tcp' },
      { privatePort: 2375, publicPort: null, ip: '', protocol: 'tcp' },
    ]);
    expect(row.networks).toEqual([
      { name: 'broken', id: null, ipAddress: null },
      { name: 'other', id: null, ipAddress: null },
    ]);
    expect(row.inspectFailed).toBe(false);
  });

  it('marks a row incomplete when the inspect response has no mounts array', async () => {
    mockDocker.listContainers.mockResolvedValue([listed()]);
    mockDocker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue(inspected({ Mounts: null })),
    });
    const { rows: [row] } = await DockerController.getInstance(1).listContainersForSocketInventory();
    expect(row.mounts).toEqual([]);
    expect(row.metadataTruncated).toBe(true);
  });

  it('marks a container with no id as uninspectable rather than calling Docker with an empty id', async () => {
    mockDocker.listContainers.mockResolvedValue([{ Names: ['/orphan'], State: 'exited' }]);
    const { rows: [row] } = await DockerController.getInstance(1).listContainersForSocketInventory();
    expect(row.id).toBe('');
    expect(row.inspectFailed).toBe(true);
    expect(mockDocker.getContainer).not.toHaveBeenCalled();
  });

  it('applies the inspection limit before inspecting and reports the listed total', async () => {
    mockDocker.listContainers.mockResolvedValue([
      listed({ Id: 'c1', Names: ['/one'] }),
      listed({ Id: 'c2', Names: ['/two'] }),
      listed({ Id: 'c3', Names: ['/three'] }),
    ]);
    mockDocker.getContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspected()) });

    const result = await DockerController.getInstance(1).listContainersForSocketInventory(2);
    expect(result.listedContainers).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(mockDocker.getContainer).toHaveBeenCalledTimes(2);
  });

  it('bounds oversized mount, port, network, and env lists', async () => {
    mockDocker.listContainers.mockResolvedValue([listed()]);
    mockDocker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue(inspected({
        Mounts: Array.from({ length: 100 }, () => ({
          Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false,
        })),
        Config: {
          Image: 'tecnativa/docker-socket-proxy:latest',
          Labels: {},
          Env: Array.from({ length: 400 }, (_, index) => `KEY_${index}=value`),
          ExposedPorts: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${index}/tcp`, {}])),
        },
        NetworkSettings: {
          Ports: {},
          Networks: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`net-${index}`, {}])),
        },
      })),
    });
    const { rows: [row] } = await DockerController.getInstance(1).listContainersForSocketInventory();
    expect(row.mounts).toHaveLength(64);
    expect(row.metadataTruncated).toBe(true);
    expect(row.env).toHaveLength(256);
    expect(row.exposedPorts).toHaveLength(64);
    expect(row.networks).toHaveLength(32);
  });
});

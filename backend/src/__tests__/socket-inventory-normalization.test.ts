/**
 * Socket inventory: malformed domain values must never become trustworthy
 * evidence. These cases run the real Docker metadata normalizers and then the
 * final assembly, so they assert what the API would report for one node.
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
import {
  buildSocketInventory,
  describeDockerEndpoint,
  type SocketInventoryBuildInput,
} from '../services/socket/SocketInventoryService';

const SOCKET = '/var/run/docker.sock';

beforeEach(() => {
  vi.clearAllMocks();
  mockDocker.listContainers.mockResolvedValue([]);
  mockDocker.getContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) });
});

function listed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'consumer1',
    Names: ['/helper'],
    Image: 'alpine:3',
    ImageID: 'sha256:image1',
    State: 'running',
    Status: 'Up 2 hours',
    Labels: {},
    Ports: [],
    NetworkSettings: { Networks: {} },
    ...overrides,
  };
}

function inspected(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'consumer1',
    Image: 'sha256:image1',
    Config: {
      Image: 'alpine:3',
      Labels: {},
      Env: [],
      ExposedPorts: {},
    },
    State: { Status: 'running' },
    Mounts: [],
    NetworkSettings: { Ports: {}, Networks: {} },
    HostConfig: { Privileged: false, ReadonlyRootfs: false },
    ...overrides,
  };
}

function inventoryOf(
  containers: Awaited<ReturnType<DockerController['listContainersForSocketInventory']>>['rows'],
): ReturnType<typeof buildSocketInventory> {
  const input: SocketInventoryBuildInput = {
    nodeId: 1,
    node: undefined,
    instanceIdentity: 'instance-fingerprint',
    listedContainers: containers.length,
    truncated: false,
    containers,
    self: {
      state: 'resolved',
      reason: null,
      containerId: 'sencho1',
      containerName: 'sencho',
      bindMounts: [{ source: SOCKET, destination: SOCKET }],
    },
    endpoint: describeDockerEndpoint(undefined),
    endpointProvider: { state: 'none', reason: 'not a tcp endpoint' },
    generatedAt: 1_700_000_000_000,
    durationMs: 12,
    errors: [],
  };
  return buildSocketInventory(input);
}

async function rowsFrom(
  listedRow: Record<string, unknown>,
  inspectedRow: Record<string, unknown> | Error,
): Promise<Awaited<ReturnType<DockerController['listContainersForSocketInventory']>>['rows']> {
  mockDocker.listContainers.mockResolvedValue([listedRow]);
  mockDocker.getContainer.mockReturnValue({
    inspect: inspectedRow instanceof Error
      ? vi.fn().mockRejectedValue(inspectedRow)
      : vi.fn().mockResolvedValue(inspectedRow),
  });
  const { rows } = await DockerController.getInstance(1).listContainersForSocketInventory();
  return rows;
}

describe('socket inventory malformed mount metadata', () => {
  it.each(['', 'BIND', 'bind ', 'mystery'])(
    'retains a socket consumer whose mount type is %j and reports partial',
    async type => {
      const rows = await rowsFrom(listed(), inspected({
        Mounts: [{ Type: type, Source: SOCKET, Destination: SOCKET, RW: false }],
      }));
      expect(rows[0].metadataTruncated, `type=${JSON.stringify(type)}`).toBe(true);

      const inventory = inventoryOf(rows);
      expect(inventory.containers).toHaveLength(1);
      expect(inventory.containers[0]).toMatchObject({
        role: 'direct-socket-consumer',
        metadataTruncated: true,
      });
      expect(inventory.containers[0].socketMounts).toEqual([
        { source: SOCKET, destination: SOCKET, readOnly: true },
      ]);
      expect(inventory.status).toBe('partial');
    },
  );

  it('marks an empty bind path unreadable and keeps the target as undetermined', async () => {
    const rows = await rowsFrom(listed(), inspected({
      Mounts: [{ Type: 'bind', Source: '', Destination: '', RW: false }],
    }));
    expect(rows[0].metadataTruncated).toBe(true);

    const inventory = inventoryOf(rows);
    expect(inventory.containers).toHaveLength(1);
    expect(inventory.containers[0]).toMatchObject({
      role: 'undetermined',
      classification: 'unknown',
      metadataTruncated: true,
      socketMounts: [],
    });
    expect(inventory.status).toBe('partial');
  });

  it('keeps a socket destination visible when only its source path is empty', async () => {
    const rows = await rowsFrom(listed(), inspected({
      Mounts: [{ Type: 'bind', Source: '', Destination: SOCKET, RW: false }],
    }));
    expect(rows[0].metadataTruncated).toBe(true);
    expect(rows[0].mounts).toEqual([{
      type: 'bind', source: '', destination: SOCKET, readOnly: true, name: null,
    }]);

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0]).toMatchObject({
      role: 'direct-socket-consumer',
      metadataTruncated: true,
    });
    expect(inventory.status).toBe('partial');
  });

  it('does not treat an empty tmpfs source as unreadable metadata', async () => {
    const rows = await rowsFrom(listed(), inspected({
      Mounts: [{ Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true }],
    }));
    expect(rows[0].metadataTruncated).toBe(false);
    expect(rows[0].mounts).toEqual([{
      type: 'tmpfs', source: '', destination: '/tmp', readOnly: false, name: null,
    }]);
  });

  it('marks an empty volume source incomplete because Docker always supplies one', async () => {
    const rows = await rowsFrom(listed(), inspected({
      Mounts: [{ Type: 'volume', Source: '', Destination: '/data', RW: true }],
    }));
    expect(rows[0].metadataTruncated).toBe(true);
  });
});

describe('socket inventory malformed port metadata', () => {
  it.each(['2375junk', '2375.9', '1e4', '-2375', '70000'])(
    'does not invent a published port from inspect HostPort %j',
    async hostPort => {
      const rows = await rowsFrom(
        listed({
          Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }],
        }),
        inspected({
          NetworkSettings: {
            Ports: { '2375/tcp': [{ HostIp: '127.0.0.1', HostPort: hostPort }] },
            Networks: {},
          },
        }),
      );
      // The malformed inspect binding must not replace the valid listing
      // binding: the wildcard public port and its address survive.
      expect(rows[0].ports, hostPort).toEqual([
        { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
      ]);
      expect(rows[0].metadataTruncated, hostPort).toBe(true);

      const inventory = inventoryOf(rows);
      expect(inventory.containers[0].publishedPorts, hostPort).toEqual([{
        privatePort: 2375,
        publicPort: 8080,
        ip: '0.0.0.0',
        allInterfaces: true,
        protocol: 'tcp',
      }]);
      expect(inventory.status, hostPort).toBe('partial');
    },
  );

  it.each([2375.5, -1, 0.5, 70000])(
    'does not invent a published port from a whole-number HostPort %j',
    async hostPort => {
      const rows = await rowsFrom(
        listed({
          Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }],
        }),
        inspected({
          NetworkSettings: {
            Ports: { '2375/tcp': [{ HostIp: '127.0.0.1', HostPort: hostPort }] },
            Networks: {},
          },
        }),
      );
      expect(rows[0].ports, String(hostPort)).toEqual([
        { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
      ]);
      expect(rows[0].metadataTruncated, String(hostPort)).toBe(true);
    },
  );

  it('reads a numeric HostPort 0 as not published without inventing a port', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [] }),
      inspected({
        NetworkSettings: {
          Ports: { '2375/tcp': [{ HostIp: '0.0.0.0', HostPort: 0 }] },
          Networks: {},
        },
      }),
    );
    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: null, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(false);
  });

  it.each([
    [
      { PrivatePort: 2375.5, PublicPort: 8080 },
      { privatePort: null, publicPort: 8080 },
      [{ privatePort: null, publicPort: 8080 }],
    ],
    [
      { PrivatePort: 2375, PublicPort: 70000 },
      { privatePort: 2375, publicPort: null },
      [],
    ],
    [
      { PrivatePort: -1, PublicPort: -5 },
      { privatePort: null, publicPort: null },
      [],
    ],
    [
      { PrivatePort: 0, PublicPort: 65536 },
      { privatePort: null, publicPort: null },
      [],
    ],
  ])('rejects malformed listing port values %j', async (ports, expected, exposed) => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: '0.0.0.0', Type: 'tcp', ...ports }] }),
      new Error('inspect unavailable'),
    );
    expect(rows[0].ports).toEqual([
      { ...expected, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0].publishedPorts.map(port => ({
      privatePort: port.privatePort,
      publicPort: port.publicPort,
    }))).toEqual(exposed);
    expect(inventory.status).toBe('partial');
  });

  it('accepts the range boundaries 1 and 65535', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: '0.0.0.0', PrivatePort: 1, PublicPort: 65535, Type: 'tcp' }] }),
      new Error('inspect unavailable'),
    );
    expect(rows[0].ports).toEqual([
      { privatePort: 1, publicPort: 65535, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(false);
  });

  it.each([{ Ip: undefined }, { Ip: 5 }, { Ip: {} }])(
    'does not turn an unreadable listing address into a wildcard binding: %j',
    async ({ Ip }) => {
      const rows = await rowsFrom(
        listed({ Ports: [{ IP: Ip, PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }] }),
        new Error('inspect unavailable'),
      );
      expect(rows[0].ports).toEqual([
        { privatePort: 2375, publicPort: 8080, ip: null, protocol: 'tcp' },
      ]);
      expect(rows[0].metadataTruncated).toBe(true);

      const inventory = inventoryOf(rows);
      expect(inventory.containers[0].publishedPorts).toEqual([{
        privatePort: 2375,
        publicPort: 8080,
        ip: null,
        allInterfaces: false,
        protocol: 'tcp',
      }]);
      expect(inventory.status).toBe('partial');
    },
  );

  it.each([{ HostIp: undefined }, { HostIp: 5 }, { HostIp: {} }])(
    'keeps the listing address when inspect cannot read the same published binding: %j',
    async ({ HostIp }) => {
      const rows = await rowsFrom(
        listed({ Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }] }),
        inspected({
          NetworkSettings: {
            Ports: { '2375/tcp': [{ HostIp, HostPort: '8080' }] },
            Networks: {},
          },
        }),
      );
      // The public port matches the listing; only inspect's address is
      // unreadable, so the listing's proven wildcard address is kept.
      expect(rows[0].ports).toEqual([
        { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
      ]);
      expect(rows[0].metadataTruncated).toBe(true);

      const inventory = inventoryOf(rows);
      expect(inventory.containers[0].publishedPorts).toEqual([{
        privatePort: 2375,
        publicPort: 8080,
        ip: '0.0.0.0',
        allInterfaces: true,
        protocol: 'tcp',
      }]);
      expect(inventory.status).toBe('partial');
    },
  );

  it('does not turn an unreadable inspect address into a wildcard when the listing address is also unreadable', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: 5, PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }] }),
      inspected({
        NetworkSettings: {
          Ports: { '2375/tcp': [{ HostIp: {}, HostPort: '8080' }] },
          Networks: {},
        },
      }),
    );
    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: null, protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0].publishedPorts[0]).toMatchObject({
      ip: null,
      allInterfaces: false,
    });
    expect(inventory.status).toBe('partial');
  });

  it('marks an exposed-only listing entry with an unreadable address incomplete', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: 5, PrivatePort: 2375, PublicPort: 0, Type: 'tcp' }] }),
      new Error('inspect unavailable'),
    );
    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: null, ip: null, protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
  });

  it('marks an exposed-only inspect binding with a malformed HostIp incomplete', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [] }),
      inspected({
        NetworkSettings: {
          Ports: { '2375/tcp': [{ HostIp: {}, HostPort: '' }] },
          Networks: {},
        },
      }),
    );
    expect(rows[0].metadataTruncated).toBe(true);
  });

  it('marks an inspect port spec with an empty protocol incomplete', async () => {
    const rows = await rowsFrom(listed({ Ports: [] }), inspected({
      NetworkSettings: {
        Ports: { '2375/': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
        Networks: {},
      },
    }));
    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
  });

  it('marks a malformed listing protocol incomplete instead of defaulting silently', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 5 }] }),
      inspected({
        NetworkSettings: {
          Ports: { '2375/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
          Networks: {},
        },
      }),
    );
    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
  });

  it('treats a published empty address as a proven wildcard binding', async () => {
    const rows = await rowsFrom(listed({ Ports: [] }), inspected({
      Mounts: [{ Type: 'bind', Source: SOCKET, Destination: SOCKET, RW: false }],
      NetworkSettings: {
        Ports: { '8080/tcp': [{ HostIp: '', HostPort: '8080' }] },
        Networks: {},
      },
    }));
    expect(rows[0].metadataTruncated).toBe(false);

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0].publishedPorts).toEqual([{
      privatePort: 8080,
      publicPort: 8080,
      ip: '',
      allInterfaces: true,
      protocol: 'tcp',
    }]);
    expect(inventory.status).toBe('complete');
  });

  it('rejects a malformed inspect private-port key without inventing a binding', async () => {
    const rows = await rowsFrom(listed(), inspected({
      NetworkSettings: {
        Ports: { '2375junk/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
        Networks: {},
      },
    }));
    expect(rows[0].ports).toEqual([
      { privatePort: null, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);

    const inventory = inventoryOf(rows);
    // The published exposure is kept, but the unreadable private port is not
    // invented, and the row cannot read complete.
    expect(inventory.containers[0].publishedPorts).toEqual([{
      privatePort: null,
      publicPort: 8080,
      ip: '0.0.0.0',
      allInterfaces: true,
      protocol: 'tcp',
    }]);
    expect(inventory.status).toBe('partial');
  });
});

describe('socket inventory malformed label and network metadata', () => {
  it('does not coerce a non-string label value into text', async () => {
    const rows = await rowsFrom(
      listed({
        Labels: {
          'com.docker.compose.project': { nested: true },
          'com.docker.compose.service': 'proxy',
        },
      }),
      inspected({
        Config: {
          Image: 'alpine:3',
          Labels: { 'com.docker.compose.project': 42 },
          Env: [],
          ExposedPorts: {},
        },
      }),
    );
    expect(rows[0].labels).toEqual({ 'com.docker.compose.service': 'proxy' });
    expect(Object.values(rows[0].labels)).not.toContain('[object Object]');
    expect(rows[0].metadataTruncated).toBe(true);

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0]).toMatchObject({
      role: 'undetermined',
      classification: 'unknown',
      compose: { project: null, service: 'proxy', workingDir: null },
      metadataTruncated: true,
    });
    expect(inventory.status).toBe('partial');
  });

  it('marks malformed network member fields incomplete instead of reading them as null', async () => {
    const rows = await rowsFrom(listed(), inspected({
      NetworkSettings: {
        Ports: {},
        Networks: {
          net1: { NetworkID: 5, IPAddress: {} },
          net2: { NetworkID: 'n2', IPAddress: '10.0.0.2' },
        },
      },
    }));
    expect(rows[0].networks).toEqual([
      { name: 'net1', id: null, ipAddress: null },
      { name: 'net2', id: 'n2', ipAddress: '10.0.0.2' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0].metadataTruncated).toBe(true);
    expect(inventory.status).toBe('partial');
  });
});

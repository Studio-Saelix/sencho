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
  it.each([
    ['', 'undetermined'],
    ['BIND', 'direct-socket-consumer'],
    ['bind ', 'direct-socket-consumer'],
    ['mystery', 'undetermined'],
  ] as const)(
    'retains a socket consumer whose mount type is %j and reports partial',
    async (type, expectedRole) => {
      const rows = await rowsFrom(listed(), inspected({
        Mounts: [{ Type: type, Source: SOCKET, Destination: SOCKET, RW: false }],
      }));
      expect(rows[0].metadataTruncated, `type=${JSON.stringify(type)}`).toBe(true);

      const inventory = inventoryOf(rows);
      expect(inventory.containers).toHaveLength(1);
      // The mount is kept as possible socket access. A type that only needed
      // casing or whitespace canonicalized is still a proven bind; a type that
      // could not be read at all is not proof of a direct consumer, so that row
      // stays undetermined.
      expect(inventory.containers[0]).toMatchObject({
        role: expectedRole,
        classification: expectedRole === 'undetermined' ? 'unknown' : 'detected',
        metadataTruncated: true,
      });
      expect(inventory.containers[0].socketMounts).toEqual([
        { source: SOCKET, destination: SOCKET, readOnly: true },
      ]);
      if (expectedRole === 'undetermined') {
        expect(inventory.containers[0].evidence).toContain('socket-mount-type-unknown');
        expect(inventory.counts.undetermined).toBe(1);
      } else {
        expect(inventory.containers[0].evidence).not.toContain('socket-mount-type-unknown');
        expect(inventory.counts.directSocketConsumers).toBe(1);
      }
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

  it.each(['0.0.0.0garbage', '127.0.0.1:2375', 'localhost', ' 0.0.0.0'])(
    'does not present an unparseable inspect address as a binding address: %j',
    async HostIp => {
      const rows = await rowsFrom(listed({ Ports: [] }), inspected({
        Mounts: [{ Type: 'bind', Source: SOCKET, Destination: SOCKET, RW: false }],
        NetworkSettings: {
          Ports: { '2375/tcp': [{ HostIp, HostPort: '8080' }] },
          Networks: {},
        },
      }));
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
    },
  );

  it.each(['0.0.0.0garbage', 'localhost'])(
    'does not present an unparseable listing address as a binding address: %j',
    async IP => {
      const rows = await rowsFrom(
        listed({ Ports: [{ IP, PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }] }),
        new Error('inspect unavailable'),
      );
      expect(rows[0].ports).toEqual([
        { privatePort: 2375, publicPort: 8080, ip: null, protocol: 'tcp' },
      ]);
      expect(rows[0].metadataTruncated).toBe(true);
      expect(inventoryOf(rows).status).toBe('partial');
    },
  );

  it.each(['::1', '::', '172.18.0.2'])(
    'keeps a readable binding address: %j',
    async HostIp => {
      const rows = await rowsFrom(listed({ Ports: [] }), inspected({
        NetworkSettings: {
          Ports: { '2375/tcp': [{ HostIp, HostPort: '8080' }] },
          Networks: {},
        },
      }));
      expect(rows[0].ports).toEqual([
        { privatePort: 2375, publicPort: 8080, ip: HostIp, protocol: 'tcp' },
      ]);
      expect(rows[0].metadataTruncated).toBe(false);
    },
  );

  it('does not turn an unreadable inspect address into a wildcard when the listing address is also unreadable', async () => {    const rows = await rowsFrom(
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

  it.each([5, null])(
    'marks an exposed-only listing entry with an unreadable address incomplete: %j',
    async IP => {
      const rows = await rowsFrom(
        listed({ Ports: [{ IP, PrivatePort: 2375, PublicPort: 0, Type: 'tcp' }] }),
        new Error('inspect unavailable'),
      );
      expect(rows[0].ports).toEqual([
        { privatePort: 2375, publicPort: null, ip: null, protocol: 'tcp' },
      ]);
      expect(rows[0].metadataTruncated).toBe(true);
    },
  );

  it.each([{}, null])(
    'marks an exposed-only inspect binding with a malformed HostIp incomplete: %j',
    async HostIp => {
      const rows = await rowsFrom(
        listed({ Ports: [] }),
        inspected({
          NetworkSettings: {
            Ports: { '2375/tcp': [{ HostIp, HostPort: '' }] },
            Networks: {},
          },
        }),
      );
      expect(rows[0].metadataTruncated).toBe(true);
    },
  );

  it('marks an inspect port spec with an empty protocol incomplete', async () => {
    const rows = await rowsFrom(listed({ Ports: [] }), inspected({
      NetworkSettings: {
        Ports: { '2375/': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
        Networks: {},
      },
    }));
    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: null },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
  });

  it.each([5, null])(
    'marks a malformed listing protocol (%j) incomplete instead of defaulting silently',
    async Type => {
      const rows = await rowsFrom(
        listed({ Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type }] }),
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
    },
  );

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
          net3: { NetworkID: 'n3', IPAddress: '10.0.0.2garbage' },
          net4: { NetworkID: null, IPAddress: null },
        },
      },
    }));
    expect(rows[0].networks).toEqual([
      { name: 'net1', id: null, ipAddress: null },
      { name: 'net2', id: 'n2', ipAddress: '10.0.0.2' },
      { name: 'net3', id: 'n3', ipAddress: null },
      { name: 'net4', id: null, ipAddress: null },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0].metadataTruncated).toBe(true);
    expect(inventory.status).toBe('partial');
  });

  it('keeps readable listing network evidence when inspect fields are unreadable', async () => {
    const rows = await rowsFrom(
      listed({
        NetworkSettings: { Networks: { alpha: { NetworkID: 'net1', IPAddress: '172.18.0.2' } } },
      }),
      inspected({
        NetworkSettings: { Ports: {}, Networks: { alpha: { NetworkID: null, IPAddress: null } } },
      }),
    );
    // Inspect still decides which networks are attached, but the listing's
    // readable id and address are evidence that an unreadable inspect value
    // must not erase.
    expect(rows[0].networks).toEqual([{ name: 'alpha', id: 'net1', ipAddress: '172.18.0.2' }]);
    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).status).toBe('partial');
  });

  it('marks an explicit null network id and address incomplete', async () => {
    const rows = await rowsFrom(listed(), inspected({
      NetworkSettings: {
        Ports: {},
        Networks: { net4: { NetworkID: null, IPAddress: null } },
      },
    }));
    expect(rows[0].networks).toEqual([{ name: 'net4', id: null, ipAddress: null }]);
    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).status).toBe('partial');
  });

  it.each([7, null, {}])(
    'marks present but unreadable inspect scalars (%j) incomplete and keeps the listing fallback',
    async bad => {
      const rows = await rowsFrom(listed(), inspected({
        Image: bad,
        Config: { Image: bad, Labels: {}, Env: [], ExposedPorts: {} },
        State: { Status: bad, Health: { Status: bad } },
      }));
      // The listing values are still valid evidence, but the row cannot read
      // complete when inspect answered with an unreadable value.
      expect(rows[0]).toMatchObject({
        state: 'running',
        image: 'alpine:3',
        imageId: 'sha256:image1',
        health: null,
        metadataTruncated: true,
      });
      expect(inventoryOf(rows).status).toBe('partial');
    },
  );
});

describe('socket inventory unreadable enclosing metadata', () => {
  it.each([
    ['Config is null', null],
    ['Config is a scalar', 'not-a-map'],
    ['Config is an array', []],
  ])('marks a row incomplete when %s', async (_label, config) => {
    const rows = await rowsFrom(listed(), inspected({ Config: config }));

    // The columns Config owns must not read as cleanly empty facts.
    expect(rows[0]).toMatchObject({
      labels: {},
      apiGroups: [],
      exposedPorts: [],
      metadataTruncated: true,
    });

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0]).toMatchObject({
      labels: [],
      apiGroups: [],
      exposedPorts: [],
      metadataTruncated: true,
    });
    expect(inventory.status).toBe('partial');
  });

  it.each([
    ['State is null', null],
    ['State is a scalar', 7],
    ['State is an array', []],
  ])('keeps listing state and marks the row incomplete when %s', async (_label, state) => {
    const rows = await rowsFrom(listed(), inspected({ State: state }));

    expect(rows[0]).toMatchObject({
      state: 'running',
      health: null,
      metadataTruncated: true,
    });
    expect(inventoryOf(rows).status).toBe('partial');
  });

  it.each([null, 5, 'healthy', true, []])(
    'does not read a non-map State.Health (%j) as an absent health fact',
    async health => {
      const rows = await rowsFrom(listed(), inspected({
        State: { Status: 'running', Health: health },
      }));

      expect(rows[0]).toMatchObject({ health: null, metadataTruncated: true });
      expect(inventoryOf(rows).status).toBe('partial');
    },
  );

  it.each([
    ['NetworkSettings is null', null],
    ['NetworkSettings is a scalar', 7],
    ['NetworkSettings is an array', []],
  ])('keeps readable listing port and network evidence but marks the row incomplete when %s', async (_label, settings) => {
    const rows = await rowsFrom(
      listed({
        Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }],
        NetworkSettings: { Networks: { alpha: { NetworkID: 'net1', IPAddress: '172.18.0.2' } } },
      }),
      inspected({ NetworkSettings: settings }),
    );

    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].networks).toEqual([{ name: 'alpha', id: 'net1', ipAddress: '172.18.0.2' }]);
    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).status).toBe('partial');
  });

  it.each([
    ['HostConfig is null', null],
    ['HostConfig is a scalar', 7],
    ['HostConfig is an array', []],
  ])('does not assert security negatives when %s', async (_label, hostConfig) => {
    const rows = await rowsFrom(listed(), inspected({ HostConfig: hostConfig }));

    expect(rows[0]).toMatchObject({
      privileged: null,
      readonlyRootfs: null,
      metadataTruncated: true,
    });
    expect(inventoryOf(rows).status).toBe('partial');
  });

  it('does not read non-boolean security facts as proven negatives', async () => {
    const rows = await rowsFrom(listed(), inspected({
      HostConfig: { Privileged: 'true', ReadonlyRootfs: 'true' },
    }));

    expect(rows[0]).toMatchObject({
      privileged: null,
      readonlyRootfs: null,
      metadataTruncated: true,
    });
    const inventory = inventoryOf(rows);
    expect(inventory.containers[0]).toMatchObject({ privileged: null, readonlyRootfs: null });
    expect(inventory.status).toBe('partial');
  });

  it('keeps a readable security boolean beside an unreadable one', async () => {
    const rows = await rowsFrom(listed(), inspected({
      HostConfig: { Privileged: true, ReadonlyRootfs: 'false' },
    }));

    expect(rows[0]).toMatchObject({
      privileged: true,
      readonlyRootfs: null,
      metadataTruncated: true,
    });
  });
});

describe('socket inventory unreadable listing scalars', () => {
  it('marks unreadable listing identity, state, and name incomplete when inspect cannot replace them', async () => {
    const rows = await rowsFrom(
      listed({ Names: 7, State: 5, Status: 5, Image: 5, ImageID: 5 }),
      new Error('inspect unavailable'),
    );

    expect(rows[0]).toMatchObject({
      name: '',
      state: 'unknown',
      status: '',
      image: '',
      imageId: '',
      metadataTruncated: true,
    });
    expect(inventoryOf(rows).status).toBe('partial');
  });

  it('does not call a row incomplete once a readable inspect value replaces an unreadable listing scalar', async () => {
    const rows = await rowsFrom(
      listed({ State: 5, Image: 5, ImageID: 5 }),
      inspected(),
    );

    expect(rows[0]).toMatchObject({
      state: 'running',
      image: 'alpine:3',
      imageId: 'sha256:image1',
      metadataTruncated: false,
    });
  });

  it('marks an unreadable listing network parent incomplete', async () => {
    const rows = await rowsFrom(
      listed({ NetworkSettings: 'not-a-map' }),
      inspected({ NetworkSettings: { Ports: {}, Networks: {} } }),
    );

    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).status).toBe('partial');
  });
});

describe('socket inventory port specification validation', () => {
  it('marks an empty listing protocol incomplete instead of presenting it', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: '' }] }),
      new Error('inspect unavailable'),
    );

    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: null },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).status).toBe('partial');
  });

  it('keeps a readable listing protocol when the inspect protocol is unreadable', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }] }),
      inspected({
        NetworkSettings: {
          Ports: { '2375/': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
          Networks: {},
        },
      }),
    );

    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
  });

  it('keeps an unknown listing protocol as reported instead of rewriting it to tcp', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'icmp' }] }),
      new Error('inspect unavailable'),
    );

    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'icmp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).containers[0].publishedPorts[0].protocol).toBe('icmp');
  });

  it('keeps an unknown inspect protocol as reported instead of rewriting it to tcp', async () => {
    const rows = await rowsFrom(listed({ Ports: [] }), inspected({
      NetworkSettings: {
        Ports: { '2375/icmp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
        Networks: {},
      },
    }));

    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'icmp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).containers[0].publishedPorts[0].protocol).toBe('icmp');
  });

  it('drops malformed exposed-port specifications and marks the row incomplete', async () => {
    const rows = await rowsFrom(listed({ Ports: [] }), inspected({
      Config: {
        Image: 'alpine:3',
        Labels: {},
        Env: [],
        ExposedPorts: {
          '2375junk/tcp': {},
          '2375/tcp': {},
          '8080/': {},
          '53/udp': {},
        },
      },
    }));

    expect(rows[0].exposedPorts).toEqual(['2375/tcp', '53/udp']);
    expect(rows[0].metadataTruncated).toBe(true);
    const inventory = inventoryOf(rows);
    expect(inventory.containers[0].exposedPorts).toEqual(['2375/tcp', '53/udp']);
    expect(inventory.status).toBe('partial');
  });
});

describe('socket inventory fallback preserves binding multiplicity', () => {
  it('restores a wildcard listing binding beside a readable loopback inspect binding', async () => {
    const rows = await rowsFrom(
      listed({ Ports: [{ IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' }] }),
      inspected({
        NetworkSettings: {
          Ports: {
            '2375/tcp': [
              { HostIp: '127.0.0.1', HostPort: '8080' },
              { HostIp: {}, HostPort: '8080' },
            ],
          },
          Networks: {},
        },
      }),
    );

    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '127.0.0.1', protocol: 'tcp' },
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);

    const inventory = inventoryOf(rows);
    expect(inventory.containers[0].publishedPorts).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '127.0.0.1', allInterfaces: false, protocol: 'tcp' },
      { privatePort: 2375, publicPort: 8080, ip: '0.0.0.0', allInterfaces: true, protocol: 'tcp' },
    ]);
    expect(inventory.status).toBe('partial');
  });

  it.each([
    [
      'loopback then wildcard',
      [
        { IP: '127.0.0.1', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' },
        { IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' },
      ],
      ['127.0.0.1', '0.0.0.0'],
    ],
    [
      'wildcard then loopback',
      [
        { IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' },
        { IP: '127.0.0.1', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' },
      ],
      ['0.0.0.0', '127.0.0.1'],
    ],
  ])('keeps both listing addresses when inspect reads only one unreadable binding (%s)', async (_label, ports, expected) => {
    const rows = await rowsFrom(
      listed({ Ports: ports }),
      inspected({
        NetworkSettings: {
          Ports: { '2375/tcp': [{ HostIp: null, HostPort: '8080' }] },
          Networks: {},
        },
      }),
    );

    expect(rows[0].ports.map(port => port.ip)).toEqual(expected);
    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).status).toBe('partial');
  });

  it('keeps IPv4 and IPv6 wildcard bindings as separate evidence', async () => {
    const rows = await rowsFrom(
      listed({
        Ports: [
          { IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' },
          { IP: '::', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' },
        ],
      }),
      inspected({
        NetworkSettings: {
          Ports: {
            '2375/tcp': [
              { HostIp: {}, HostPort: '8080' },
              { HostIp: {}, HostPort: '8080' },
            ],
          },
          Networks: {},
        },
      }),
    );

    expect(rows[0].ports.map(port => port.ip)).toEqual(['0.0.0.0', '::']);
    expect(rows[0].metadataTruncated).toBe(true);
    const inventory = inventoryOf(rows);
    expect(inventory.containers[0].publishedPorts.map(port => port.allInterfaces)).toEqual([true, true]);
  });

  it('keeps every distinct listing public port when inspect cannot read the published binding', async () => {
    const rows = await rowsFrom(
      listed({
        Ports: [
          { IP: '127.0.0.1', PrivatePort: 2375, PublicPort: 8080, Type: 'tcp' },
          { IP: '0.0.0.0', PrivatePort: 2375, PublicPort: 9090, Type: 'tcp' },
        ],
      }),
      inspected({
        NetworkSettings: {
          Ports: { '2375/tcp': [{ HostIp: null, HostPort: null }] },
          Networks: {},
        },
      }),
    );

    expect(rows[0].ports).toEqual([
      { privatePort: 2375, publicPort: 8080, ip: '127.0.0.1', protocol: 'tcp' },
      { privatePort: 2375, publicPort: 9090, ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    expect(rows[0].metadataTruncated).toBe(true);
    expect(inventoryOf(rows).containers[0].publishedPorts.map(port => ({
      publicPort: port.publicPort,
      allInterfaces: port.allInterfaces,
    }))).toEqual([
      { publicPort: 8080, allInterfaces: false },
      { publicPort: 9090, allInterfaces: true },
    ]);
  });

  it('does not let fallback restoration exceed the overall port cap', async () => {
    const listedPorts = Array.from({ length: 70 }, (_, index) => ({
      IP: '0.0.0.0',
      PrivatePort: 2000 + index,
      PublicPort: 3000 + index,
      Type: 'tcp',
    }));
    const rows = await rowsFrom(
      listed({ Ports: listedPorts }),
      inspected({
        NetworkSettings: {
          Ports: { '9999/tcp': [{ HostIp: '0.0.0.0', HostPort: '9999' }] },
          Networks: {},
        },
      }),
    );

    expect(rows[0].ports.length).toBe(64);
    expect(rows[0].metadataTruncated).toBe(true);
  });
});

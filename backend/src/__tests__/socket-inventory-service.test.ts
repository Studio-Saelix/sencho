/**
 * Docker socket inventory: endpoint parsing, provider/consumer classification,
 * partial and undetermined states, bounds, redaction, and node-scoped loading.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Node } from '../services/DatabaseService';
import type { SocketInventoryContainerRow } from '../services/DockerController';
import {
  buildSocketInventory,
  describeDockerEndpoint,
  loadSocketInventory,
  MAX_INVENTORY_CONTAINERS,
  SocketInventoryUnavailableError,
  type SocketInventoryBuildInput,
  type SocketInventoryDeps,
} from '../services/socket/SocketInventoryService';
import { REDACTED_SENTINEL } from '../helpers/labelValueRedaction';

const SOCKET = '/var/run/docker.sock';

const node: Node = {
  id: 1,
  name: 'local',
  type: 'local',
  mode: 'proxy',
  compose_dir: '/compose',
  is_default: true,
  status: 'online',
  created_at: 0,
  cordoned: false,
  cordoned_at: null,
  cordoned_reason: null,
};

function row(overrides: Partial<SocketInventoryContainerRow> = {}): SocketInventoryContainerRow {
  return {
    id: 'c1',
    name: 'c1',
    state: 'running',
    status: 'Up 2 hours',
    image: 'alpine:3',
    imageId: 'sha256:img1',
    stack: null,
    service: null,
    composeProject: null,
    composeWorkingDir: null,
    labels: {},
    inspectFailed: false,
    health: null,
    mounts: [],
    ports: [],
    exposedPorts: [],
    networks: [],
    env: [],
    privileged: false,
    readonlyRootfs: false,
    metadataTruncated: false,
    ...overrides,
  };
}

function socketMount(source = SOCKET, destination = SOCKET, readOnly = false) {
  return { type: 'bind', source, destination, readOnly, name: null };
}

function input(overrides: Partial<SocketInventoryBuildInput> = {}): SocketInventoryBuildInput {
  return {
    nodeId: 1,
    node,
    instanceIdentity: 'instance-fingerprint',
    listedContainers: 1,
    truncated: false,
    containers: [],
    self: {
      state: 'none',
      reason: null,
      containerId: null,
      containerName: null,
      bindMounts: null,
    },
    endpoint: describeDockerEndpoint(undefined),
    endpointProvider: { state: 'none', reason: 'not a tcp endpoint' },
    generatedAt: 1_700_000_000_000,
    durationMs: 12,
    errors: [],
    ...overrides,
  };
}

function proxyRow(overrides: Partial<SocketInventoryContainerRow> = {}): SocketInventoryContainerRow {
  return row({
    id: 'proxy1',
    name: 'alpha-proxy-1',
    image: 'tecnativa/docker-socket-proxy:latest',
    labels: {
      'com.docker.compose.project': 'alpha',
      'com.docker.compose.service': 'proxy',
    },
    composeProject: 'alpha',
    service: 'proxy',
    mounts: [socketMount(SOCKET, SOCKET, true)],
    ports: [{ privatePort: 2375, publicPort: 2375, ip: '0.0.0.0', protocol: 'tcp' }],
    env: ['CONTAINERS=1', 'POST=0'],
    networks: [{ name: 'alpha_default', id: 'net1', ipAddress: '172.18.0.2' }],
    ...overrides,
  });
}

describe('describeDockerEndpoint', () => {
  it('treats an unset DOCKER_HOST as the documented unix default and says so', () => {
    const endpoint = describeDockerEndpoint(undefined);
    expect(endpoint).toMatchObject({
      transport: 'unix',
      address: 'unix:///var/run/docker.sock',
      socketPath: '/var/run/docker.sock',
      addressSource: 'default',
    });
  });

  it('keeps a custom unix socket path without assuming /var/run/docker.sock', () => {
    expect(describeDockerEndpoint('unix:///run/sencho-docker.sock')).toMatchObject({
      transport: 'unix',
      socketPath: '/run/sencho-docker.sock',
      addressSource: 'env',
    });
  });

  it('drops credentials from a tcp endpoint before returning it', () => {
    const endpoint = describeDockerEndpoint('tcp://operator:hunter2@proxy:2375');
    expect(endpoint).toMatchObject({
      transport: 'tcp',
      address: 'tcp://proxy:2375',
      host: 'proxy',
      port: 2375,
    });
    expect(JSON.stringify(endpoint)).not.toContain('hunter2');
  });

  it('reports npipe, ssh, and unknown transports without inventing a provider', () => {
    expect(describeDockerEndpoint('npipe:////./pipe/docker_engine').transport).toBe('npipe');
    expect(describeDockerEndpoint('ssh://operator@docker-host')).toMatchObject({
      transport: 'ssh',
      address: 'ssh://docker-host',
    });
    expect(describeDockerEndpoint('fd://').transport).toBe('unknown');
  });
});

describe('buildSocketInventory classification', () => {
  it('lists a detected proxy and a direct socket consumer as distinct kinds', () => {
    const inventory = buildSocketInventory(input({
      listedContainers: 2,
      containers: [
        proxyRow(),
        row({
          id: 'app1',
          name: 'alpha-app-1',
          labels: {
            'com.docker.compose.project': 'alpha',
            'com.docker.compose.service': 'app',
          },
          composeProject: 'alpha',
          service: 'app',
          mounts: [socketMount(SOCKET, SOCKET, false)],
        }),
      ],
      endpoint: describeDockerEndpoint('tcp://proxy:2375'),
      endpointProvider: {
        state: 'resolved',
        provider: {
          containerId: 'proxy1',
          containerName: 'alpha-proxy-1',
          project: 'alpha',
          service: 'proxy',
          workingDir: '/srv/alpha',
          socketBindSource: SOCKET,
        },
      },
    }));

    expect(inventory.status).toBe('complete');
    expect(inventory.counts).toMatchObject({
      listedContainers: 2,
      matchedContainers: 2,
      proxies: 1,
      directSocketConsumers: 1,
      undetermined: 0,
    });
    const proxy = inventory.containers.find(entry => entry.id === 'proxy1');
    const app = inventory.containers.find(entry => entry.id === 'app1');
    expect(proxy).toMatchObject({
      role: 'proxy',
      classification: 'detected',
      providerType: 'tecnativa',
      isSenchoEndpointProvider: true,
      senchoStack: null,
    });
    expect(proxy?.compose).toEqual({ project: 'alpha', service: 'proxy', workingDir: null });
    expect(proxy?.apiGroups).toEqual(['CONTAINERS']);
    expect(proxy?.publishedPorts[0]).toMatchObject({ publicPort: 2375, allInterfaces: true });
    expect(app).toMatchObject({
      role: 'direct-socket-consumer',
      classification: 'detected',
      providerType: null,
      isSenchoEndpointProvider: false,
    });
    expect(inventory.endpoint).toMatchObject({
      transport: 'tcp',
      detection: 'detected',
      provider: { kind: 'container', containerId: 'proxy1', providerType: 'tecnativa' },
    });
  });

  it('reports a direct socket consumer instead of claiming there is no Docker access', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({
        id: 'sencho1',
        name: 'sencho',
        image: 'ghcr.io/studio-saelix/sencho:latest',
        mounts: [socketMount(SOCKET, SOCKET, false)],
      })],
      self: {
        state: 'resolved',
        reason: null,
        containerId: 'sencho1',
        containerName: 'sencho',
        bindMounts: [{ source: SOCKET, destination: SOCKET }],
      },
    }));

    expect(inventory.status).toBe('complete');
    expect(inventory.counts.proxies).toBe(0);
    expect(inventory.counts.directSocketConsumers).toBe(1);
    expect(inventory.containers[0]).toMatchObject({
      role: 'direct-socket-consumer',
      isSencho: true,
    });
    expect(inventory.endpoint).toMatchObject({
      transport: 'unix',
      detection: 'detected',
      provider: { kind: 'direct-socket', providerType: 'direct-unix-socket' },
      sencho: { state: 'resolved', inContainer: true, socketBindSource: SOCKET },
    });
  });

  it('keeps unknown images and names that mount the socket as direct consumers', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({
        id: 'custom1',
        name: 'my-helper',
        image: 'registry.example.com/team/custom-helper:1',
        mounts: [socketMount('/run/docker.sock', '/var/run/docker.sock', true)],
      })],
    }));
    expect(inventory.containers).toHaveLength(1);
    expect(inventory.containers[0]).toMatchObject({
      role: 'direct-socket-consumer',
      providerType: null,
      inspectFailed: false,
    });
  });

  it('does not call a lookalike image a proxy, and keeps a generic socket-proxy a candidate', () => {
    const lookalike = buildSocketInventory(input({
      containers: [row({
        id: 'lookalike1',
        name: 'company-helper',
        image: 'registry.example.com/company/socket-proxy-test:1',
        mounts: [socketMount(SOCKET, SOCKET, false)],
      })],
    }));
    expect(lookalike.containers[0]).toMatchObject({
      role: 'direct-socket-consumer',
      providerType: null,
    });

    const generic = buildSocketInventory(input({
      containers: [row({
        id: 'generic1',
        name: 'custom-proxy',
        image: 'myorg/socket-proxy:1',
        mounts: [socketMount(SOCKET, SOCKET, false)],
      })],
    }));
    expect(generic.containers[0]).toMatchObject({
      role: 'proxy',
      classification: 'candidate',
      providerType: 'generic-socket-proxy',
    });
  });

  it('marks the snapshot partial when a relevant container stays undetermined', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({
        id: 'tcp-only-proxy',
        mounts: [],
        ports: [{ privatePort: 2375, publicPort: 2375, ip: '', protocol: 'tcp' }],
      })],
    }));
    expect(inventory.containers[0].role).toBe('undetermined');
    expect(inventory.status).toBe('partial');
  });

  it('marks the snapshot partial when container metadata was truncated', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ metadataTruncated: true })],
    }));
    expect(inventory.containers[0].metadataTruncated).toBe(true);
    expect(inventory.containers[0].evidence).toContain('metadata-truncated');
    expect(inventory.status).toBe('partial');
    expect(inventory.errors.some(error => error.stage === 'container-metadata')).toBe(true);
  });

  it('does not trust a vendor hint embedded in a longer repository name', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({
        id: 'spoof1',
        name: 'spoof-helper',
        image: 'registry.example.com/tecnativa/docker-socket-proxy-evil:1',
        mounts: [socketMount(SOCKET, SOCKET, true)],
      })],
    }));
    expect(inventory.containers[0]).toMatchObject({
      role: 'direct-socket-consumer',
      providerType: null,
    });
  });

  it('includes a stopped proxy with its explicit state rather than dropping it', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ id: 'stopped1', state: 'exited', status: 'Exited (0) 2 days ago' })],
    }));
    expect(inventory.containers[0]).toMatchObject({
      role: 'proxy',
      state: 'exited',
      status: 'Exited (0) 2 days ago',
    });
    expect(inventory.containers[0].evidence).toContain('not-running');
  });

  it('uses the Compose service identity when a container was renamed', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ id: 'renamed1', name: 'something-else' })],
    }));
    expect(inventory.containers[0]).toMatchObject({
      name: 'something-else',
      role: 'proxy',
      compose: { project: 'alpha', service: 'proxy', workingDir: null },
    });
  });

  it('reports multiple proxies and flags only the one carrying the endpoint', () => {
    const inventory = buildSocketInventory(input({
      listedContainers: 2,
      containers: [
        proxyRow(),
        proxyRow({
          id: 'proxy2',
          name: 'beta-proxy-1',
          image: 'lscr.io/linuxserver/socket-proxy:latest',
          labels: { 'com.docker.compose.project': 'beta', 'com.docker.compose.service': 'socket-proxy' },
          composeProject: 'beta',
          service: 'socket-proxy',
        }),
      ],
      endpoint: describeDockerEndpoint('tcp://beta-proxy:2375'),
      endpointProvider: {
        state: 'resolved',
        provider: {
          containerId: 'proxy2',
          containerName: 'beta-proxy-1',
          project: 'beta',
          service: 'socket-proxy',
          workingDir: '/srv/beta',
          socketBindSource: SOCKET,
        },
      },
    }));
    expect(inventory.counts.proxies).toBe(2);
    expect(inventory.containers.filter(entry => entry.isSenchoEndpointProvider)).toHaveLength(1);
    expect(inventory.containers.find(entry => entry.isSenchoEndpointProvider)?.id).toBe('proxy2');
  });

  it('keeps a proxy with no Compose ownership and no working directory', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({
        id: 'standalone1',
        name: 'docker_socket_proxy',
        image: 'wollomatic/socket-proxy:1',
        mounts: [socketMount('/var/run/docker.sock', '/var/run/docker.sock', true)],
      })],
    }));
    expect(inventory.containers[0]).toMatchObject({
      role: 'proxy',
      providerType: 'wollomatic',
      compose: null,
    });
  });

  it('does not attribute a custom unix path just because a proxy mounts the same source', () => {
    const custom = '/var/run/sencho-proxy.sock';
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({
        id: 'wollomatic1',
        image: 'wollomatic/socket-proxy:1',
        mounts: [socketMount(custom, custom, true)],
      })],
      endpoint: describeDockerEndpoint(`unix://${custom}`),
      self: {
        state: 'resolved',
        reason: null,
        containerId: 'sencho1',
        containerName: 'sencho',
        bindMounts: [{ source: custom, destination: custom }],
      },
    }));
    expect(inventory.endpoint).toMatchObject({
      detection: 'undetermined',
      provider: { kind: 'unknown', containerId: null },
    });
    // The proxy is still reported; only the endpoint attribution stays open.
    expect(inventory.containers[0]).toMatchObject({
      role: 'proxy',
      providerType: 'wollomatic',
      isSenchoEndpointProvider: false,
    });
    expect(inventory.status).toBe('partial');
  });

  it('stays undetermined for a custom socket path no visible container mounts', () => {
    const custom = '/var/run/unknown.sock';
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint(`unix://${custom}`),
      self: {
        state: 'resolved',
        reason: null,
        containerId: 'sencho1',
        containerName: 'sencho',
        bindMounts: [{ source: custom, destination: custom }],
      },
    }));
    expect(inventory.endpoint.detection).toBe('undetermined');
    expect(inventory.endpoint.provider.kind).toBe('unknown');
    expect(inventory.status).toBe('partial');
  });

  it('stays undetermined for a custom unix path whose bind source is not visible', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint('unix:///run/custom-docker.sock'),
      self: {
        state: 'none',
        reason: null,
        containerId: null,
        containerName: null,
        bindMounts: null,
      },
    }));
    expect(inventory.endpoint.detection).toBe('undetermined');
    expect(inventory.endpoint.provider.kind).toBe('unknown');
    expect(inventory.status).toBe('partial');
  });

  it('marks a failed inspect as undetermined and partial, not as absent', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ id: 'broken1', inspectFailed: true, mounts: [], env: [] })],
    }));
    expect(inventory.containers[0]).toMatchObject({
      role: 'undetermined',
      classification: 'unknown',
      providerType: 'tecnativa',
      inspectFailed: true,
    });
    expect(inventory.status).toBe('partial');
    expect(inventory.errors.some(error => error.stage === 'inspect-container')).toBe(true);
  });

  it('keeps an uninspectable container as undetermined instead of dropping it', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({ id: 'broken2', inspectFailed: true, mounts: [] })],
    }));
    expect(inventory.containers).toHaveLength(1);
    expect(inventory.containers[0]).toMatchObject({
      role: 'undetermined',
      classification: 'unknown',
      inspectFailed: true,
    });
    expect(inventory.counts.inspectFailures).toBe(1);
    expect(inventory.status).toBe('partial');
  });

  it('does not attribute a recreated tcp provider when two containers share its Compose identity', () => {
    const inventory = buildSocketInventory(input({
      listedContainers: 2,
      containers: [
        proxyRow({ id: 'newproxy1', name: 'alpha-proxy-1' }),
        proxyRow({ id: 'newproxy2', name: 'alpha-proxy-2' }),
      ],
      endpoint: describeDockerEndpoint('tcp://proxy:2375'),
      endpointProvider: {
        state: 'resolved',
        provider: {
          containerId: 'stale-id',
          containerName: 'alpha-proxy-old',
          project: 'alpha',
          service: 'proxy',
          workingDir: '/srv/alpha',
          socketBindSource: SOCKET,
        },
      },
    }));
    expect(inventory.containers.every(entry => !entry.isSenchoEndpointProvider)).toBe(true);
    expect(inventory.endpoint.reason).toContain('more than one');
    expect(inventory.status).toBe('partial');
  });

  it('reports a tcp provider that may be outside a truncated inventory as partial', () => {
    const provider = {
      containerId: 'outside-bound',
      containerName: 'proxy-outside',
      project: 'other',
      service: 'proxy',
      workingDir: '/srv/other',
      socketBindSource: SOCKET,
    };
    const truncated = buildSocketInventory(input({
      listedContainers: 1200,
      truncated: true,
      endpoint: describeDockerEndpoint('tcp://proxy:2375'),
      endpointProvider: { state: 'resolved', provider },
    }));
    expect(truncated.endpoint).toMatchObject({
      detection: 'detected',
      provider: { kind: 'container', containerId: 'outside-bound' },
    });
    expect(truncated.status).toBe('partial');
    expect(truncated.errors.some(error => error.stage === 'endpoint-provider')).toBe(true);

    // Without truncation every container was considered, so a provider that is
    // not a socket target is named by the endpoint block but is not a gap.
    const complete = buildSocketInventory(input({
      endpoint: describeDockerEndpoint('tcp://proxy:2375'),
      endpointProvider: { state: 'resolved', provider },
    }));
    expect(complete.status).toBe('complete');
  });

  it('reports an unmatched tcp endpoint as undetermined with its reason', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint('tcp://proxy:2375'),
      endpointProvider: {
        state: 'none',
        unmatched: true,
        reason: 'No container on a network Sencho shares owns the Docker endpoint address for "proxy".',
      },
    }));
    expect(inventory.endpoint.detection).toBe('undetermined');
    expect(inventory.endpoint.reason).toContain('No container');
    expect(inventory.status).toBe('partial');
  });

  it('reports unsupported transports without an empty clean result', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint('fd://'),
    }));
    expect(inventory.endpoint.detection).toBe('unsupported');
    expect(inventory.status).toBe('partial');
  });

  it('marks the snapshot partial when self identity is unresolved', () => {
    const inventory = buildSocketInventory(input({
      self: {
        state: 'unresolved',
        reason: 'Docker did not answer.',
        containerId: null,
        containerName: null,
        bindMounts: null,
      },
    }));
    expect(inventory.status).toBe('partial');
    expect(inventory.endpoint.sencho).toMatchObject({
      state: 'unresolved',
      inContainer: null,
      reason: 'Docker did not answer.',
    });
  });

  it('redacts secret-like labels and never returns environment values', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({
        labels: {
          'com.docker.compose.project': 'alpha',
          'traefik.http.middlewares.auth.basicauth.users': 'admin:$apr1$secret',
        },
        env: ['CONTAINERS=1', 'API_KEY=super-secret-value'],
        image: 'user:hunter2@registry.example.com/team/proxy:1',
      })],
    }));
    const [container] = inventory.containers;
    const auth = container.labels.find(label => label.key === 'traefik.http.middlewares.auth.basicauth.users');
    expect(auth).toMatchObject({ value: REDACTED_SENTINEL, redacted: true });
    expect(container.apiGroups).toEqual(['CONTAINERS']);
    expect(JSON.stringify(inventory)).not.toContain('super-secret-value');
    expect(container.image).toBe('[redacted]@registry.example.com/team/proxy:1');
  });

  it('redacts credentials in a label value even when the key looks innocuous', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({
        labels: {
          'com.docker.compose.project': 'alpha',
          'example.summary': 'upstream https://operator:hunter2@registry.example.com/api',
        },
      })],
    }));
    const summary = inventory.containers[0].labels.find(label => label.key === 'example.summary');
    expect(summary?.value).not.toContain('hunter2');
    expect(summary?.value).toContain('[redacted]@registry.example.com');
  });

  it('bounds oversized labels and status text', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({
        status: `Up 2 hours ${'x'.repeat(10_000)}`,
        labels: {
          'com.docker.compose.project': 'alpha',
          [`long.${'k'.repeat(500)}`]: 'v'.repeat(5000),
        },
      })],
    }));
    const [container] = inventory.containers;
    expect(container.status.length).toBeLessThanOrEqual(200);
    for (const label of container.labels) {
      expect(label.key.length).toBeLessThanOrEqual(128);
      expect(label.value.length).toBeLessThanOrEqual(256);
    }
  });

  it('marks a truncated scan partial and names the bound', () => {
    const inventory = buildSocketInventory(input({
      listedContainers: MAX_INVENTORY_CONTAINERS + 1,
      truncated: true,
      containers: [proxyRow()],
    }));
    expect(inventory.truncated).toBe(true);
    expect(inventory.status).toBe('partial');
    expect(inventory.errors[0].message).toContain(String(MAX_INVENTORY_CONTAINERS));
  });
});

describe('loadSocketInventory', () => {
  function deps(overrides: Partial<SocketInventoryDeps> = {}): SocketInventoryDeps {
    return {
      docker: {
        listContainersForSocketInventory: vi.fn().mockResolvedValue({
          rows: [], listedContainers: 0, truncated: false,
        }),
      },
      self: {
        ensureResolved: vi.fn().mockResolvedValue('none'),
        getIdentity: vi.fn().mockReturnValue({
          containerId: null,
          containerName: null,
          composeProjectName: null,
          imageId: null,
          networkNames: [],
          volumeNames: [],
        }),
        getBindMounts: vi.fn().mockResolvedValue(null),
        getUnresolvedReason: vi.fn().mockReturnValue(null),
      },
      resolveEndpointProvider: vi.fn().mockResolvedValue({
        state: 'none',
        reason: 'The Docker endpoint is not a tcp address.',
      }),
      node: () => node,
      instanceIdentity: () => 'instance-fingerprint',
      now: () => 1_700_000_000_000,
      ...overrides,
    };
  }

  it('throws a typed unavailable error when the container list fails', async () => {
    const depsWithFailure = deps({
      docker: {
        listContainersForSocketInventory: vi.fn().mockRejectedValue(new Error('socket refused')),
      },
    });
    await expect(loadSocketInventory(1, depsWithFailure))
      .rejects.toBeInstanceOf(SocketInventoryUnavailableError);
  });

  it('reports the bound while inspecting only the containers the list returned', async () => {
    const rows = Array.from({ length: MAX_INVENTORY_CONTAINERS }, (_, index) => proxyRow({
      id: `p${index}`,
      name: `proxy-${index}`,
    }));
    const list = vi.fn().mockResolvedValue({
      rows,
      listedContainers: MAX_INVENTORY_CONTAINERS + 5,
      truncated: true,
    });
    const inventory = await loadSocketInventory(1, deps({
      docker: { listContainersForSocketInventory: list },
    }));
    expect(list).toHaveBeenCalledWith(MAX_INVENTORY_CONTAINERS);
    expect(inventory.truncated).toBe(true);
    expect(inventory.counts.listedContainers).toBe(MAX_INVENTORY_CONTAINERS + 5);
    expect(inventory.counts.matchedContainers).toBe(MAX_INVENTORY_CONTAINERS);
    expect(inventory.status).toBe('partial');
  });

  it('calls the endpoint provider only for a tcp endpoint', async () => {
    const resolve = vi.fn().mockResolvedValue({ state: 'none', reason: 'unmatched' });
    const original = process.env.DOCKER_HOST;
    try {
      delete process.env.DOCKER_HOST;
      await loadSocketInventory(1, deps({ resolveEndpointProvider: resolve }));
      expect(resolve).not.toHaveBeenCalled();

      process.env.DOCKER_HOST = 'tcp://proxy:2375';
      await loadSocketInventory(1, deps({ resolveEndpointProvider: resolve }));
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = original;
    }
  });

  it('stamps the producing node identity so a hub cannot relabel it', async () => {
    const inventory = await loadSocketInventory(1, deps());
    expect(inventory.node).toEqual({
      id: 1,
      name: 'local',
      type: 'local',
      mode: 'proxy',
      instanceIdentity: 'instance-fingerprint',
    });
  });
});

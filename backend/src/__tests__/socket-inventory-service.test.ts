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
    apiGroups: [],
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
    apiGroups: ['CONTAINERS'],
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

  it('describes the socket the active client picked when DOCKER_HOST is unset', () => {
    expect(describeDockerEndpoint(undefined, {
      defaultSocketPath: '/home/operator/.docker/run/docker.sock',
    })).toMatchObject({
      transport: 'unix',
      address: 'unix:///home/operator/.docker/run/docker.sock',
      socketPath: '/home/operator/.docker/run/docker.sock',
      addressSource: 'default',
    });
  });

  it('lets an explicit DOCKER_HOST win over the client default', () => {
    expect(describeDockerEndpoint('unix:///run/explicit.sock', {
      defaultSocketPath: '/home/operator/.docker/run/docker.sock',
    })).toMatchObject({
      transport: 'unix',
      socketPath: '/run/explicit.sock',
      addressSource: 'env',
    });
  });

  it('fills a bare unix:// path from the client default', () => {
    expect(describeDockerEndpoint('unix://', {
      defaultSocketPath: '/home/operator/.docker/run/docker.sock',
    })).toMatchObject({
      transport: 'unix',
      socketPath: '/home/operator/.docker/run/docker.sock',
      addressSource: 'env',
    });
  });

  it('describes a Windows named pipe when the client default is a pipe', () => {
    expect(describeDockerEndpoint(undefined, {
      defaultSocketPath: '//./pipe/docker_engine',
    })).toMatchObject({
      transport: 'npipe',
      address: 'npipe:////./pipe/docker_engine',
      addressSource: 'default',
    });
  });

  it('does not substitute the conventional path when the client socket is unresolved', () => {
    expect(describeDockerEndpoint(undefined, {
      defaultSocketPath: null,
      defaultSocketUnresolved: true,
    })).toMatchObject({
      transport: 'unix',
      address: null,
      socketPath: null,
      addressSource: 'default',
    });
    expect(describeDockerEndpoint('unix://', {
      defaultSocketPath: null,
      defaultSocketUnresolved: true,
    })).toMatchObject({
      transport: 'unix',
      address: null,
      socketPath: null,
      addressSource: 'env',
    });
  });

  it('keeps the client-selected relative socket path instead of inventing a leading slash', () => {
    for (const relative of ['var/run/docker.sock', 'run/docker.sock']) {
      expect(describeDockerEndpoint(`unix://${relative}`)).toMatchObject({
        transport: 'unix',
        address: `unix://${relative}`,
        socketPath: relative,
        addressSource: 'env',
      });
      expect(describeDockerEndpoint(undefined, {
        defaultSocketPath: relative,
      })).toMatchObject({
        transport: 'unix',
        socketPath: relative,
        addressSource: 'default',
      });
    }
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

  it('retains an unhinted container whose mounts were unreadable', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({ id: 'unreadable1', name: 'helper', metadataTruncated: true })],
    }));
    expect(inventory.containers).toHaveLength(1);
    expect(inventory.containers[0]).toMatchObject({
      role: 'undetermined',
      classification: 'unknown',
      metadataTruncated: true,
    });
    expect(inventory.status).toBe('partial');
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

  it.each(['/var/run/docker.sock', '/run/docker.sock'])(
    'does not call a canonical destination at %s direct when its host source is a forwarder',
    destination => {
      const inventory = buildSocketInventory(input({
        endpoint: describeDockerEndpoint(`unix://${destination}`),
        self: {
          state: 'resolved',
          reason: null,
          containerId: 'sencho1',
          containerName: 'sencho',
          bindMounts: [{ source: '/run/forwarder.sock', destination }],
        },
      }));
      expect(inventory.endpoint).toMatchObject({
        detection: 'undetermined',
        provider: { kind: 'unknown', socketBindSource: '/run/forwarder.sock' },
      });
      expect(inventory.endpoint.evidence).toContain('socket-destination-default-source-custom');
      expect(inventory.status).toBe('partial');
    },
  );

  it('keeps a canonical destination direct when Sencho mounts the same host socket through', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint('unix:///var/run/docker.sock'),
      self: {
        state: 'resolved',
        reason: null,
        containerId: 'sencho1',
        containerName: 'sencho',
        bindMounts: [{ source: '/var/run/docker.sock', destination: '/var/run/docker.sock' }],
      },
    }));
    expect(inventory.endpoint).toMatchObject({
      detection: 'detected',
      provider: { kind: 'direct-socket', socketBindSource: '/var/run/docker.sock' },
    });
    expect(inventory.status).toBe('complete');
  });

  it('stays undetermined when self identity cannot prove host execution', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint(undefined),
      self: {
        state: 'none',
        reason: null,
        containerId: null,
        containerName: null,
        bindMounts: null,
      },
    }));
    // `none` also covers a container whose identity no probe could see, so it is
    // not proof that Sencho runs on the host and dials the daemon directly.
    expect(inventory.endpoint).toMatchObject({
      transport: 'unix',
      detection: 'undetermined',
      provider: { kind: 'unknown', providerType: null },
      sencho: { state: 'none', inContainer: null },
    });
    expect(inventory.endpoint.evidence).toContain('socket-destination-default-source-unobserved');
    expect(inventory.status).toBe('partial');
  });

  it('stays undetermined for both canonical paths when self identity is unknown', () => {
    for (const dockerHost of [undefined, 'unix:///var/run/docker.sock', 'unix:///run/docker.sock']) {
      const inventory = buildSocketInventory(input({
        endpoint: describeDockerEndpoint(dockerHost),
        self: {
          state: 'none',
          reason: null,
          containerId: null,
          containerName: null,
          bindMounts: null,
        },
      }));
      expect(inventory.endpoint, String(dockerHost)).toMatchObject({
        detection: 'undetermined',
        provider: { kind: 'unknown', providerType: null },
      });
      expect(inventory.status, String(dockerHost)).toBe('partial');
    }
  });

  it('does not claim direct access for an unidentified container forwarding a canonical destination', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint(undefined),
      self: {
        state: 'none',
        reason: null,
        containerId: null,
        containerName: null,
        bindMounts: null,
      },
      containers: [row({
        id: 'forwarder1',
        name: 'forwarder',
        mounts: [socketMount('/run/forwarder.sock', '/var/run/docker.sock', false)],
      })],
    }));
    expect(inventory.endpoint.detection).not.toBe('detected');
    expect(inventory.endpoint.provider.kind).toBe('unknown');
    expect(inventory.status).toBe('partial');
  });

  it('classifies a relative client socket path conservatively', () => {
    for (const relative of ['var/run/docker.sock', 'run/docker.sock']) {
      for (const endpoint of [
        describeDockerEndpoint(`unix://${relative}`),
        describeDockerEndpoint(undefined, { defaultSocketPath: relative }),
      ]) {
        const inventory = buildSocketInventory(input({
          endpoint,
          self: {
            state: 'resolved',
            reason: null,
            containerId: 'sencho1',
            containerName: 'sencho',
            bindMounts: [{ source: '/var/run/docker.sock', destination: '/var/run/docker.sock' }],
          },
        }));
        expect(inventory.endpoint, relative).toMatchObject({
          transport: 'unix',
          address: `unix://${relative}`,
          detection: 'undetermined',
          provider: { kind: 'unknown' },
        });
        expect(inventory.endpoint.evidence).toContain('socket-path-relative');
        expect(inventory.status).toBe('partial');
      }
    }
  });

  it('treats the two canonical host socket paths as a passthrough', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint('unix:///run/docker.sock'),
      self: {
        state: 'resolved',
        reason: null,
        containerId: 'sencho1',
        containerName: 'sencho',
        bindMounts: [{ source: '/var/run/docker.sock', destination: '/run/docker.sock' }],
      },
    }));
    expect(inventory.endpoint.detection).toBe('detected');
    expect(inventory.status).toBe('complete');
  });

  it('does not call an unset canonical destination direct when a forwarder backs it', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint(undefined),
      self: {
        state: 'resolved',
        reason: null,
        containerId: 'sencho1',
        containerName: 'sencho',
        bindMounts: [{ source: '/run/forwarder.sock', destination: '/var/run/docker.sock' }],
      },
    }));
    expect(inventory.endpoint).toMatchObject({
      detection: 'undetermined',
      provider: { kind: 'unknown', socketBindSource: '/run/forwarder.sock' },
    });
    expect(inventory.endpoint.evidence).toContain('socket-destination-default-source-custom');
    expect(inventory.status).toBe('partial');
  });

  it('reports the client default socket when it differs from the conventional path', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint(undefined, {
        defaultSocketPath: '/home/operator/.docker/run/docker.sock',
      }),
      self: {
        state: 'none',
        reason: null,
        containerId: null,
        containerName: null,
        bindMounts: null,
      },
    }));
    expect(inventory.endpoint).toMatchObject({
      transport: 'unix',
      address: 'unix:///home/operator/.docker/run/docker.sock',
      addressSource: 'default',
      detection: 'undetermined',
    });
    expect(inventory.endpoint.evidence).toContain('socket-path-client-default');
    expect(inventory.endpoint.reason).toContain('Docker client resolved');
    expect(inventory.status).toBe('partial');
  });

  it('stays undetermined for a canonical destination inside a container with no visible bind', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint('unix:///var/run/docker.sock'),
      self: {
        state: 'resolved',
        reason: null,
        containerId: 'sencho1',
        containerName: 'sencho',
        bindMounts: null,
      },
    }));
    expect(inventory.endpoint.detection).toBe('undetermined');
    expect(inventory.endpoint.evidence).toContain('socket-destination-default-source-unobserved');
    expect(inventory.endpoint.reason).toContain('host source is not visible');
    expect(inventory.status).toBe('partial');
  });

  it('stays undetermined when the client socket itself could not be resolved', () => {
    const inventory = buildSocketInventory(input({
      endpoint: describeDockerEndpoint(undefined, {
        defaultSocketPath: null,
        defaultSocketUnresolved: true,
      }),
      self: {
        state: 'none',
        reason: null,
        containerId: null,
        containerName: null,
        bindMounts: null,
      },
    }));
    expect(inventory.endpoint).toMatchObject({
      transport: 'unix',
      address: null,
      detection: 'undetermined',
    });
    expect(inventory.endpoint.evidence).toContain('socket-client-endpoint-unresolved');
    expect(inventory.status).toBe('partial');
  });

  it('marks a failed inspect as undetermined and partial, not as absent', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ id: 'broken1', inspectFailed: true, mounts: [], apiGroups: [] })],
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

  it('retains a resolver-proven provider with an unknown image and no socket hint', () => {
    const inventory = buildSocketInventory(input({
      listedContainers: 1,
      containers: [row({ id: 'gateway1', name: 'gateway', image: 'alpine:3' })],
      endpoint: describeDockerEndpoint('tcp://gateway:8999'),
      endpointProvider: {
        state: 'resolved',
        provider: {
          containerId: 'gateway1',
          containerName: 'gateway',
          project: null,
          service: null,
          workingDir: null,
          socketBindSource: null,
        },
      },
    }));
    expect(inventory.containers).toHaveLength(1);
    expect(inventory.containers[0]).toMatchObject({
      id: 'gateway1',
      role: 'undetermined',
      classification: 'unknown',
      isSenchoEndpointProvider: true,
    });
    expect(inventory.endpoint).toMatchObject({
      detection: 'detected',
      provider: { kind: 'container', containerId: 'gateway1' },
    });
    expect(inventory.status).toBe('partial');
  });

  it('retains a resolver-proven provider that only mounts a custom socket path', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({
        id: 'custom-provider',
        name: 'gateway',
        image: 'alpine:3',
        mounts: [socketMount('/run/proxy.sock', '/run/proxy.sock', true)],
      })],
      endpoint: describeDockerEndpoint('tcp://gateway:8999'),
      endpointProvider: {
        state: 'resolved',
        provider: {
          containerId: 'custom-provider',
          containerName: 'gateway',
          project: null,
          service: null,
          workingDir: null,
          socketBindSource: '/run/proxy.sock',
        },
      },
    }));
    expect(inventory.containers).toHaveLength(1);
    expect(inventory.containers[0]).toMatchObject({
      role: 'direct-socket-consumer',
      isSenchoEndpointProvider: true,
    });
    expect(inventory.status).toBe('complete');
  });

  it('attributes a recreated provider by name when it has no Compose identity', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({ id: 'new-provider-id', name: 'gateway', image: 'alpine:3' })],
      endpoint: describeDockerEndpoint('tcp://gateway:8999'),
      endpointProvider: {
        state: 'resolved',
        provider: {
          containerId: 'stale-provider-id',
          containerName: 'gateway',
          project: null,
          service: null,
          workingDir: null,
          socketBindSource: null,
        },
      },
    }));
    expect(inventory.containers[0]).toMatchObject({
      id: 'new-provider-id',
      role: 'undetermined',
      isSenchoEndpointProvider: true,
    });
    expect(inventory.endpoint.provider.containerId).toBe('new-provider-id');
    expect(inventory.status).toBe('partial');
  });

  it('attributes a recreated provider by Compose identity even without image or port hints', () => {
    const inventory = buildSocketInventory(input({
      containers: [row({
        id: 'new-provider-id',
        name: 'renamed-gateway',
        image: 'alpine:3',
        composeProject: 'gateway',
        service: 'proxy',
        labels: {
          'com.docker.compose.project': 'gateway',
          'com.docker.compose.service': 'proxy',
        },
      })],
      endpoint: describeDockerEndpoint('tcp://gateway:8999'),
      endpointProvider: {
        state: 'resolved',
        provider: {
          containerId: 'stale-provider-id',
          containerName: 'gateway',
          project: 'gateway',
          service: 'proxy',
          workingDir: '/srv/gateway',
          socketBindSource: null,
        },
      },
    }));
    expect(inventory.containers[0]).toMatchObject({
      id: 'new-provider-id',
      role: 'undetermined',
      isSenchoEndpointProvider: true,
    });
    expect(inventory.endpoint.provider.containerId).toBe('new-provider-id');
    expect(inventory.status).toBe('partial');
  });

  it('reports a tcp provider that is missing from the inventory as partial', () => {
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

    // A provider that disappears between collection and attribution is a
    // genuine evidence gap even when the list itself was not truncated.
    const complete = buildSocketInventory(input({
      endpoint: describeDockerEndpoint('tcp://proxy:2375'),
      endpointProvider: { state: 'resolved', provider },
    }));
    expect(complete.status).toBe('partial');
    expect(complete.errors.some(error => error.stage === 'endpoint-provider')).toBe(true);
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
        apiGroups: ['CONTAINERS'],
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

describe('buildSocketInventory response bounds', () => {
  function labels(count: number): Record<string, string> {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [`label-${index}`, `value-${index}`]));
  }

  function publishedPorts(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      privatePort: 1000 + index,
      publicPort: 2000 + index,
      ip: index === count - 1 ? '' : '127.0.0.1',
      protocol: 'tcp',
    }));
  }

  function network(name: string) {
    return { name, id: null, ipAddress: null };
  }

  it.each<[number, boolean]>([
    [63, false],
    [64, false],
    [65, true],
  ])('keeps %i labels complete only up to the response cap', (count, truncated) => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ labels: labels(count) })],
    }));
    const [container] = inventory.containers;
    expect(container.labels).toHaveLength(Math.min(count, 64));
    expect(container.metadataTruncated).toBe(truncated);
    expect(inventory.status).toBe(truncated ? 'partial' : 'complete');
  });

  it.each<[number, boolean]>([
    [7, false],
    [8, false],
    [9, true],
  ])('marks %i socket mounts complete only up to the response cap', (count, truncated) => {
    const mounts = Array.from({ length: count }, () => socketMount(SOCKET, SOCKET, true));
    // The ninth, omitted mount is writable: classification must still read it.
    if (count > 8) mounts[count - 1] = socketMount(SOCKET, SOCKET, false);
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ mounts })],
    }));
    const [container] = inventory.containers;
    expect(container.socketMounts).toHaveLength(Math.min(count, 8));
    expect(container.metadataTruncated).toBe(truncated);
    expect(inventory.status).toBe(truncated ? 'partial' : 'complete');
    if (truncated) expect(container.evidence).toContain('socket-mount-writable');
  });

  it.each<[number, boolean]>([
    [15, false],
    [16, false],
    [17, true],
  ])('marks %i published ports complete only up to the response cap', (count, truncated) => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ ports: publishedPorts(count) })],
    }));
    const [container] = inventory.containers;
    expect(container.publishedPorts).toHaveLength(Math.min(count, 16));
    expect(container.metadataTruncated).toBe(truncated);
    expect(inventory.status).toBe(truncated ? 'partial' : 'complete');
  });

  it('marks a wildcard binding dropped by the published-port cap incomplete', () => {
    const ports = Array.from({ length: 16 }, (_, index) => ({
      privatePort: 1000 + index,
      publicPort: 2000 + index,
      ip: '127.0.0.1',
      protocol: 'tcp',
    }));
    ports.push({ privatePort: 1016, publicPort: 2016, ip: '0.0.0.0', protocol: 'tcp' });
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({ ports })],
    }));
    const [container] = inventory.containers;
    expect(container.publishedPorts).toHaveLength(16);
    expect(container.publishedPorts.every(port => !port.allInterfaces)).toBe(true);
    expect(container.metadataTruncated).toBe(true);
    expect(inventory.status).toBe('partial');

    const boundary = buildSocketInventory(input({
      containers: [proxyRow({ ports: ports.slice(0, 15).concat([ports[16]]) })],
    }));
    expect(boundary.containers[0].publishedPorts).toHaveLength(16);
    expect(boundary.containers[0].publishedPorts.some(port => port.allInterfaces)).toBe(true);
    expect(boundary.status).toBe('complete');
  });

  it.each<[number, boolean]>([
    [15, false],
    [16, false],
    [17, true],
  ])('marks %i networks complete only up to the response cap', (count, truncated) => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({
        networks: Array.from({ length: count }, (_, index) => network(`net-${index}`)),
      })],
    }));
    const [container] = inventory.containers;
    expect(container.networks).toHaveLength(Math.min(count, 16));
    expect(container.metadataTruncated).toBe(truncated);
    expect(inventory.status).toBe(truncated ? 'partial' : 'complete');
  });

  it.each<[number, boolean]>([
    [15, false],
    [16, false],
    [17, true],
  ])('marks %i exposed ports complete only up to the response cap', (count, truncated) => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({
        exposedPorts: Array.from({ length: count }, (_, index) => `${1000 + index}/tcp`),
      })],
    }));
    const [container] = inventory.containers;
    expect(container.exposedPorts).toHaveLength(Math.min(count, 16));
    expect(container.metadataTruncated).toBe(truncated);
    expect(inventory.status).toBe(truncated ? 'partial' : 'complete');
    if (truncated) {
      expect(inventory.errors.some(error => error.stage === 'container-metadata')).toBe(true);
    }
  });

  it('bounds untrusted port ip and protocol strings', () => {
    const inventory = buildSocketInventory(input({
      containers: [proxyRow({
        ports: [{
          privatePort: 8080,
          publicPort: 8080,
          ip: `10.0.0.1${'x'.repeat(5000)}`,
          protocol: `tcp${'y'.repeat(5000)}`,
        }],
      })],
    }));
    const [port] = inventory.containers[0].publishedPorts;
    expect(port.ip).not.toBeNull();
    expect(port.ip?.length ?? 0).toBeLessThanOrEqual(64);
    expect(port.protocol.length).toBeLessThanOrEqual(32);
    expect(port.allInterfaces).toBe(false);
  });
});

describe('loadSocketInventory', () => {
  function deps(overrides: Partial<SocketInventoryDeps> = {}): SocketInventoryDeps {
    return {
      docker: {
        listContainersForSocketInventory: vi.fn().mockResolvedValue({
          rows: [], listedContainers: 0, truncated: false,
        }),
        getDockerSocketPath: vi.fn().mockResolvedValue(null),
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
        getDockerSocketPath: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(loadSocketInventory(1, depsWithFailure))
      .rejects.toBeInstanceOf(SocketInventoryUnavailableError);
  });

  it('redacts credentials from a container list failure log', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const depsWithFailure = deps({
      docker: {
        listContainersForSocketInventory: vi.fn().mockRejectedValue(
          new Error('list failed at unix:///var/run/docker.sock?token=hunter2secret'),
        ),
        getDockerSocketPath: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(loadSocketInventory(1, depsWithFailure))
      .rejects.toBeInstanceOf(SocketInventoryUnavailableError);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('hunter2secret');
    expect(logged).toContain('[redacted]');
    errSpy.mockRestore();
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
      docker: {
        listContainersForSocketInventory: list,
        getDockerSocketPath: vi.fn().mockResolvedValue(null),
      },
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

  it('describes the socket the active Docker client dials, not an assumed path', async () => {
    const socketPath = vi.fn().mockResolvedValue('/home/operator/.docker/run/docker.sock');
    const original = process.env.DOCKER_HOST;
    try {
      delete process.env.DOCKER_HOST;
      const inventory = await loadSocketInventory(1, deps({
        docker: {
          listContainersForSocketInventory: vi.fn().mockResolvedValue({
            rows: [], listedContainers: 0, truncated: false,
          }),
          getDockerSocketPath: socketPath,
        },
      }));
      expect(socketPath).toHaveBeenCalledTimes(1);
      expect(inventory.endpoint).toMatchObject({
        address: 'unix:///home/operator/.docker/run/docker.sock',
        addressSource: 'default',
      });

      socketPath.mockClear();
      process.env.DOCKER_HOST = 'unix:///run/explicit.sock';
      const explicit = await loadSocketInventory(1, deps({
        docker: {
          listContainersForSocketInventory: vi.fn().mockResolvedValue({
            rows: [], listedContainers: 0, truncated: false,
          }),
          getDockerSocketPath: socketPath,
        },
      }));
      expect(explicit.endpoint).toMatchObject({
        address: 'unix:///run/explicit.sock',
        addressSource: 'env',
      });
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = original;
    }
  });

  it('marks the endpoint undetermined when the client socket cannot be resolved', async () => {
    const original = process.env.DOCKER_HOST;
    try {
      delete process.env.DOCKER_HOST;
      const inventory = await loadSocketInventory(1, deps({
        docker: {
          listContainersForSocketInventory: vi.fn().mockResolvedValue({
            rows: [], listedContainers: 0, truncated: false,
          }),
          getDockerSocketPath: vi.fn().mockRejectedValue(new Error('modem unavailable')),
        },
      }));
      expect(inventory.endpoint).toMatchObject({
        transport: 'unix',
        address: null,
        detection: 'undetermined',
      });
      expect(inventory.endpoint.evidence).toContain('socket-client-endpoint-unresolved');
      expect(inventory.status).toBe('partial');
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = original;
    }
  });

  it('does not treat an unidentified runtime as proof of direct host access', async () => {
    const original = process.env.DOCKER_HOST;
    try {
      delete process.env.DOCKER_HOST;
      const inventory = await loadSocketInventory(1, deps({
        docker: {
          listContainersForSocketInventory: vi.fn().mockResolvedValue({
            rows: [], listedContainers: 0, truncated: false,
          }),
          getDockerSocketPath: vi.fn().mockResolvedValue('/var/run/docker.sock'),
        },
      }));
      expect(inventory.endpoint).toMatchObject({
        transport: 'unix',
        address: 'unix:///var/run/docker.sock',
        detection: 'undetermined',
        sencho: { state: 'none', inContainer: null },
      });
      expect(inventory.status).toBe('partial');
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = original;
    }
  });

  it('marks the endpoint undetermined when the client resolves a relative socket path', async () => {
    const original = process.env.DOCKER_HOST;
    try {
      delete process.env.DOCKER_HOST;
      const inventory = await loadSocketInventory(1, deps({
        docker: {
          listContainersForSocketInventory: vi.fn().mockResolvedValue({
            rows: [], listedContainers: 0, truncated: false,
          }),
          getDockerSocketPath: vi.fn().mockResolvedValue('var/run/docker.sock'),
        },
      }));
      expect(inventory.endpoint).toMatchObject({
        transport: 'unix',
        address: 'unix://var/run/docker.sock',
        detection: 'undetermined',
      });
      expect(inventory.endpoint.evidence).toContain('socket-path-relative');
      expect(inventory.status).toBe('partial');
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

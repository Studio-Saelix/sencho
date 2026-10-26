/**
 * The Docker endpoint guard: refuses a lifecycle operation that would stop or
 * recreate the container carrying this node's Docker API (Sencho itself, or the
 * socket proxy it reaches Docker through), and only that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockListContainers, mockGetContainer, mockResolveProvider, mockGetNode } = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockGetContainer: vi.fn(),
  mockResolveProvider: vi.fn(),
  mockGetNode: vi.fn(),
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({ getDocker: () => ({ listContainers: mockListContainers, getContainer: mockGetContainer }) }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({ getNode: mockGetNode, getComposeDir: () => '/srv/compose' }),
  },
}));

vi.mock('../services/DockerEndpointProvider', () => ({
  resolveDockerEndpointProvider: mockResolveProvider,
}));

import SelfIdentityService from '../services/SelfIdentityService';
import { DockerEndpointProtectedError, dockerEndpointRefusalOf } from '../helpers/dockerEndpointError';
import {
  evaluateDockerEndpointContainer,
  evaluateDockerEndpointGuard,
  INFRASTRUCTURE_LABEL,
  readInfrastructureLabels,
  type EndpointGuardProbes,
  type EndpointMutation,
} from '../helpers/dockerEndpointGuard';

const SELF_ID = 'a'.repeat(64);
const PROXY_ID = 'b'.repeat(64);
const WEB_ID = 'c'.repeat(64);
const VPN_ID = 'e'.repeat(64);

function container(
  id: string,
  service: string,
  over: { project?: string; hash?: string; networks?: string[]; imageId?: string; labels?: Record<string, string> } = {},
) {
  const project = over.project ?? 'sencho';
  return {
    Id: id,
    Names: [`/${service}`],
    ImageID: over.imageId,
    Labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.service': service,
      'com.docker.compose.project.working_dir': `/srv/compose/${project}`,
      'com.docker.compose.config-hash': over.hash ?? 'hash-current',
      ...over.labels,
    },
    NetworkSettings: { Networks: Object.fromEntries((over.networks ?? []).map(name => [name, { NetworkID: `id-${name}` }])) },
  };
}

const senchoContainer = container(SELF_ID, 'sencho');
const proxyContainer = container(PROXY_ID, 'socket-proxy');
const webContainer = container(WEB_ID, 'web');

function providerFor(service: string, project: string | null = 'sencho') {
  return {
    state: 'resolved' as const,
    provider: { containerId: PROXY_ID, containerName: service, project, service, workingDir: null, socketBindSource: null },
  };
}

function stubSelf(state: 'resolved' | 'none' | 'unresolved') {
  const self = SelfIdentityService.getInstance();
  vi.spyOn(self, 'ensureResolved').mockResolvedValue(state);
  vi.spyOn(self, 'getUnresolvedReason').mockReturnValue(state === 'unresolved' ? 'HOSTNAME inspect failed: 403' : null);
  vi.spyOn(self, 'isOwnContainer').mockImplementation(id => state === 'resolved' && id === SELF_ID);
  vi.spyOn(self, 'getIdentity').mockReturnValue({
    containerId: state === 'resolved' ? SELF_ID : null,
    containerName: 'sencho',
    composeProjectName: state === 'resolved' ? 'sencho' : null,
    imageId: null,
    networkNames: [],
    volumeNames: [],
  });
  vi.spyOn(self, 'isOwnNetwork').mockImplementation(name => state === 'resolved' && (name === 'proxy-net' || name === 'id-proxy-net'));
  vi.spyOn(self, 'getComposeLocation').mockReturnValue({ service: 'sencho', workingDir: '/srv/compose/sencho' });
}

function probes(over: Partial<EndpointGuardProbes> = {}): EndpointGuardProbes {
  return {
    renderConfig: vi.fn().mockResolvedValue('services: {}\n'),
    configHash: vi.fn().mockResolvedValue('hash-current'),
    localImage: vi.fn().mockResolvedValue({ state: 'unknown' }),
    ...over,
  };
}

function run(mutation: EndpointMutation, p: EndpointGuardProbes = probes(), stackName = 'sencho') {
  return evaluateDockerEndpointGuard({ nodeId: 1, stackName, mutation, probes: p });
}

/**
 * The namespace modes the running containers were created with, by container id
 * (what `docker inspect` reports whatever the Compose file says now). A
 * container not listed here runs in no shared namespace.
 */
const runtimeModes = new Map<string, { name?: string; modes: { NetworkMode?: string; PidMode?: string; IpcMode?: string } }>();

const originalHostname = process.env.HOSTNAME;

beforeEach(() => {
  vi.clearAllMocks();
  runtimeModes.clear();
  mockGetContainer.mockImplementation((ref: string) => ({
    inspect: async () => {
      const found = [...runtimeModes].find(([id, entry]) => id === ref || id.startsWith(ref) || entry.name === ref);
      return { Id: found?.[0] ?? ref, Name: found?.[1].name ? `/${found[1].name}` : undefined, HostConfig: found?.[1].modes ?? {} };
    },
  }));
  mockGetNode.mockReturnValue({ id: 1, type: 'local' });
  mockResolveProvider.mockResolvedValue({ state: 'none', reason: 'local socket' });
  mockListContainers.mockResolvedValue([senchoContainer, proxyContainer, webContainer]);
  stubSelf('resolved');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHostname === undefined) delete process.env.HOSTNAME;
  else process.env.HOSTNAME = originalHostname;
});

describe('scope', () => {
  it('never evaluates a remote node', async () => {
    mockGetNode.mockReturnValue({ id: 1, type: 'remote' });

    expect(await run({ kind: 'stop' })).toBeNull();
    expect(mockListContainers).not.toHaveBeenCalled();
  });

  it('allows anything on a stack with no containers', async () => {
    mockListContainers.mockResolvedValue([]);
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    expect(await run({ kind: 'stop' })).toBeNull();
  });

  it('ignores containers of other stacks', async () => {
    mockListContainers.mockResolvedValue([senchoContainer, container(WEB_ID, 'web', { project: 'blog' })]);

    expect(await run({ kind: 'stop' }, probes(), 'blog')).toBeNull();
  });

  it('matches a stack by working directory when the project name differs', async () => {
    const renamed = { ...senchoContainer, Labels: { ...senchoContainer.Labels, 'com.docker.compose.project': 'renamed' } };
    mockListContainers.mockResolvedValue([renamed]);

    const refusal = await run({ kind: 'stop' });

    expect(refusal?.reason).toBe('sencho');
  });
});

describe('Sencho in the stack', () => {
  it.each<EndpointMutation>([{ kind: 'stop' }, { kind: 'update' }])('refuses %o and names Reapply', async (mutation) => {
    const refusal = await run(mutation);

    expect(refusal).toMatchObject({ reason: 'sencho', service: 'sencho' });
    expect(refusal?.message).toContain('Reapply');
  });

  it('keeps restart allowed, which is the intended way to bounce Sencho', async () => {
    expect(await run({ kind: 'restart' })).toBeNull();
    expect(await run({ kind: 'service', service: 'sencho', restart: true })).toBeNull();
  });

  it('refuses a service-scoped stop of Sencho but not of a sibling', async () => {
    expect(await run({ kind: 'service', service: 'sencho' })).toMatchObject({ reason: 'sencho' });
    expect(await run({ kind: 'service', service: 'web' })).toBeNull();
  });

  it('allows a deploy that leaves Sencho unchanged and refuses one that would recreate it', async () => {
    expect(await run({ kind: 'up' }, probes({ configHash: vi.fn().mockResolvedValue('hash-current') }))).toBeNull();

    const refusal = await run({ kind: 'up' }, probes({ configHash: vi.fn().mockResolvedValue('hash-new') }));

    expect(refusal).toMatchObject({ reason: 'sencho', service: 'sencho' });
  });
});

describe('the Docker socket proxy', () => {
  beforeEach(() => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
  });

  it.each<EndpointMutation>([{ kind: 'stop' }, { kind: 'restart' }, { kind: 'update' }])('refuses %o', async (mutation) => {
    // Sencho is not part of this stack, so only the proxy is in play.
    mockListContainers.mockResolvedValue([proxyContainer, webContainer]);

    const refusal = await run(mutation);

    expect(refusal).toMatchObject({ reason: 'provider', service: 'socket-proxy' });
    expect(refusal?.message).toContain('Docker connection');
  });

  it('points to Reapply when the stack holds Sencho itself, and to the host for a proxy in a separate project', async () => {
    const shared = await run({ kind: 'stop' });
    expect(shared?.message).toContain('Reapply');

    mockListContainers.mockResolvedValue([container(PROXY_ID, 'socket-proxy', { project: 'infra' })]);
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy', 'infra'));
    const separate = await run({ kind: 'stop' }, probes(), 'infra');
    expect(separate?.message).toContain('from the host');
    expect(separate?.message).not.toContain('Reapply');
  });

  it('lets a service-scoped operation on another service through', async () => {
    mockListContainers.mockResolvedValue([proxyContainer, webContainer]);

    expect(await run({ kind: 'service', service: 'web' })).toBeNull();
    expect(await run({ kind: 'service', service: 'socket-proxy' })).toMatchObject({ reason: 'provider' });
  });

  it('lets an unchanged deploy through, since compose will not recreate the proxy', async () => {
    mockListContainers.mockResolvedValue([proxyContainer, webContainer]);
    const p = probes();

    expect(await run({ kind: 'up' }, p)).toBeNull();
    expect(p.configHash).toHaveBeenCalledWith('socket-proxy');
  });

  it('refuses a deploy that would recreate the proxy (the config hash moved)', async () => {
    mockListContainers.mockResolvedValue([proxyContainer, webContainer]);

    const refusal = await run({ kind: 'up' }, probes({ configHash: vi.fn().mockResolvedValue('hash-new') }));

    expect(refusal).toMatchObject({ reason: 'provider', service: 'socket-proxy' });
  });

  it('refuses a deploy when the hash cannot be computed, because it cannot be proved safe', async () => {
    mockListContainers.mockResolvedValue([proxyContainer, webContainer]);

    const refusal = await run({ kind: 'up' }, probes({ configHash: vi.fn().mockResolvedValue(null) }));

    expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
    expect(refusal?.message).toContain('configuration hash');
  });

  it('refuses a deploy that would recreate the proxy because its local image id moved, with the hash unchanged', async () => {
    mockListContainers.mockResolvedValue([{ ...proxyContainer, ImageID: 'sha256:old' }, webContainer]);
    const rendered = 'services:\n  socket-proxy:\n    image: proxy:latest\n';
    const localImage = vi.fn().mockResolvedValue({ state: 'id', id: 'sha256:new' });

    const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered), localImage }));

    expect(localImage).toHaveBeenCalledWith('proxy:latest');
    expect(refusal).toMatchObject({ reason: 'provider', service: 'socket-proxy' });
  });

  it('allows a deploy when the hash and the local image id both match', async () => {
    mockListContainers.mockResolvedValue([{ ...proxyContainer, ImageID: 'sha256:same' }, webContainer]);
    const rendered = 'services:\n  socket-proxy:\n    image: proxy:latest\n';

    const refusal = await run({ kind: 'up' }, probes({
      renderConfig: vi.fn().mockResolvedValue(rendered),
      localImage: vi.fn().mockResolvedValue({ state: 'id', id: 'same' }),
    }));

    expect(refusal).toBeNull();
  });

  it('refuses a deploy when the proxy image cannot be inspected, rather than guessing', async () => {
    mockListContainers.mockResolvedValue([{ ...proxyContainer, ImageID: 'sha256:old' }, webContainer]);
    const rendered = 'services:\n  socket-proxy:\n    image: proxy:latest\n';

    const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered) }));

    expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
  });

  it('refuses a deploy whose digest-pin overlay rewrites the proxy image, which the config hash cannot see', async () => {
    mockListContainers.mockResolvedValue([proxyContainer, webContainer]);

    const refusal = await run({ kind: 'up', pinnedServices: ['socket-proxy'] });

    expect(refusal).toMatchObject({ reason: 'provider', service: 'socket-proxy' });
    expect(await run({ kind: 'up', pinnedServices: ['web'] })).toBeNull();
  });

  it.each(['always', 'refresh', 'daily', 'weekly', 'every_12h'])('refuses a deploy of a proxy with pull_policy %s, which can replace the image behind an unchanged hash', async (policy) => {
    mockListContainers.mockResolvedValue([{ ...proxyContainer, ImageID: 'sha256:same' }, webContainer]);
    const rendered = `services:\n  socket-proxy:\n    image: proxy:latest\n    pull_policy: ${policy}\n`;

    const refusal = await run({ kind: 'up' }, probes({
      renderConfig: vi.fn().mockResolvedValue(rendered),
      localImage: vi.fn().mockResolvedValue({ state: 'id', id: 'same' }),
    }));

    expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
    expect(refusal?.message).toContain('pull policy');
  });

  it('refuses a deploy of a proxy with pull_policy build, whose rebuild the hash and the local image id cannot see', async () => {
    mockListContainers.mockResolvedValue([{ ...proxyContainer, ImageID: 'sha256:same' }, webContainer]);
    const rendered = 'services:\n  socket-proxy:\n    image: proxy:latest\n    build: .\n    pull_policy: build\n';

    const refusal = await run({ kind: 'up' }, probes({
      renderConfig: vi.fn().mockResolvedValue(rendered),
      localImage: vi.fn().mockResolvedValue({ state: 'id', id: 'same' }),
    }));

    expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
    expect(refusal?.message).toContain('pull policy');
  });

  it('refuses a deploy of a build-only proxy with pull_policy build, which has no image to compare', async () => {
    mockListContainers.mockResolvedValue([proxyContainer, webContainer]);
    const rendered = 'services:\n  socket-proxy:\n    build: .\n    pull_policy: build\n';

    const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered) }));

    expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
  });

  it('refuses a deploy when a service the proxy is wired to would be rebuilt, which restarts the proxy', async () => {
    mockListContainers.mockResolvedValue([proxyContainer, container('d'.repeat(64), 'vpn')]);
    const rendered = 'services:\n  socket-proxy:\n    network_mode: service:vpn\n  vpn:\n    build: .\n    pull_policy: build\n';

    const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered) }));

    expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
  });

  it('refuses a deploy of Sencho itself behind pull_policy build', async () => {
    const rendered = 'services:\n  sencho:\n    build: .\n    pull_policy: build\n';

    expect(await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered) }))).toMatchObject({ reason: 'unresolved', service: 'sencho' });
  });

  it('lets a deploy through for a proxy that has a build section but the default pull policy, which builds only when the image is missing', async () => {
    mockListContainers.mockResolvedValue([{ ...proxyContainer, ImageID: 'sha256:same' }, webContainer]);
    const rendered = 'services:\n  socket-proxy:\n    image: proxy:latest\n    build: .\n';

    expect(await run({ kind: 'up' }, probes({
      renderConfig: vi.fn().mockResolvedValue(rendered),
      localImage: vi.fn().mockResolvedValue({ state: 'id', id: 'same' }),
    }))).toBeNull();
  });

  it('lets a deploy through for a proxy whose pull policy never pulls', async () => {
    mockListContainers.mockResolvedValue([{ ...proxyContainer, ImageID: 'sha256:same' }, webContainer]);
    const rendered = 'services:\n  socket-proxy:\n    image: proxy:latest\n    pull_policy: missing\n';

    expect(await run({ kind: 'up' }, probes({
      renderConfig: vi.fn().mockResolvedValue(rendered),
      localImage: vi.fn().mockResolvedValue({ state: 'id', id: 'same' }),
    }))).toBeNull();
  });

  it('words an unpredictable recreate for the role: Sencho points to Reapply, a possible provider is not asserted to be one', async () => {
    const unknownHash = probes({ configHash: vi.fn().mockResolvedValue(null) });

    const sencho = await run({ kind: 'up' }, unknownHash);
    expect(sencho).toMatchObject({ reason: 'unresolved', service: 'sencho' });
    expect(sencho?.message).toContain('is the running Sencho instance');
    expect(sencho?.message).toContain('Reapply');

    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'dns' });
    mockListContainers.mockResolvedValue([container(PROXY_ID, 'socket-proxy', { project: 'infra', networks: ['proxy-net'] })]);
    const possible = await run({ kind: 'up' }, unknownHash, 'infra');
    expect(possible?.message).toContain('may carry its Docker connection');
    expect(possible?.message).not.toContain('Reapply');
  });

  it('still protects the proxy when it was recreated and the cached provider names its old id', async () => {
    const recreated = container('e'.repeat(64), 'socket-proxy');
    mockListContainers.mockResolvedValue([recreated, webContainer]);

    const refusal = await run({ kind: 'stop' });

    expect(refusal).toMatchObject({ reason: 'provider', service: 'socket-proxy' });
  });

  it('refuses when only one replica of the proxy is stale', async () => {
    mockListContainers.mockResolvedValue([
      proxyContainer,
      { ...container('d'.repeat(64), 'socket-proxy', { hash: 'hash-old' }) },
    ]);
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    // Only the resolved provider container is protected; its sibling replica
    // shares the service, so the service-level hash check sees the stale one.
    const refusal = await run({ kind: 'up' });

    expect(refusal?.reason).toBe('provider');
  });


  describe('services the protected service is wired to', () => {
    const hashOf = (changed: string[]) => vi.fn(async (service: string) => (changed.includes(service) ? 'hash-new' : 'hash-current'));

    it.each([
      ['depends_on with restart: true', 'socket-proxy:\n    depends_on:\n      dep:\n        condition: service_started\n        restart: true'],
      ['pid: service', 'socket-proxy:\n    pid: service:dep'],
      ['ipc: service', 'socket-proxy:\n    ipc: service:dep'],
      ['network_mode: service', 'socket-proxy:\n    network_mode: service:dep'],
      ['volumes_from', 'socket-proxy:\n    volumes_from: [dep:ro]'],
      ['links', 'socket-proxy:\n    links: ["dep:alias"]'],
    ])('refuses a deploy that recreates a service the proxy reaches through %s, with the proxy itself unchanged', async (_name, proxyYaml) => {
      mockListContainers.mockResolvedValue([proxyContainer, container('d'.repeat(64), 'dep'), webContainer]);
      const rendered = `services:\n  ${proxyYaml}\n  dep:\n    command: run\n`;

      const refusal = await run({ kind: 'up' }, probes({
        renderConfig: vi.fn().mockResolvedValue(rendered),
        configHash: hashOf(['dep']),
        localImage: vi.fn().mockResolvedValue({ state: 'unknown' }),
      }));

      expect(refusal).toMatchObject({ service: 'socket-proxy' });
    });

    it('follows the links transitively', async () => {
      mockListContainers.mockResolvedValue([proxyContainer, container('d'.repeat(64), 'dep'), container('e'.repeat(64), 'leaf'), webContainer]);
      const rendered = 'services:\n  socket-proxy:\n    links: [dep]\n  dep:\n    links: [leaf]\n  leaf:\n    image: leaf:latest\n';

      const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered), configHash: hashOf(['leaf']) }));

      expect(refusal).toMatchObject({ reason: 'provider', service: 'socket-proxy' });
    });

    it.each([
      ['a plain depends_on list', 'socket-proxy:\n    depends_on: [dep]'],
      ['a depends_on map without restart', 'socket-proxy:\n    depends_on:\n      dep:\n        condition: service_started'],
    ])('lets a deploy through that recreates a service the proxy only waits for (%s)', async (_name, proxyYaml) => {
      mockListContainers.mockResolvedValue([proxyContainer, container('d'.repeat(64), 'dep'), webContainer]);
      const rendered = `services:\n  ${proxyYaml}\n  dep:\n    command: run\n`;

      expect(await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered), configHash: hashOf(['dep']) }))).toBeNull();
    });

    it('lets the deploy through when everything the proxy is wired to is unchanged, or is not in the rendered project', async () => {
      mockListContainers.mockResolvedValue([proxyContainer, container('d'.repeat(64), 'dep'), webContainer]);
      const rendered = 'services:\n  socket-proxy:\n    depends_on: [dep, profiled-out]\n  dep:\n    command: run\n';
      const p = probes({ renderConfig: vi.fn().mockResolvedValue(rendered), configHash: hashOf(['web']) });

      expect(await run({ kind: 'up' }, p)).toBeNull();
      expect(p.configHash).not.toHaveBeenCalledWith('profiled-out');
    });

    it('refuses when what the proxy is wired to cannot be predicted', async () => {
      mockListContainers.mockResolvedValue([proxyContainer, container('d'.repeat(64), 'dep')]);
      const rendered = 'services:\n  socket-proxy:\n    links: [dep]\n  dep:\n    image: dep:latest\n    pull_policy: always\n';

      const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered) }));

      expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
    });

    it('applies to Sencho too: a deploy that recreates a service Sencho is wired to is refused', async () => {
      mockListContainers.mockResolvedValue([senchoContainer, container('d'.repeat(64), 'dep')]);
      const rendered = 'services:\n  sencho:\n    volumes_from: [dep]\n  dep:\n    image: dep:latest\n';

      const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered), configHash: hashOf(['dep']) }));

      expect(refusal).toMatchObject({ reason: 'sencho', service: 'sencho' });
    });
  });

  describe('services that own a namespace the protected service runs in', () => {
    const vpnContainer = container('d'.repeat(64), 'vpn');
    const siblingContainer = container('e'.repeat(64), 'sibling');
    const rendered = 'services:\n  socket-proxy:\n    network_mode: service:vpn\n  vpn:\n    command: run\n  sibling:\n    network_mode: service:vpn\n';
    const renderedProbes = (changed: string[] = [], renderedYaml = rendered) => probes({
      renderConfig: vi.fn().mockResolvedValue(renderedYaml),
      configHash: vi.fn(async (service: string) => (changed.includes(service) ? 'hash-new' : 'hash-current')),
    });
    const withProviderStack = () => {
      mockListContainers.mockResolvedValue([senchoContainer, proxyContainer, vpnContainer, siblingContainer]);
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
    };

    it.each([
      ['restart', { kind: 'service', service: 'vpn', restart: true }],
      ['recreate', { kind: 'service', service: 'vpn', restart: false }],
    ] as const)('refuses a service-scoped %s of the owner, naming the service that runs in it', async (_name, mutation) => {
      withProviderStack();

      const refusal = await run(mutation, renderedProbes());

      expect(refusal).toMatchObject({ reason: 'provider', service: 'vpn' });
      expect(refusal?.message).toContain('"socket-proxy"');
    });

    it('refuses a deploy that recreates only the owner, but not one that recreates a service that merely shares it', async () => {
      withProviderStack();

      expect(await run({ kind: 'up' }, renderedProbes(['vpn']))).toMatchObject({ reason: 'provider' });
      expect(await run({ kind: 'up' }, renderedProbes(['sibling']))).toBeNull();
    });

    it('leaves a service that merely shares the owner, or runs in the proxy\'s own namespace, alone', async () => {
      withProviderStack();
      const consumer = 'services:\n  socket-proxy:\n    command: run\n  sibling:\n    network_mode: service:socket-proxy\n';

      expect(await run({ kind: 'service', service: 'sibling', restart: true }, renderedProbes())).toBeNull();
      expect(await run({ kind: 'service', service: 'sibling', restart: false }, renderedProbes())).toBeNull();
      expect(await run({ kind: 'service', service: 'sibling', restart: true }, renderedProbes([], consumer))).toBeNull();
    });

    it.each(['pid', 'ipc'])('treats %s: service as a shared namespace', async (key) => {
      withProviderStack();
      const yaml = `services:\n  socket-proxy:\n    ${key}: service:vpn\n  vpn:\n    command: run\n`;

      expect(await run({ kind: 'service', service: 'vpn', restart: true }, renderedProbes([], yaml))).toMatchObject({ reason: 'provider', service: 'vpn' });
    });

    it('follows the owners transitively', async () => {
      mockListContainers.mockResolvedValue([senchoContainer, proxyContainer, vpnContainer, container('f'.repeat(64), 'host-net')]);
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      const yaml = 'services:\n  socket-proxy:\n    network_mode: service:vpn\n  vpn:\n    network_mode: service:host-net\n  host-net:\n    command: run\n';

      expect(await run({ kind: 'service', service: 'host-net', restart: true }, renderedProbes([], yaml))).toMatchObject({ reason: 'provider', service: 'host-net' });
    });

    it('names, for each owner, the protected service that runs in it', async () => {
      mockListContainers.mockResolvedValue([
        senchoContainer,
        container('b'.repeat(64), 'proxy-a', { labels: { 'io.sencho.infrastructure': 'true' } }),
        container('c'.repeat(64), 'proxy-b', { labels: { 'io.sencho.infrastructure': 'true' } }),
        container('d'.repeat(64), 'vpn-a'),
        container('e'.repeat(64), 'vpn-b'),
      ]);
      const yaml = 'services:\n  proxy-a:\n    network_mode: service:vpn-a\n    labels:\n      io.sencho.infrastructure: "true"\n  proxy-b:\n    network_mode: service:vpn-b\n    labels:\n      io.sencho.infrastructure: "true"\n  vpn-a:\n    command: run\n  vpn-b:\n    command: run\n';

      const refusal = await run({ kind: 'service', service: 'vpn-b', restart: true }, renderedProbes([], yaml));

      expect(refusal).toMatchObject({ reason: 'provider', service: 'vpn-b' });
      expect(refusal?.message).toContain('"proxy-b"');
      expect(refusal?.message).not.toContain('"proxy-a"');
    });

    it('protects the owner of Sencho\'s own namespace, and a restart of it is not exempt like a restart of Sencho', async () => {
      mockListContainers.mockResolvedValue([senchoContainer, vpnContainer]);
      const yaml = 'services:\n  sencho:\n    network_mode: service:vpn\n  vpn:\n    command: run\n';

      expect(await run({ kind: 'service', service: 'sencho', restart: true }, renderedProbes([], yaml))).toBeNull();
      expect(await run({ kind: 'service', service: 'vpn', restart: true }, renderedProbes([], yaml))).toMatchObject({ reason: 'sencho', service: 'vpn' });
    });
  });

  describe('namespace owners read from the running containers, whatever the file says now', () => {
    const VPN_ID = 'd'.repeat(64);
    const vpn = container(VPN_ID, 'vpn');
    const sibling = container('e'.repeat(64), 'sibling');
    // The file no longer declares the namespace the proxy still runs in.
    const edited = 'services:\n  socket-proxy:\n    command: run\n  vpn:\n    command: run\n  sibling:\n    command: run\n';
    const editedProbes = (changed: string[] = []) => probes({
      renderConfig: vi.fn().mockResolvedValue(edited),
      configHash: vi.fn(async (service: string) => (changed.includes(service) ? 'hash-new' : 'hash-current')),
    });
    const withProxyIn = (mode: 'NetworkMode' | 'PidMode' | 'IpcMode', reference: string) => {
      mockListContainers.mockResolvedValue([senchoContainer, proxyContainer, vpn, sibling]);
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      runtimeModes.set(PROXY_ID, { name: 'socket-proxy', modes: { [mode]: reference } });
    };

    it.each(['NetworkMode', 'PidMode', 'IpcMode'] as const)('keeps the %s owner protected after the reference is removed from the file', async (mode) => {
      withProxyIn(mode, `container:${VPN_ID}`);

      for (const mutation of [
        { kind: 'service', service: 'vpn', restart: false },
        { kind: 'service', service: 'vpn', restart: true },
      ] as EndpointMutation[]) {
        expect(await run(mutation, editedProbes())).toMatchObject({ reason: 'provider', service: 'vpn' });
      }
      expect(await run({ kind: 'up' }, editedProbes(['vpn']))).toMatchObject({ reason: 'provider', service: 'vpn' });
      expect((await run({ kind: 'service', service: 'vpn' }, editedProbes()))?.message).toContain('"socket-proxy"');
    });

    it('keeps the owner protected for stack-wide stop and update when Sencho is not in the stack', async () => {
      withProxyIn('NetworkMode', `container:${VPN_ID}`);
      mockListContainers.mockResolvedValue([vpn, sibling]);
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy', 'edge'));

      expect(await run({ kind: 'stop' }, editedProbes())).toMatchObject({ reason: 'provider', service: 'vpn' });
      expect(await run({ kind: 'update' }, editedProbes())).toMatchObject({ reason: 'provider', service: 'vpn' });
    });

    it('matches an owner the proxy references by name', async () => {
      withProxyIn('NetworkMode', 'container:vpn');

      expect(await run({ kind: 'service', service: 'vpn', restart: true }, editedProbes())).toMatchObject({ reason: 'provider', service: 'vpn' });
    });

    it('leaves an unrelated sibling and a deploy that leaves the owner unchanged alone', async () => {
      withProxyIn('NetworkMode', `container:${VPN_ID}`);

      expect(await run({ kind: 'service', service: 'sibling', restart: true }, editedProbes())).toBeNull();
      expect(await run({ kind: 'up' }, editedProbes(['sibling']))).toBeNull();
    });

    it('follows a chain of owners through the running containers', async () => {
      withProxyIn('NetworkMode', `container:${VPN_ID}`);
      runtimeModes.set(VPN_ID, { name: 'vpn', modes: { NetworkMode: `container:${'e'.repeat(64)}` } });

      expect(await run({ kind: 'service', service: 'sibling', restart: true }, editedProbes())).toMatchObject({ reason: 'provider', service: 'sibling' });
    });

    it('protects the owner of Sencho\'s own namespace, and Sencho itself stays restartable', async () => {
      mockListContainers.mockResolvedValue([senchoContainer, vpn]);
      runtimeModes.set(SELF_ID, { name: 'sencho', modes: { PidMode: `container:${VPN_ID}` } });

      expect(await run({ kind: 'service', service: 'vpn', restart: true }, editedProbes())).toMatchObject({ reason: 'sencho', service: 'vpn' });
      expect(await run({ kind: 'service', service: 'sencho', restart: true }, editedProbes())).toBeNull();
    });

    it('protects an owner in this stack for a provider that lives in another project', async () => {
      mockListContainers.mockResolvedValue([container(VPN_ID, 'vpn', { project: 'infra' })]);
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy', 'edge'));
      runtimeModes.set(PROXY_ID, { name: 'socket-proxy', modes: { NetworkMode: `container:${VPN_ID}` } });

      expect(await run({ kind: 'stop' }, editedProbes(), 'infra')).toMatchObject({ reason: 'provider', service: 'vpn' });
    });

    it('refuses as unresolved when the protected container cannot be inspected to read its namespaces', async () => {
      mockListContainers.mockResolvedValue([senchoContainer, proxyContainer, vpn]);
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockGetContainer.mockImplementation(() => ({ inspect: async () => { throw new Error('inspect denied'); } }));

      const refusal = await run({ kind: 'service', service: 'vpn', restart: true }, editedProbes());

      expect(refusal).toMatchObject({ reason: 'unresolved' });
      expect(refusal?.message).toContain('inspect denied');
    });
  });

  describe('a proxy whose configuration hash cannot be compared', () => {
    it.each([
      ['network_mode: service', 'socket-proxy:\n    network_mode: service:vpn'],
      ['volumes_from', 'socket-proxy:\n    volumes_from: [vpn]'],
    ])('refuses as unresolved, not as a recreate, when the hash differs for %s', async (_name, proxyYaml) => {
      mockListContainers.mockResolvedValue([proxyContainer, container('d'.repeat(64), 'vpn')]);
      const yaml = `services:\n  ${proxyYaml}\n  vpn:\n    command: run\n`;

      const refusal = await run({ kind: 'up' }, probes({
        renderConfig: vi.fn().mockResolvedValue(yaml),
        configHash: vi.fn(async (service: string) => (service === 'socket-proxy' ? 'rendered-hash' : 'hash-current')),
      }));

      expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
      expect(refusal?.message).toContain('never equals the one Compose renders');
      expect(refusal?.message).not.toContain('did not report its configuration hash');
    });

    it('treats volumes_from naming a container the same way', async () => {
      mockListContainers.mockResolvedValue([proxyContainer]);
      const yaml = 'services:\n  socket-proxy:\n    volumes_from: ["container:data"]\n';

      const refusal = await run({ kind: 'up' }, probes({
        renderConfig: vi.fn().mockResolvedValue(yaml),
        configHash: vi.fn().mockResolvedValue('rendered-hash'),
      }));

      expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
      expect(refusal?.message).toContain('never equals the one Compose renders');
    });

    it('still reports a plain proxy with a different hash as recreated', async () => {
      mockListContainers.mockResolvedValue([proxyContainer, container('d'.repeat(64), 'vpn')]);
      const yaml = 'services:\n  socket-proxy:\n    command: run\n  vpn:\n    command: run\n';

      const refusal = await run({ kind: 'up' }, probes({
        renderConfig: vi.fn().mockResolvedValue(yaml),
        configHash: vi.fn(async (service: string) => (service === 'socket-proxy' ? 'rendered-hash' : 'hash-current')),
      }));

      expect(refusal).toMatchObject({ reason: 'provider', service: 'socket-proxy' });
    });
  });

  it('refuses a service-scoped restart of the provider, which only Sencho itself is exempt from', async () => {
    mockListContainers.mockResolvedValue([senchoContainer, proxyContainer, webContainer]);

    expect(await run({ kind: 'service', service: 'socket-proxy', restart: true })).toMatchObject({ reason: 'provider', service: 'socket-proxy' });
    expect(await run({ kind: 'service', service: 'sencho', restart: true })).toBeNull();
  });

  it('still protects a labeled or matched container that has no Compose service label', async () => {
    mockListContainers.mockResolvedValue([
      { ...proxyContainer, Names: ['/orphaned-proxy'], Labels: { 'com.docker.compose.project': 'blog', [INFRASTRUCTURE_LABEL]: 'true' } },
    ]);
    expect(await run({ kind: 'stop' }, probes(), 'blog')).toMatchObject({ reason: 'provider', service: 'orphaned-proxy' });
  });
});

describe('the provider could not be resolved', () => {
  const onProxyNet = container(PROXY_ID, 'socket-proxy', { project: 'infra', networks: ['proxy-net'] });
  const isolated = container(WEB_ID, 'web', { project: 'infra', networks: ['blog_default'] });

  beforeEach(() => {
    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'The Docker endpoint host "socket-proxy" did not resolve' });
  });

  it('refuses a stop of a container that shares a network with Sencho, and says why', async () => {
    mockListContainers.mockResolvedValue([onProxyNet, isolated]);

    const refusal = await run({ kind: 'stop' }, probes(), 'infra');

    expect(refusal).toMatchObject({ reason: 'unresolved', service: 'socket-proxy' });
    expect(refusal?.message).toContain('did not resolve');
  });

  it('lets a stack through whose containers share no network with Sencho', async () => {
    mockListContainers.mockResolvedValue([isolated]);

    expect(await run({ kind: 'stop' }, probes(), 'infra')).toBeNull();
  });

  it('refuses a deploy only for a service that would be recreated', async () => {
    mockListContainers.mockResolvedValue([onProxyNet, isolated]);

    expect(await run({ kind: 'up' }, probes(), 'infra')).toBeNull();
    expect(await run({ kind: 'up' }, probes({ configHash: vi.fn().mockResolvedValue('hash-new') }), 'infra'))
      .toMatchObject({ reason: 'unresolved' });
  });

  it('keeps a service-scoped operation on another service allowed', async () => {
    mockListContainers.mockResolvedValue([onProxyNet, container(WEB_ID, 'web', { project: 'infra', networks: ['proxy-net'] })]);

    expect(await run({ kind: 'service', service: 'web' }, probes(), 'infra')).toMatchObject({ reason: 'unresolved', service: 'web' });
    mockListContainers.mockResolvedValue([onProxyNet, isolated]);
    expect(await run({ kind: 'service', service: 'web' }, probes(), 'infra')).toBeNull();
  });

  it('treats every container as a candidate when Sencho cannot list its own networks', async () => {
    stubSelf('unresolved');
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);
    process.env.HOSTNAME = SELF_ID.slice(0, 12);
    mockListContainers.mockResolvedValue([isolated]);

    expect(await run({ kind: 'stop' }, probes(), 'infra')).toMatchObject({ reason: 'unresolved' });
  });
});

describe('io.sencho.infrastructure', () => {
  const rendered = (value: string) => `services:\n  web:\n    labels:\n      io.sencho.infrastructure: "${value}"\n  other:\n    image: x\n`;

  it('protects a marked service that detection missed', async () => {
    const refusal = await run({ kind: 'stop' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered('true')) }), 'blog');
    expect(refusal).toBeNull();

    mockListContainers.mockResolvedValue([container(WEB_ID, 'web', { project: 'blog' })]);
    const marked = await run({ kind: 'stop' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered('true')) }), 'blog');

    expect(marked).toMatchObject({ reason: 'provider', service: 'web' });
  });

  it('fails closed on any value other than true', async () => {
    mockListContainers.mockResolvedValue([container(WEB_ID, 'web', { project: 'blog' })]);

    const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered('yes')) }), 'blog');

    expect(refusal).toMatchObject({ reason: 'invalid_label', service: 'web' });
    expect(refusal?.message).toContain('"yes"');
  });

  describe('first deployment (no containers yet)', () => {
    beforeEach(() => {
      mockListContainers.mockResolvedValue([]);
    });

    it.each<EndpointMutation>([{ kind: 'up' }, { kind: 'update' }, { kind: 'service', service: 'web' }])(
      'refuses an invalid label before %o runs',
      async (mutation) => {
        const render = vi.fn().mockResolvedValue(rendered('false'));

        const refusal = await run(mutation, probes({ renderConfig: render }), 'blog');

        expect(render).toHaveBeenCalled();
        expect(refusal).toMatchObject({ reason: 'invalid_label', service: 'web' });
      },
    );

    it('allows a label of "true" and an absent label', async () => {
      expect(await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue(rendered('true')) }), 'blog')).toBeNull();
      expect(await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockResolvedValue('services:\n  web:\n    image: x\n') }), 'blog')).toBeNull();
    });

    it('does not hold a stop of a stack that was never deployed hostage to its file', async () => {
      const render = vi.fn().mockResolvedValue(rendered('false'));

      expect(await run({ kind: 'stop' }, probes({ renderConfig: render }), 'blog')).toBeNull();
    });

    describe.each([
      ['a render that throws', () => vi.fn().mockRejectedValue(new Error('docker compose config timed out'))],
      ['a render that returns nothing', () => vi.fn().mockResolvedValue(null)],
      ['a render that is not YAML', () => vi.fn().mockResolvedValue('services: [unclosed')],
    ])('when the Compose configuration cannot be rendered (%s)', (_name, failing) => {
      beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      });

      it.each([
        { kind: 'up' },
        { kind: 'update' },
        { kind: 'service', service: 'web' },
        { kind: 'service', service: 'web', restart: true },
      ] as EndpointMutation[])('refuses %j, since the model it would act on is unknown', async (mutation) => {
        const refusal = await run(mutation, probes({ renderConfig: failing() }), 'blog');

        expect(refusal).toMatchObject({ reason: 'unresolved', service: null });
        expect(refusal?.message).toContain('could not render the Compose configuration of "blog"');
      });

      it.each([{ kind: 'stop' }, { kind: 'restart' }] as EndpointMutation[])('lets a %j of a stack that was never deployed through', async (mutation) => {
        expect(await run(mutation, probes({ renderConfig: failing() }), 'blog')).toBeNull();
      });

      it('names the cause in the refusal', async () => {
        const refusal = await run({ kind: 'up' }, probes({ renderConfig: vi.fn().mockRejectedValue(new Error('docker compose config timed out')) }), 'blog');

        expect(refusal?.message).toContain('docker compose config timed out');
      });
    });
  });

  describe('a stack that is running and cannot be rendered', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockListContainers.mockResolvedValue([container(WEB_ID, 'web', { project: 'blog' })]);
    });

    it.each([{ kind: 'stop' }, { kind: 'restart' }] as EndpointMutation[])('can still be changed with a %j, which the running containers decide', async (mutation) => {
      expect(await run(mutation, probes({ renderConfig: vi.fn().mockRejectedValue(new Error('render failed')) }), 'blog')).toBeNull();
    });

    it.each([
      { kind: 'up' },
      { kind: 'update' },
      { kind: 'service', service: 'web' },
    ] as EndpointMutation[])('refuses %j, whether or not the stack holds the proxy, because the pull policy and wiring cannot be read', async (mutation) => {
      const failing = vi.fn().mockRejectedValue(new Error('render failed'));

      expect(await run(mutation, probes({ renderConfig: failing }), 'blog')).toMatchObject({ reason: 'unresolved' });
    });

    it('refuses an up of the proxy that a build pull policy would rebuild, instead of reading an empty model', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      mockListContainers.mockResolvedValue([proxyContainer]);
      const timedOut = vi.fn().mockRejectedValue(new Error('docker compose config timed out'));

      const refusal = await run({ kind: 'up' }, probes({ renderConfig: timedOut }), 'sencho');

      expect(refusal).toMatchObject({ reason: 'unresolved' });
      expect(refusal?.message).toContain('timed out');
    });
  });

  it('still protects a running container that carries the label when the file no longer does, or cannot be rendered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const labeled = container(WEB_ID, 'web', { project: 'blog', labels: { 'io.sencho.infrastructure': 'true' } });
    mockListContainers.mockResolvedValue([labeled]);

    const removedFromFile = await run({ kind: 'stop' }, probes({ renderConfig: vi.fn().mockResolvedValue('services:\n  web:\n    image: x\n') }), 'blog');
    const unrenderable = await run({ kind: 'stop' }, probes({ renderConfig: vi.fn().mockResolvedValue(null) }), 'blog');
    const throwing = await run({ kind: 'stop' }, probes({ renderConfig: vi.fn().mockRejectedValue(new Error('render failed')) }), 'blog');

    expect(removedFromFile).toMatchObject({ reason: 'provider', service: 'web' });
    expect(unrenderable).toMatchObject({ reason: 'provider', service: 'web' });
    expect(throwing).toMatchObject({ reason: 'provider', service: 'web' });
  });

  it('treats a running container whose label value is not true as the connection, without locking the rest of the stack', async () => {
    mockListContainers.mockResolvedValue([
      container(WEB_ID, 'web', { project: 'blog', labels: { 'io.sencho.infrastructure': 'false' } }),
      container('d'.repeat(64), 'db', { project: 'blog' }),
    ]);

    expect(await run({ kind: 'stop' }, probes(), 'blog')).toMatchObject({ reason: 'invalid_label', service: 'web' });
    // The deploy that would fix the file is not held hostage unless it would recreate the container.
    expect(await run({ kind: 'up' }, probes(), 'blog')).toBeNull();
    expect(await run({ kind: 'up' }, probes({ configHash: vi.fn().mockResolvedValue('hash-new') }), 'blog'))
      .toMatchObject({ reason: 'invalid_label', service: 'web' });
    expect(await run({ kind: 'service', service: 'db' }, probes(), 'blog')).toBeNull();
  });
});

describe('readInfrastructureLabels', () => {
  it('reads map and list label forms', () => {
    const yaml = [
      'services:',
      '  a:',
      '    labels:',
      '      io.sencho.infrastructure: "true"',
      '  b:',
      '    labels:',
      '      - io.sencho.infrastructure=true',
      '  c:',
      '    labels:',
      '      - io.sencho.infrastructure=1',
      '  d:',
      '    labels:',
      '      other: x',
    ].join('\n');

    expect(readInfrastructureLabels(yaml)).toEqual({ marked: ['a', 'b'], invalid: [{ service: 'c', value: '1' }] });
  });

  it('throws on unparseable input so the caller can say the config could not be read', () => {
    expect(() => readInfrastructureLabels('{{{')).toThrow();
  });
});

describe('Sencho cannot identify itself', () => {
  beforeEach(() => {
    stubSelf('unresolved');
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);
    process.env.HOSTNAME = SELF_ID.slice(0, 12);
  });

  it('refuses a stack whose containers include the running container, with the reason', async () => {
    const refusal = await run({ kind: 'up' });

    expect(refusal).toMatchObject({ reason: 'unresolved' });
    expect(refusal?.message).toContain('HOSTNAME inspect failed: 403');
  });

  it('allows a stack that provably does not contain the running container', async () => {
    mockListContainers.mockResolvedValue([container(WEB_ID, 'web', { project: 'blog' })]);

    expect(await run({ kind: 'stop' }, probes(), 'blog')).toBeNull();
  });

  it('refuses a stack it cannot rule out when it has no id to compare', async () => {
    process.env.HOSTNAME = 'custom-hostname';
    mockListContainers.mockResolvedValue([container(WEB_ID, 'web', { project: 'blog' })]);

    expect(await run({ kind: 'stop' }, probes(), 'blog')).toMatchObject({ reason: 'unresolved' });
  });

  it('allows a stack with nothing running in it', async () => {
    mockListContainers.mockResolvedValue([]);

    expect(await run({ kind: 'up' })).toBeNull();
  });
});

describe('Docker errors while listing the stack', () => {
  it('refuses when Docker is unreachable: the connection can recover before the mutation that follows', async () => {
    mockListContainers.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), { code: 'ECONNREFUSED' }));

    expect(await run({ kind: 'stop' })).toMatchObject({ reason: 'unresolved' });
  });

  it.each<EndpointMutation>([
    { kind: 'up' }, { kind: 'update' }, { kind: 'stop' }, { kind: 'restart' }, { kind: 'service', service: 'socket-proxy' },
  ])('refuses %o on a known provider after one failed read, though the next read would succeed', async (mutation) => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
    mockListContainers
      .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
      .mockResolvedValue([proxyContainer, webContainer]);

    expect(await run(mutation)).toMatchObject({ reason: 'unresolved' });
    // The read recovers: a deploy that leaves the proxy unchanged goes through, anything else is refused as the provider it is.
    const recovered = await run(mutation);
    if (mutation.kind === 'up') expect(recovered).toBeNull();
    else expect(recovered).toMatchObject({ reason: 'provider' });
  });

  it('refuses on any other listing failure, since nothing can be proved', async () => {
    mockListContainers.mockRejectedValue(new Error('403 forbidden'));

    const refusal = await run({ kind: 'stop' });

    expect(refusal?.reason).toBe('unresolved');
    expect(refusal?.message).toContain('403 forbidden');
  });
});

describe('connection errors while listing the stack', () => {
  it.each([
    ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:2375'), { code: 'ECONNREFUSED' })],
    ['a missing docker.sock', Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' })],
    ['an unreachable daemon', new Error('Cannot connect to the Docker daemon at tcp://socket-proxy:2375')],
  ])('refuses for %s, since the connection can recover before the mutation', async (_name, error) => {
    mockListContainers.mockRejectedValue(error);

    expect(await run({ kind: 'stop' })).toMatchObject({ reason: 'unresolved' });
  });

  it.each([
    ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['EPIPE', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
    ['ETIMEDOUT', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    ['a hung-up socket', new Error('socket hang up')],
    ['ENOTFOUND', Object.assign(new Error('getaddrinfo ENOTFOUND socket-proxy'), { code: 'ENOTFOUND' })],
  ])('refuses on %s, which proves nothing about the stack', async (_name, error) => {
    mockListContainers.mockRejectedValue(error);

    expect(await run({ kind: 'stop' })).toMatchObject({ reason: 'unresolved' });
  });
});

describe('evaluateDockerEndpointContainer', () => {
  type Spec = { Id: string; Name: string; labels?: Record<string, string>; networks?: string[]; hostConfig?: Record<string, string> };
  const specs: Record<string, Spec> = {
    [PROXY_ID]: { Id: PROXY_ID, Name: '/socket-proxy', labels: { 'com.docker.compose.project': 'sencho', 'com.docker.compose.service': 'socket-proxy' }, networks: ['proxy-net'] },
    [SELF_ID]: { Id: SELF_ID, Name: '/sencho', labels: { 'com.docker.compose.project': 'sencho', 'com.docker.compose.service': 'sencho' }, networks: ['proxy-net'] },
    [WEB_ID]: { Id: WEB_ID, Name: '/web', labels: { 'com.docker.compose.project': 'blog', 'com.docker.compose.service': 'web' }, networks: ['blog_default'] },
    [VPN_ID]: { Id: VPN_ID, Name: '/vpn', labels: { 'com.docker.compose.project': 'tunnel', 'com.docker.compose.service': 'vpn' }, networks: ['tunnel_default'] },
  };

  /**
   * A fake engine. `inspectError` fails every inspect; `failFor` fails the
   * inspect of the references it returns an error for; `listError` fails the
   * list of labeled containers.
   */
  function dockerFor(inspectError?: unknown, opts: { failFor?: (ref: string) => unknown; listError?: unknown } = {}) {
    return {
      listContainers: async () => {
        if (opts.listError) throw opts.listError;
        return Object.values(specs).map(spec => ({ Id: spec.Id, Names: [spec.Name], Labels: spec.labels ?? {} }));
      },
      getContainer: (ref: string) => ({
        inspect: async () => {
          const failure = inspectError ?? opts.failFor?.(ref);
          if (failure) throw failure;
          const found = Object.values(specs).find(spec => spec.Id === ref || spec.Id.startsWith(ref) || spec.Name === `/${ref}`);
          if (!found) throw Object.assign(new Error('no such container'), { statusCode: 404 });
          return {
            Id: found.Id,
            Name: found.Name,
            Config: { Labels: found.labels ?? {} },
            HostConfig: found.hostConfig ?? {},
            NetworkSettings: { Networks: Object.fromEntries((found.networks ?? []).map(name => [name, { NetworkID: `id-${name}` }])) },
          };
        },
      }),
    };
  }
  const evaluate = (id: string, action: 'stop' | 'restart', docker = dockerFor()) => evaluateDockerEndpointContainer(id, action, docker);

  it('refuses to stop or restart the proxy by its container id, short id, or name', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    expect(await evaluate(PROXY_ID, 'stop')).toMatchObject({ reason: 'provider' });
    expect(await evaluate(PROXY_ID.slice(0, 12), 'restart')).toMatchObject({ reason: 'provider' });
    expect(await evaluate('socket-proxy', 'stop')).toMatchObject({ reason: 'provider' });
  });

  it('still recognises the proxy after a recreate gave it a new id (matched by Compose service)', async () => {
    mockResolveProvider.mockResolvedValue({
      state: 'resolved',
      provider: { containerId: 'f'.repeat(64), containerName: 'socket-proxy', project: 'sencho', service: 'socket-proxy', workingDir: null, socketBindSource: null },
    });

    expect(await evaluate(PROXY_ID, 'stop')).toMatchObject({ reason: 'provider' });
  });

  it('refuses a container that carries the infrastructure label', async () => {
    specs[WEB_ID].labels = { ...specs[WEB_ID].labels, 'io.sencho.infrastructure': 'true' };
    try {
      expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'provider', service: 'web' });
      specs[WEB_ID].labels = { ...specs[WEB_ID].labels, 'io.sencho.infrastructure': 'maybe' };
      expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'invalid_label' });
    } finally {
      delete specs[WEB_ID].labels?.['io.sencho.infrastructure'];
    }
  });

  it('refuses to stop Sencho but allows restarting it', async () => {
    expect(await evaluate(SELF_ID, 'stop')).toMatchObject({ reason: 'sencho' });
    expect(await evaluate(SELF_ID, 'restart')).toBeNull();
  });

  it.each(['NetworkMode', 'PidMode', 'IpcMode'])('refuses to stop the container whose %s the proxy runs in', async (mode) => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
    specs[PROXY_ID].hostConfig = { [mode]: `container:${WEB_ID}` };
    try {
      expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'provider', service: 'web' });
      expect(await evaluate(WEB_ID, 'restart')).toMatchObject({ reason: 'provider', service: 'web' });
      expect(await evaluate(SELF_ID, 'restart')).toBeNull();
    } finally {
      delete specs[PROXY_ID].hostConfig;
    }
  });

  it('refuses to stop or restart the container whose namespace Sencho runs in', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
    specs[SELF_ID].hostConfig = { NetworkMode: `container:${WEB_ID}` };
    try {
      expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'sencho', service: 'web' });
      expect(await evaluate(WEB_ID, 'restart')).toMatchObject({ reason: 'sencho', service: 'web' });
    } finally {
      delete specs[SELF_ID].hostConfig;
    }
  });

  it('matches the namespace owner by name, and finds a proxy that was recreated since it was resolved', async () => {
    mockResolveProvider.mockResolvedValue({
      state: 'resolved',
      provider: { containerId: 'f'.repeat(64), containerName: 'socket-proxy', project: 'sencho', service: 'socket-proxy', workingDir: null, socketBindSource: null },
    });
    specs[PROXY_ID].hostConfig = { NetworkMode: 'container:web' };
    try {
      expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'provider', service: 'web' });
    } finally {
      delete specs[PROXY_ID].hostConfig;
    }
  });

  it('refuses as unresolved, rather than letting it pass, when the proxy cannot be inspected to read its namespaces', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
    const base = dockerFor();
    const docker = {
      listContainers: base.listContainers,
      getContainer: (ref: string) => ref === PROXY_ID
        ? { inspect: async () => { throw new Error('inspect denied'); } }
        : base.getContainer(ref),
    };

    const refusal = await evaluate(WEB_ID, 'stop', docker);

    expect(refusal).toMatchObject({ reason: 'unresolved', service: 'web' });
    expect(refusal?.message).toContain('inspect denied');
  });

  it('leaves unrelated containers alone', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    expect(await evaluate(WEB_ID, 'stop')).toBeNull();
    expect(await evaluate(WEB_ID, 'restart')).toBeNull();
  });

  it('recognises Sencho by its runtime id when identity could not be resolved', async () => {
    stubSelf('unresolved');
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(SELF_ID);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);
    delete process.env.HOSTNAME;

    expect(await evaluate(SELF_ID, 'stop')).toMatchObject({ reason: 'sencho' });
    expect(await evaluate(WEB_ID, 'stop')).toBeNull();
  });

  it('refuses when identity is unresolved and there is no runtime id to compare, as the stack level does', async () => {
    stubSelf('unresolved');
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);
    process.env.HOSTNAME = 'custom-hostname';

    expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'unresolved' });
  });

  it('refuses a container that shares a network with Sencho while the provider is unresolved', async () => {
    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'dns' });

    expect(await evaluate(PROXY_ID, 'restart')).toMatchObject({ reason: 'unresolved' });
    expect(await evaluate(WEB_ID, 'stop')).toBeNull();
  });

  const forbidden = () => Object.assign(new Error('403 forbidden'), { statusCode: 403 });

  it('lets an ordinary container through when only its own inspect is denied and the proxy and Sencho prove it is not theirs', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
    const onlyWebDenied = dockerFor(undefined, { failFor: ref => (ref === WEB_ID ? forbidden() : undefined) });

    expect(await evaluate(WEB_ID, 'stop', onlyWebDenied)).toBeNull();
    expect(await evaluate(WEB_ID, 'restart', onlyWebDenied)).toBeNull();
  });

  it('still refuses what it can prove when every inspect is denied, and refuses an ordinary container it cannot clear', async () => {
    const denied = dockerFor(forbidden());
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    expect(await evaluate(PROXY_ID, 'stop', denied)).toMatchObject({ reason: 'provider' });
    expect(await evaluate(SELF_ID, 'stop', denied)).toMatchObject({ reason: 'sencho' });
    expect(await evaluate(SELF_ID, 'restart', denied)).toBeNull();
    // The proxy and Sencho cannot be read either, so whether web owns a namespace they run in is unknown.
    expect(await evaluate(WEB_ID, 'stop', denied)).toMatchObject({ reason: 'unresolved', service: WEB_ID });

    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'dns' });
    expect(await evaluate(WEB_ID, 'stop', denied)).toMatchObject({ reason: 'unresolved' });
  });

  it('refuses the proxy by short id or name when the proxy denies inspect, without catching a similar name', async () => {
    const refs = [PROXY_ID.slice(0, 12), 'socket-proxy', '/socket-proxy', 'socket-proxy-2', 'c'.repeat(12)];
    const denied = dockerFor(undefined, { failFor: ref => (refs.includes(ref) ? forbidden() : undefined) });
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    expect(await evaluate(PROXY_ID.slice(0, 12), 'stop', denied)).toMatchObject({ reason: 'provider' });
    expect(await evaluate(PROXY_ID.slice(0, 12), 'restart', denied)).toMatchObject({ reason: 'provider' });
    expect(await evaluate('socket-proxy', 'stop', denied)).toMatchObject({ reason: 'provider' });
    expect(await evaluate('/socket-proxy', 'restart', denied)).toMatchObject({ reason: 'provider' });
    expect(await evaluate('socket-proxy-2', 'stop', denied)).toBeNull();
    expect(await evaluate('c'.repeat(12), 'stop', denied)).toBeNull();
  });

  it('refuses a container whose own label is invalid, as a protected container', async () => {
    specs[WEB_ID].labels = { ...specs[WEB_ID].labels, 'io.sencho.infrastructure': 'maybe' };
    try {
      expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'invalid_label', service: 'web' });
    } finally {
      delete specs[WEB_ID].labels?.['io.sencho.infrastructure'];
    }
  });

  it('treats every container as a candidate when the provider is unresolved and Sencho cannot list its own networks', async () => {
    stubSelf('unresolved');
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(SELF_ID);
    vi.spyOn(SelfIdentityService, 'readContainerIdFromMountinfo').mockResolvedValue(null);
    delete process.env.HOSTNAME;
    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'dns' });

    expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'unresolved', service: 'web' });
  });

  it('recognises Sencho by a short id as well as the full id', async () => {
    expect(await evaluate(SELF_ID.slice(0, 12), 'stop')).toMatchObject({ reason: 'sencho' });
  });

  it('lets the operation fail on its own for a missing container, and refuses on other inspect errors', async () => {
    expect(await evaluate('no-such', 'stop')).toBeNull();
    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'dns' });
    expect(await evaluate(WEB_ID, 'stop', dockerFor(Object.assign(new Error('403 forbidden'), { statusCode: 403 })))).toMatchObject({ reason: 'unresolved' });
  });

  describe.each([
    ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:2375'), { code: 'ECONNREFUSED' })],
    ['a missing docker.sock', Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' })],
    ['an unreachable daemon', new Error('Cannot connect to the Docker daemon at tcp://socket-proxy:2375')],
    ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['ETIMEDOUT', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    ['EPIPE', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
    ['EAI_AGAIN', Object.assign(new Error('getaddrinfo EAI_AGAIN socket-proxy'), { code: 'EAI_AGAIN' })],
    ['a missing non-docker socket', Object.assign(new Error('connect ENOENT /run/podman/podman.sock'), { code: 'ENOENT' })],
  ])('when Docker is unreachable (%s)', (_name, error) => {
    it.each(['stop', 'restart'] as const)('refuses a %s of an ordinary container, since the connection can recover before the mutation', async (action) => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await evaluate(WEB_ID, action, dockerFor(error))).toMatchObject({ reason: 'unresolved' });
    });

    it('keeps refusing what it already knows: the provider, and Sencho on a stop', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await evaluate(PROXY_ID, 'stop', dockerFor(error))).toMatchObject({ reason: 'provider' });
      expect(await evaluate('socket-proxy', 'restart', dockerFor(error))).toMatchObject({ reason: 'provider' });
      expect(await evaluate(SELF_ID, 'stop', dockerFor(error))).toMatchObject({ reason: 'sencho' });
    });
  });

  it('refuses a batch whole when one container cannot be checked, before any of them is touched', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
    const down = dockerFor(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const results: Array<unknown> = [];
    for (const id of [WEB_ID, PROXY_ID]) results.push(await evaluate(id, 'stop', down));

    expect(results.every(refusal => refusal !== null)).toBe(true);
  });

  describe('an inspect that fails with an HTTP status', () => {
    const httpError = (statusCode: number) => Object.assign(new Error(`engine answered ${statusCode}`), { statusCode });
    // The proxy runs in the namespace of web; web is the container being stopped.
    const ownedByWeb = () => { specs[PROXY_ID].hostConfig = { NetworkMode: `container:${WEB_ID}` }; };
    const onlyFor = (refs: string[], statusCode: number) =>
      dockerFor(undefined, { failFor: ref => (refs.includes(ref) ? httpError(statusCode) : undefined) });

    afterEach(() => {
      delete specs[PROXY_ID].hostConfig;
      delete specs[SELF_ID].hostConfig;
      delete specs[VPN_ID].hostConfig;
      delete specs[WEB_ID].labels?.['io.sencho.infrastructure'];
      delete specs[PROXY_ID].labels?.['io.sencho.infrastructure'];
    });

    it.each([500, 502, 503, 409])('refuses the owner of the proxy\'s namespace on HTTP %i, since the engine did not say it is ordinary', async (status) => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      ownedByWeb();
      const failing = onlyFor([WEB_ID], status);

      for (const action of ['stop', 'restart'] as const) {
        expect(await evaluate(WEB_ID, action, failing)).toMatchObject({ reason: 'unresolved' });
      }
    });

    it.each([500, 502, 503, 409])('refuses an ordinary container on HTTP %i too, because only a deny is judged further', async (status) => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await evaluate(WEB_ID, 'stop', onlyFor([WEB_ID], status))).toMatchObject({ reason: 'unresolved' });
    });

    it.each([401, 403])('lets an ordinary container through on HTTP %i when nothing shows it is the proxy or owns its namespace', async (status) => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await evaluate(WEB_ID, 'stop', onlyFor([WEB_ID], status))).toBeNull();
    });

    it.each([401, 403])('refuses the owner of the proxy\'s namespace on HTTP %i, found from the proxy even though the owner cannot be inspected by this id', async (status) => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      ownedByWeb();
      // The proxy's mode names the owner by full id, so the owner inspects fine under that reference; the caller's short id is denied.
      const short = WEB_ID.slice(0, 12);

      for (const action of ['stop', 'restart'] as const) {
        expect(await evaluate(short, action, onlyFor([short], status))).toMatchObject({ reason: 'provider' });
      }
    });

    it('refuses the owner when the denied inspect also hides the owner from the proxy walk', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      ownedByWeb();

      expect(await evaluate(WEB_ID, 'stop', onlyFor([WEB_ID], 403))).toMatchObject({ reason: 'unresolved' });
    });

    it('refuses the owner of the namespace Sencho runs in on HTTP 500 and 403', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      specs[SELF_ID].hostConfig = { NetworkMode: `container:${WEB_ID}` };

      expect(await evaluate(WEB_ID, 'stop', onlyFor([WEB_ID], 500))).toMatchObject({ reason: 'unresolved' });
      expect(await evaluate(WEB_ID.slice(0, 12), 'stop', onlyFor([WEB_ID.slice(0, 12)], 403))).toMatchObject({ reason: 'sencho' });
    });

    it('refuses a label-only proxy on an unmatched TCP endpoint when its inspect fails (HTTP 500) or is denied (HTTP 403)', async () => {
      mockResolveProvider.mockResolvedValue({ state: 'none', unmatched: true, reason: 'No container owns the address.' });
      specs[WEB_ID].labels = { ...specs[WEB_ID].labels, 'io.sencho.infrastructure': 'true' };

      expect(await evaluate(WEB_ID, 'stop', onlyFor([WEB_ID], 500))).toMatchObject({ reason: 'unresolved' });
      expect(await evaluate(WEB_ID, 'stop', onlyFor([WEB_ID], 403))).toMatchObject({ reason: 'provider' });
      expect(await evaluate('web', 'restart', onlyFor(['web'], 403))).toMatchObject({ reason: 'provider' });
    });

    it('refuses a mislabeled container whose inspect is denied', async () => {
      mockResolveProvider.mockResolvedValue({ state: 'none', unmatched: true, reason: 'No container owns the address.' });
      specs[WEB_ID].labels = { ...specs[WEB_ID].labels, 'io.sencho.infrastructure': 'maybe' };

      expect(await evaluate(WEB_ID, 'stop', onlyFor([WEB_ID], 403))).toMatchObject({ reason: 'invalid_label' });
    });

    it('refuses a proxy that was recreated since it was resolved, whether its inspect fails (HTTP 500) or is denied (HTTP 403)', async () => {
      // The cache still names the old id; the container being stopped is the new one.
      mockResolveProvider.mockResolvedValue({
        state: 'resolved',
        provider: { containerId: 'f'.repeat(64), containerName: 'socket-proxy', project: 'sencho', service: 'socket-proxy', workingDir: null, socketBindSource: null },
      });

      expect(await evaluate(PROXY_ID, 'stop', onlyFor([PROXY_ID], 500))).toMatchObject({ reason: 'unresolved' });
      expect(await evaluate(PROXY_ID, 'stop', onlyFor([PROXY_ID], 403))).toMatchObject({ reason: 'provider' });
      expect(await evaluate(PROXY_ID, 'restart', onlyFor([PROXY_ID], 403))).toMatchObject({ reason: 'provider' });
    });

    it('still refuses the cached provider id on HTTP 500', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await evaluate(PROXY_ID, 'stop', onlyFor([PROXY_ID], 500))).toMatchObject({ reason: 'provider' });
    });

    it.each([500, 503, 409, 403])('refuses a container that inspects cleanly when the proxy inspect fails with HTTP %i', async (status) => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await evaluate(WEB_ID, 'stop', onlyFor([PROXY_ID], status))).toMatchObject({ reason: 'unresolved', service: 'web' });
    });

    it('lets a missing container (HTTP 404) fail on its own', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await evaluate(WEB_ID, 'stop', onlyFor([WEB_ID], 404))).toBeNull();
    });

    it('lets Sencho be restarted when its inspect fails, but not stopped', async () => {
      const failing = onlyFor([SELF_ID], 500);

      expect(await evaluate(SELF_ID, 'restart', failing)).toBeNull();
      expect(await evaluate(SELF_ID, 'stop', failing)).toMatchObject({ reason: 'sencho' });
    });

    it('refuses when the labeled containers cannot be listed, even for a container that inspects cleanly', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      const noList = dockerFor(undefined, { listError: httpError(500) });

      expect(await evaluate(WEB_ID, 'stop', noList)).toMatchObject({ reason: 'unresolved', service: 'web' });
      expect(await evaluate(WEB_ID, 'stop', dockerFor(forbidden(), { listError: httpError(403) }))).toMatchObject({ reason: 'unresolved' });
    });
  });

  describe('the owner of a namespace a labeled proxy runs in', () => {
    // Detection found no provider (a published port), the proxy carries the label, and its network is the vpn in another project.
    beforeEach(() => {
      mockResolveProvider.mockResolvedValue({ state: 'none', unmatched: true, reason: 'No container owns the address.' });
      specs[PROXY_ID].labels = { ...specs[PROXY_ID].labels, 'io.sencho.infrastructure': 'true' };
      specs[PROXY_ID].hostConfig = { NetworkMode: `container:${VPN_ID}` };
    });
    afterEach(() => {
      delete specs[PROXY_ID].labels?.['io.sencho.infrastructure'];
      delete specs[PROXY_ID].hostConfig;
      delete specs[VPN_ID].hostConfig;
    });

    it.each(['stop', 'restart'] as const)('refuses a %s of the owner from the container route, by id, short id, or name', async (action) => {
      for (const ref of [VPN_ID, VPN_ID.slice(0, 12), 'vpn']) {
        expect(await evaluate(ref, action)).toMatchObject({ reason: 'provider', service: 'vpn' });
      }
    });

    it('refuses the owner when its own inspect fails or is denied', async () => {
      const failing = (status: number) => dockerFor(undefined, { failFor: ref => (ref === VPN_ID ? Object.assign(new Error('x'), { statusCode: status }) : undefined) });

      expect(await evaluate(VPN_ID, 'stop', failing(500))).toMatchObject({ reason: 'unresolved' });
      expect(await evaluate(VPN_ID, 'stop', failing(403))).toMatchObject({ reason: 'unresolved' });
    });

    it('follows the chain: the owner of the owner is protected as well', async () => {
      specs[VPN_ID].hostConfig = { PidMode: `container:${WEB_ID}` };

      expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'provider', service: 'web' });
    });

    it('leaves a container that owns nothing the labeled proxy runs in alone', async () => {
      expect(await evaluate(WEB_ID, 'stop')).toBeNull();
    });

    it('refuses when a labeled container cannot be inspected to read its namespaces', async () => {
      const failing = dockerFor(undefined, { failFor: ref => (ref === PROXY_ID ? Object.assign(new Error('boom'), { statusCode: 500 }) : undefined) });

      expect(await evaluate(WEB_ID, 'stop', failing)).toMatchObject({ reason: 'unresolved' });
    });
  });

  describe('with allowProvider (Auto-Heal)', () => {
    const allowing = (id: string, action: 'stop' | 'restart', docker = dockerFor()) =>
      evaluateDockerEndpointContainer(id, action, docker, { allowProvider: true });

    afterEach(() => {
      delete specs[PROXY_ID].hostConfig;
      delete specs[SELF_ID].hostConfig;
      delete specs[WEB_ID].labels?.['io.sencho.infrastructure'];
    });

    it('restarts the resolved provider, by id, short id, name, a new id after a recreate, and when its inspect is denied', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await allowing(PROXY_ID, 'restart')).toBeNull();
      expect(await allowing(PROXY_ID.slice(0, 12), 'restart')).toBeNull();
      expect(await allowing('socket-proxy', 'restart')).toBeNull();
      expect(await allowing(PROXY_ID, 'restart', dockerFor(Object.assign(new Error('403'), { statusCode: 403 })))).toBeNull();
      mockResolveProvider.mockResolvedValue({
        state: 'resolved',
        provider: { containerId: 'f'.repeat(64), containerName: 'socket-proxy', project: 'sencho', service: 'socket-proxy', workingDir: null, socketBindSource: null },
      });
      expect(await allowing(PROXY_ID, 'restart')).toBeNull();
    });

    it('still refuses the owner of a namespace the provider or Sencho runs in', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      specs[PROXY_ID].hostConfig = { NetworkMode: `container:${WEB_ID}` };
      expect(await allowing(WEB_ID, 'restart')).toMatchObject({ reason: 'provider', service: 'web' });

      delete specs[PROXY_ID].hostConfig;
      specs[SELF_ID].hostConfig = { PidMode: `container:${WEB_ID}` };
      expect(await allowing(WEB_ID, 'restart')).toMatchObject({ reason: 'sencho', service: 'web' });
    });

    it('still refuses a labeled container that is not the provider, and a mislabeled one', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));
      specs[WEB_ID].labels = { ...specs[WEB_ID].labels, 'io.sencho.infrastructure': 'true' };
      expect(await allowing(WEB_ID, 'restart')).toMatchObject({ reason: 'provider', service: 'web' });

      specs[WEB_ID].labels = { ...specs[WEB_ID].labels, 'io.sencho.infrastructure': 'maybe' };
      expect(await allowing(WEB_ID, 'restart')).toMatchObject({ reason: 'invalid_label' });
    });

    it('keeps healing ordinary siblings', async () => {
      mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

      expect(await allowing(WEB_ID, 'restart')).toBeNull();
    });
  });
});

describe('the owner of a namespace a labeled container runs in, in another project', () => {
  // Detection found no provider (a published port); the proxy carries the label and runs in the network of a vpn in project "tunnel".
  const labeledProxy = container(PROXY_ID, 'socket-proxy', { labels: { 'io.sencho.infrastructure': 'true' } });
  const vpn = container(VPN_ID, 'vpn', { project: 'tunnel' });
  const sibling = container(WEB_ID, 'web', { project: 'tunnel' });

  beforeEach(() => {
    mockResolveProvider.mockResolvedValue({ state: 'none', unmatched: true, reason: 'No container owns the address.' });
    mockListContainers.mockResolvedValue([senchoContainer, labeledProxy, vpn, sibling]);
    runtimeModes.set(PROXY_ID, { name: 'socket-proxy', modes: { NetworkMode: `container:${VPN_ID}` } });
  });

  it.each([{ kind: 'stop' }, { kind: 'restart' }, { kind: 'update' }, { kind: 'service', service: 'vpn' }] as EndpointMutation[])(
    'refuses %j of the owner\'s own stack',
    async (mutation) => {
      expect(await run(mutation, probes(), 'tunnel')).toMatchObject({ reason: 'provider', service: 'vpn' });
    },
  );

  it('names the owner and the labeled container it carries the connection for', async () => {
    const refusal = await run({ kind: 'stop' }, probes(), 'tunnel');

    expect(refusal?.message).toContain('owns a network, pid, or ipc namespace that service "socket-proxy" runs in');
  });

  it('refuses an up only when it would recreate the owner', async () => {
    expect(await run({ kind: 'up' }, probes(), 'tunnel')).toBeNull();
    expect(await run({ kind: 'up' }, probes({ configHash: vi.fn().mockResolvedValue('hash-new') }), 'tunnel'))
      .toMatchObject({ reason: 'provider', service: 'vpn' });
  });

  it('leaves a service of that stack that owns nothing alone', async () => {
    expect(await run({ kind: 'service', service: 'web' }, probes(), 'tunnel')).toBeNull();
  });

  it('refuses when the labeled container cannot be inspected to read its namespaces', async () => {
    mockGetContainer.mockImplementation((ref: string) => ({
      inspect: async () => {
        if (ref === PROXY_ID) throw Object.assign(new Error('engine failed'), { statusCode: 500 });
        return { Id: ref, HostConfig: {} };
      },
    }));

    expect(await run({ kind: 'stop' }, probes(), 'tunnel')).toMatchObject({ reason: 'unresolved' });
  });

  it('leaves the stack alone when the proxy is not labeled and nothing else marks it', async () => {
    mockListContainers.mockResolvedValue([senchoContainer, proxyContainer, vpn, sibling]);

    expect(await run({ kind: 'stop' }, probes(), 'tunnel')).toBeNull();
  });
});

describe('dockerEndpointRefusalOf', () => {
  const remote = (over: Record<string, unknown> = {}) => Object.assign(new Error('Failed to redeploy stack on remote node (409): {...}'), {
    code: 'docker_endpoint_protected',
    httpStatus: 409,
    remoteError: 'Service "socket-proxy" carries the Docker connection.',
    remoteReason: 'provider',
    ...over,
  });

  it('recognises a refusal raised in this process', () => {
    const error = new DockerEndpointProtectedError({ reason: 'sencho', service: 'sencho', message: 'would stop Sencho' });

    expect(dockerEndpointRefusalOf(error)).toEqual({ message: 'would stop Sencho', reason: 'sencho' });
  });

  it('recognises a remote node\'s 409 and prefers the remote\'s own message over the raw body', () => {
    expect(dockerEndpointRefusalOf(remote())).toEqual({
      message: 'Service "socket-proxy" carries the Docker connection.',
      reason: 'provider',
    });
  });

  it('falls back to the error text when the remote body carried no message or reason', () => {
    expect(dockerEndpointRefusalOf(remote({ remoteError: undefined, remoteReason: undefined }))).toEqual({
      message: 'Failed to redeploy stack on remote node (409): {...}',
      reason: null,
    });
  });

  it.each([
    ['a different code', remote({ code: 'stack_op_in_progress' })],
    ['a status other than 409', remote({ httpStatus: 500 })],
    ['no status (a plain coded error)', remote({ httpStatus: undefined })],
    ['a non-error', { code: 'docker_endpoint_protected', httpStatus: 409 }],
    ['null', null],
  ])('does not treat %s as a refusal', (_name, value) => {
    expect(dockerEndpointRefusalOf(value)).toBeNull();
  });
});

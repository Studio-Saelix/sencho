/**
 * The Docker endpoint guard: refuses a lifecycle operation that would stop or
 * recreate the container carrying this node's Docker API (Sencho itself, or the
 * socket proxy it reaches Docker through), and only that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockListContainers, mockResolveProvider, mockGetNode } = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockResolveProvider: vi.fn(),
  mockGetNode: vi.fn(),
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({ getDocker: () => ({ listContainers: mockListContainers }) }),
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
import {
  evaluateDockerEndpointContainer,
  evaluateDockerEndpointGuard,
  readInfrastructureLabels,
  type EndpointGuardProbes,
  type EndpointMutation,
} from '../helpers/dockerEndpointGuard';

const SELF_ID = 'a'.repeat(64);
const PROXY_ID = 'b'.repeat(64);
const WEB_ID = 'c'.repeat(64);

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
    renderConfig: vi.fn().mockResolvedValue(null),
    configHash: vi.fn().mockResolvedValue('hash-current'),
    localImage: vi.fn().mockResolvedValue({ state: 'unknown' }),
    ...over,
  };
}

function run(mutation: EndpointMutation, p: EndpointGuardProbes = probes(), stackName = 'sencho') {
  return evaluateDockerEndpointGuard({ nodeId: 1, stackName, mutation, probes: p });
}

const originalHostname = process.env.HOSTNAME;

beforeEach(() => {
  vi.clearAllMocks();
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

  it('points to Reapply when the proxy shares Sencho\'s own project, and to the host otherwise', async () => {
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

  it('does not let a failed render turn into a refusal on its own', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockListContainers.mockResolvedValue([container(WEB_ID, 'web', { project: 'blog' })]);

    const refusal = await run({ kind: 'stop' }, probes({ renderConfig: vi.fn().mockRejectedValue(new Error('render failed')) }), 'blog');

    expect(refusal).toBeNull();
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

  it('fails closed on a running container whose label value is not true', async () => {
    mockListContainers.mockResolvedValue([container(WEB_ID, 'web', { project: 'blog', labels: { 'io.sencho.infrastructure': 'false' } })]);

    expect(await run({ kind: 'stop' }, probes(), 'blog')).toMatchObject({ reason: 'invalid_label', service: 'web' });
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
  it('lets the operation fail on its own when Docker is unreachable', async () => {
    mockListContainers.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), { code: 'ECONNREFUSED' }));

    expect(await run({ kind: 'stop' })).toBeNull();
  });

  it('refuses on any other listing failure, since nothing can be proved', async () => {
    mockListContainers.mockRejectedValue(new Error('403 forbidden'));

    const refusal = await run({ kind: 'stop' });

    expect(refusal?.reason).toBe('unresolved');
    expect(refusal?.message).toContain('403 forbidden');
  });
});

describe('evaluateDockerEndpointContainer', () => {
  type Spec = { Id: string; Name: string; labels?: Record<string, string>; networks?: string[] };
  const specs: Record<string, Spec> = {
    [PROXY_ID]: { Id: PROXY_ID, Name: '/socket-proxy', labels: { 'com.docker.compose.project': 'sencho', 'com.docker.compose.service': 'socket-proxy' }, networks: ['proxy-net'] },
    [SELF_ID]: { Id: SELF_ID, Name: '/sencho', labels: { 'com.docker.compose.project': 'sencho', 'com.docker.compose.service': 'sencho' }, networks: ['proxy-net'] },
    [WEB_ID]: { Id: WEB_ID, Name: '/web', labels: { 'com.docker.compose.project': 'blog', 'com.docker.compose.service': 'web' }, networks: ['blog_default'] },
  };

  function dockerFor(inspectError?: unknown) {
    return {
      getContainer: (ref: string) => ({
        inspect: async () => {
          if (inspectError) throw inspectError;
          const found = Object.values(specs).find(spec => spec.Id === ref || spec.Id.startsWith(ref) || spec.Name === `/${ref}`);
          if (!found) throw Object.assign(new Error('no such container'), { statusCode: 404 });
          return {
            Id: found.Id,
            Name: found.Name,
            Config: { Labels: found.labels ?? {} },
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

  it('leaves unrelated containers alone', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    expect(await evaluate(WEB_ID, 'stop')).toBeNull();
    expect(await evaluate(WEB_ID, 'restart')).toBeNull();
  });

  it('recognises Sencho by its runtime id when identity could not be resolved', async () => {
    stubSelf('unresolved');
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(SELF_ID);
    delete process.env.HOSTNAME;

    expect(await evaluate(SELF_ID, 'stop')).toMatchObject({ reason: 'sencho' });
    expect(await evaluate(WEB_ID, 'stop')).toBeNull();
  });

  it('refuses when identity is unresolved and there is no runtime id to compare, as the stack level does', async () => {
    stubSelf('unresolved');
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(null);
    process.env.HOSTNAME = 'custom-hostname';

    expect(await evaluate(WEB_ID, 'stop')).toMatchObject({ reason: 'unresolved' });
  });

  it('refuses a container that shares a network with Sencho while the provider is unresolved', async () => {
    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'dns' });

    expect(await evaluate(PROXY_ID, 'restart')).toMatchObject({ reason: 'unresolved' });
    expect(await evaluate(WEB_ID, 'stop')).toBeNull();
  });

  it('lets the operation fail on its own for a missing container or an unreachable Docker, and refuses on other inspect errors', async () => {
    expect(await evaluate('no-such', 'stop')).toBeNull();
    expect(await evaluate(WEB_ID, 'stop', dockerFor(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))).toBeNull();
    expect(await evaluate(WEB_ID, 'stop', dockerFor(new Error('403 forbidden')))).toMatchObject({ reason: 'unresolved' });
  });
});

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

function container(id: string, service: string, over: { project?: string; hash?: string } = {}) {
  const project = over.project ?? 'sencho';
  return {
    Id: id,
    Names: [`/${service}`],
    Labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.service': service,
      'com.docker.compose.project.working_dir': `/srv/compose/${project}`,
      'com.docker.compose.config-hash': over.hash ?? 'hash-current',
    },
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
  vi.spyOn(self, 'getComposeLocation').mockReturnValue({ service: 'sencho', workingDir: '/srv/compose/sencho' });
}

function probes(over: Partial<EndpointGuardProbes> = {}): EndpointGuardProbes {
  return {
    renderConfig: vi.fn().mockResolvedValue(null),
    configHash: vi.fn().mockResolvedValue('hash-current'),
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

    expect(refusal?.reason).toBe('provider');
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

  it('does not refuse because the provider could not be resolved', async () => {
    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'dns' });
    mockListContainers.mockResolvedValue([proxyContainer, webContainer]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await run({ kind: 'stop' })).toBeNull();
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

  it('treats unparseable input as no labels', () => {
    expect(readInfrastructureLabels('{{{')).toEqual({ marked: [], invalid: [] });
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
  it('refuses to stop or restart the proxy by its container id, short or full', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    expect(await evaluateDockerEndpointContainer(PROXY_ID, 'stop')).toMatchObject({ reason: 'provider' });
    expect(await evaluateDockerEndpointContainer(PROXY_ID.slice(0, 12), 'restart')).toMatchObject({ reason: 'provider' });
  });

  it('refuses to stop Sencho but allows restarting it', async () => {
    expect(await evaluateDockerEndpointContainer(SELF_ID, 'stop')).toMatchObject({ reason: 'sencho' });
    expect(await evaluateDockerEndpointContainer(SELF_ID, 'restart')).toBeNull();
  });

  it('leaves unrelated containers alone', async () => {
    mockResolveProvider.mockResolvedValue(providerFor('socket-proxy'));

    expect(await evaluateDockerEndpointContainer(WEB_ID, 'stop')).toBeNull();
    expect(await evaluateDockerEndpointContainer(WEB_ID, 'restart')).toBeNull();
  });

  it('recognises Sencho by its runtime id when identity could not be resolved', async () => {
    stubSelf('unresolved');
    vi.spyOn(SelfIdentityService, 'readContainerIdFromCgroup').mockResolvedValue(SELF_ID);
    delete process.env.HOSTNAME;

    expect(await evaluateDockerEndpointContainer(SELF_ID, 'stop')).toMatchObject({ reason: 'sencho' });
    expect(await evaluateDockerEndpointContainer(WEB_ID, 'stop')).toBeNull();
  });
});

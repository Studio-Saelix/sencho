/**
 * The container-level Docker endpoint guard end to end through its callers: the
 * real guard and the real DockerController against a fake engine, so a stop,
 * restart, or removal that must be refused is shown not to reach the engine.
 * Every caller that stops or restarts a container reaches the engine through
 * these methods (the container route, the scheduler, orphan removal, the label
 * and stack batches), and the ones that skip the second check run
 * `assertNoDockerEndpointContainers` first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockResolveProvider, engine } = vi.hoisted(() => ({
  mockResolveProvider: vi.fn(),
  engine: {
    listContainers: vi.fn(),
    getContainer: vi.fn(),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => engine,
      getDefaultNodeId: () => 1,
      getComposeDir: () => '/srv/compose',
      getNode: () => ({ id: 1, type: 'local' }),
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
    }),
  },
}));

vi.mock('../services/DockerEndpointProvider', () => ({
  resolveDockerEndpointProvider: mockResolveProvider,
}));

import DockerController from '../services/DockerController';
import SelfIdentityService from '../services/SelfIdentityService';
import { containersRouter } from '../routes/containers';

const SELF_ID = 'a'.repeat(64);
const PROXY_ID = 'b'.repeat(64);
const VPN_ID = 'e'.repeat(64);
const WEB_ID = 'c'.repeat(64);

type Spec = { Name: string; labels?: Record<string, string>; hostConfig?: Record<string, string>; inspectStatus?: number };
const specs = new Map<string, Spec>();
const ops: string[] = [];

function httpError(statusCode: number) {
  return Object.assign(new Error(`engine answered ${statusCode}`), { statusCode });
}

function stubSelf() {
  const self = SelfIdentityService.getInstance();
  vi.spyOn(self, 'ensureResolved').mockResolvedValue('resolved');
  vi.spyOn(self, 'isOwnContainer').mockImplementation(id => id === SELF_ID);
  vi.spyOn(self, 'getIdentity').mockReturnValue({
    containerId: SELF_ID, containerName: 'sencho', composeProjectName: 'sencho', imageId: null, networkNames: [], volumeNames: [],
  });
  vi.spyOn(self, 'isOwnNetwork').mockReturnValue(false);
  vi.spyOn(self, 'getComposeLocation').mockReturnValue({ service: 'sencho', workingDir: '/srv/compose/sencho' });
}

function resolveRef(ref: string): [string, Spec] | undefined {
  return [...specs].find(([id, spec]) => id === ref || id.startsWith(ref) || spec.Name === `/${ref.replace(/^\//, '')}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  specs.clear();
  ops.length = 0;
  specs.set(SELF_ID, { Name: '/sencho' });
  specs.set(PROXY_ID, { Name: '/socket-proxy' });
  specs.set(VPN_ID, { Name: '/vpn' });
  specs.set(WEB_ID, { Name: '/web' });
  // Honors the label filter (`key` or `key=value`) like the engine, so a wrong filter drops containers here too.
  engine.listContainers.mockImplementation(async (options: { filters?: { label?: string[] } } = {}) => [...specs]
    .filter(([, spec]) => (options.filters?.label ?? []).every(wanted => {
      const [key, value] = wanted.split('=');
      const actual = spec.labels?.[key];
      return actual !== undefined && (value === undefined || actual === value);
    }))
    .map(([Id, spec]) => ({ Id, Names: [spec.Name], Labels: spec.labels ?? {} })));
  engine.getContainer.mockImplementation((ref: string) => ({
    inspect: async () => {
      const found = resolveRef(ref);
      if (!found) throw httpError(404);
      if (found[1].inspectStatus) throw httpError(found[1].inspectStatus);
      return { Id: found[0], Name: found[1].Name, Config: { Labels: found[1].labels ?? {} }, HostConfig: found[1].hostConfig ?? {}, NetworkSettings: { Networks: {} } };
    },
    stop: async () => { ops.push(`stop ${ref}`); },
    restart: async () => { ops.push(`restart ${ref}`); },
    remove: async () => { ops.push(`remove ${ref}`); },
  }));
  mockResolveProvider.mockResolvedValue({
    state: 'resolved',
    provider: { containerId: PROXY_ID, containerName: 'socket-proxy', project: 'sencho', service: 'socket-proxy', workingDir: null, socketBindSource: null },
  });
  stubSelf();
  // The proxy runs in the network of the vpn.
  specs.get(PROXY_ID)!.hostConfig = { NetworkMode: `container:${VPN_ID}` };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const controller = () => DockerController.getInstance(1);

describe.each([500, 502, 503, 409])('the owner of the proxy\'s network when the engine answers HTTP %i to its inspect', (status) => {
  beforeEach(() => {
    specs.get(VPN_ID)!.inspectStatus = status;
  });

  it.each(['stopContainer', 'restartContainer'] as const)('%s refuses before touching the engine', async (method) => {
    await expect(controller()[method](VPN_ID)).rejects.toMatchObject({ code: 'docker_endpoint_protected' });

    expect(ops).toEqual([]);
  });

  it('removeContainers refuses the owner, and an ordinary orphan too while the proxy\'s namespace owners cannot be read', async () => {
    const results = await controller().removeContainers([VPN_ID, WEB_ID]);

    expect(results).toMatchObject([{ id: VPN_ID, success: false, refused: true }, { id: WEB_ID, success: false, refused: true }]);
    expect(ops).toEqual([]);
  });

  it('a batch that holds the owner is refused whole, so a caller that then skips the second check never mutates', async () => {
    await expect(controller().assertNoDockerEndpointContainers([WEB_ID, VPN_ID], 'stop')).rejects.toMatchObject({ code: 'docker_endpoint_protected' });

    expect(ops).toEqual([]);
  });

  it('the container route answers 409 and does not stop or restart it', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.nodeId = 1;
      req.user = { username: 'admin', role: 'admin', userId: 1 } as typeof req.user;
      next();
    });
    app.use('/api/containers', containersRouter);

    for (const action of ['stop', 'restart']) {
      const res = await request(app).post(`/api/containers/${VPN_ID}/${action}`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'docker_endpoint_protected' });
    }
    expect(ops).toEqual([]);
  });
});

describe('a label-only proxy (detection found no provider)', () => {
  beforeEach(() => {
    mockResolveProvider.mockResolvedValue({ state: 'none', unmatched: true, reason: 'No container owns the address.' });
    specs.get(PROXY_ID)!.labels = { 'io.sencho.infrastructure': 'true' };
  });

  it.each([500, 403])('refuses to stop the proxy when its inspect answers HTTP %i', async (status) => {
    specs.get(PROXY_ID)!.inspectStatus = status;

    await expect(controller().stopContainer(PROXY_ID)).rejects.toMatchObject({ code: 'docker_endpoint_protected' });
    expect(ops).toEqual([]);
  });

  it('refuses to stop the owner of its network, from another project, when the owner inspects cleanly', async () => {
    await expect(controller().stopContainer(VPN_ID)).rejects.toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider' });
    await expect(controller().assertNoDockerEndpointContainers([VPN_ID], 'restart')).rejects.toMatchObject({ code: 'docker_endpoint_protected' });
    expect(ops).toEqual([]);
  });

  it('stops an unrelated container', async () => {
    await controller().stopContainer(WEB_ID);

    expect(ops).toEqual([`stop ${WEB_ID}`]);
  });
});

describe('Auto-Heal (endpointGuard: allow-provider-restart)', () => {
  it('restarts the proxy', async () => {
    await controller().restartContainer(PROXY_ID, { endpointGuard: 'allow-provider-restart' });

    expect(ops).toEqual([`restart ${PROXY_ID}`]);
  });

  it('does not restart the owner of the proxy\'s network, and still restarts an ordinary sibling', async () => {
    await expect(controller().restartContainer(VPN_ID, { endpointGuard: 'allow-provider-restart' })).rejects.toMatchObject({ code: 'docker_endpoint_protected' });
    await controller().restartContainer(WEB_ID, { endpointGuard: 'allow-provider-restart' });

    expect(ops).toEqual([`restart ${WEB_ID}`]);
  });
});

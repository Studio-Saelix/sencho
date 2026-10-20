/**
 * Runtime facts for the health gate.
 *
 * A remote node's containers are read from the node that hosts them, over the
 * proxy, and a node that cannot be asked is told apart from one that could not
 * answer right now. A local node keeps the in-process Docker read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...args: unknown[]) => mockAxiosGet(...args) } }));

const mockProbe = vi.fn();
vi.mock('../helpers/remoteCapabilities', () => ({
  probeRemoteCapability: (...args: unknown[]) => mockProbe(...args),
}));

const mockGetNode = vi.fn();
vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({ getNode: (...args: unknown[]) => mockGetNode(...args) }),
  },
}));

const mockListContainers = vi.fn();
const mockInspect = vi.fn();
vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        listContainers: (...args: unknown[]) => mockListContainers(...args),
        getContainer: (id: string) => ({ inspect: () => mockInspect(id) }),
      }),
    }),
  },
}));

const mockRenderConfig = vi.fn();
vi.mock('../services/ComposeService', () => ({
  ComposeService: { getInstance: () => ({ renderConfig: (...args: unknown[]) => mockRenderConfig(...args) }) },
  getComposeCommandTimeoutMs: () => 30_000,
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getProxyTarget: () => ({
        apiUrl: 'http://192.168.1.50:1852/',
        apiToken: 't'.repeat(64),
        trustedLoopback: false,
      }),
    }),
  },
}));

vi.mock('../services/LicenseService', () => ({
  LicenseService: { getInstance: () => ({ getProxyHeaders: () => ({ tier: 'community' }) }) },
}));

import {
  readStackDeclaredRestartIntent,
  readStackHealthFacts,
  type StackContainerFact,
} from '../services/health/stackHealthFacts';

const REMOTE_NODE_ID = 7;
const LOCAL_NODE_ID = 1;

const LEAF_CONTAINER: StackContainerFact = {
  id: 'c1'.padEnd(64, '0'),
  name: 'web-app-1',
  service: 'app',
  state: 'running',
  health: 'healthy',
  restartCount: 0,
  startedAt: '2026-06-10T00:00:00Z',
  imageId: 'sha256:abc',
  exitCode: 0,
  restartPolicy: 'unless-stopped',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNode.mockImplementation((nodeId: number) => ({
    id: nodeId,
    type: nodeId === REMOTE_NODE_ID ? 'remote' : 'local',
  }));
  mockProbe.mockResolvedValue({ kind: 'supported' });
  mockListContainers.mockResolvedValue([]);
  mockInspect.mockReset();
  mockRenderConfig.mockReset();
});

describe('readStackHealthFacts', () => {
  it('reads a remote stack from the node that hosts it', async () => {
    mockAxiosGet.mockResolvedValue({
      status: 200,
      data: { containers: [LEAF_CONTAINER], declaredRestartByService: null },
    });

    const read = await readStackHealthFacts({ nodeId: REMOTE_NODE_ID, stackName: 'web' });

    expect(read).toEqual({ kind: 'ok', containers: [LEAF_CONTAINER] });
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://192.168.1.50:1852/api/stacks/web/health-observation',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${'t'.repeat(64)}` }),
      }),
    );
    expect(mockListContainers, 'and never the hub\'s own Docker').not.toHaveBeenCalled();
  });

  it('treats a node that does not serve the route as unsupported', async () => {
    mockAxiosGet.mockResolvedValue({ status: 404, data: 'Cannot GET /api/stacks/web/health-observation' });
    mockProbe.mockResolvedValue({ kind: 'unsupported' });

    const read = await readStackHealthFacts({ nodeId: REMOTE_NODE_ID, stackName: 'web' });

    expect(read).toEqual({ kind: 'unsupported' });
    expect(mockProbe).toHaveBeenCalledWith(REMOTE_NODE_ID, 'health-gate-observation-v1');
  });

  it('retries a capable node that did not answer', async () => {
    mockAxiosGet.mockResolvedValue({ status: 503, data: { error: 'busy' } });

    const read = await readStackHealthFacts({ nodeId: REMOTE_NODE_ID, stackName: 'web' });

    expect(read).toEqual({ kind: 'unavailable', cause: 'node', detail: 'HTTP 503' });
  });

  it('rejects a payload it cannot read in full rather than dropping a container', async () => {
    mockAxiosGet.mockResolvedValue({
      status: 200,
      data: { containers: [LEAF_CONTAINER, { name: 'web-db-1' }] },
    });

    const read = await readStackHealthFacts({ nodeId: REMOTE_NODE_ID, stackName: 'web' });

    expect(read).toEqual({ kind: 'unavailable', cause: 'node', detail: 'invalid observation payload' });
  });

  it('keeps the in-process read for a local node', async () => {
    mockListContainers.mockResolvedValue([
      { Id: 'c9', Names: ['/web-app-1'], State: 'running', Labels: { 'com.docker.compose.service': 'app' } },
    ]);
    mockInspect.mockResolvedValue({
      State: {
        Status: 'running',
        ExitCode: 0,
        Health: { Status: 'healthy' },
        StartedAt: '2026-06-10T00:00:00Z',
      },
      RestartCount: 0,
      Image: 'sha256:abc',
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      Config: { Labels: { 'com.docker.compose.service': 'app' } },
    });

    const read = await readStackHealthFacts({ nodeId: LOCAL_NODE_ID, stackName: 'web' });

    expect(read).toEqual({
      kind: 'ok',
      containers: [{ ...LEAF_CONTAINER, id: 'c9' }],
    });
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('reports a local daemon that cannot answer as a docker read', async () => {
    mockListContainers.mockRejectedValue(new Error('connect ECONNREFUSED /var/run/docker.sock'));

    const read = await readStackHealthFacts({ nodeId: LOCAL_NODE_ID, stackName: 'web' });

    expect(read).toEqual({
      kind: 'unavailable',
      cause: 'docker',
      detail: 'connect ECONNREFUSED /var/run/docker.sock',
    });
  });

  it('never falls back to the local daemon for a node it does not know', async () => {
    mockGetNode.mockReturnValue(undefined);

    const read = await readStackHealthFacts({ nodeId: 99, stackName: 'web' });

    expect(read).toEqual({
      kind: 'unavailable',
      cause: 'node',
      detail: 'node 99 is not known to this instance',
    });
    expect(mockListContainers, 'the hub\'s own containers are not the target\'s').not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});

describe('readStackDeclaredRestartIntent', () => {
  it('reads the leaf-rendered intent from the same route, on request', async () => {
    mockAxiosGet.mockResolvedValue({
      status: 200,
      data: { containers: [LEAF_CONTAINER], declaredRestartByService: { app: 'no', worker: null } },
    });

    const declared = await readStackDeclaredRestartIntent({ nodeId: REMOTE_NODE_ID, stackName: 'web' });

    expect([...declared ?? []]).toEqual([['app', 'no'], ['worker', null]]);
    expect(String(mockAxiosGet.mock.calls[0]?.[0])).toContain('declaredRestart=1');
  });

  it('is null when the node cannot answer, so the caller fails closed', async () => {
    mockAxiosGet.mockResolvedValue({ status: 500, data: null });

    expect(await readStackDeclaredRestartIntent({ nodeId: REMOTE_NODE_ID, stackName: 'web' })).toBeNull();
  });

  it('renders a local stack in-process', async () => {
    mockRenderConfig.mockResolvedValue({
      rendered: JSON.stringify({ name: 'web', services: { app: { image: 'nginx', restart: 'no' } } }),
      stderr: '',
      code: 0,
      timedOut: false,
    });

    const declared = await readStackDeclaredRestartIntent({ nodeId: LOCAL_NODE_ID, stackName: 'web' });

    expect([...declared ?? []]).toEqual([['app', 'no']]);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});

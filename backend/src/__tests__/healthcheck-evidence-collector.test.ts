/**
 * Unit tests for collectServiceHealthcheckEvidence. Mocks Docker list/inspect
 * and image inspect; asserts structural evidence states and that Test command
 * text never appears in returned evidence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { collectServiceHealthcheckEvidence } from '../services/healthcheck/collectServiceHealthcheckEvidence';
import type { EffectiveModel, EffService } from '../services/preflight/effectiveModel';
import DockerController from '../services/DockerController';

function svc(over: Partial<EffService> = {}): EffService {
  const hasHealthcheck = over.hasHealthcheck ?? false;
  const composeHealthcheck = over.composeHealthcheck ?? (hasHealthcheck ? 'active' : 'absent');
  return {
    name: 'web', image: 'nginx:1.27', ports: [], binds: [], namedVolumes: [], storageMounts: [],
    privileged: false, restart: 'unless-stopped', envKeys: [],
    enabledProxyApiFlags: [],
    dockerEndpointHosts: [],
    networks: [], extraHosts: [], labelKeys: [],
    ...over,
    hasHealthcheck,
    composeHealthcheck,
  };
}

function model(services: EffService[]): EffectiveModel {
  return { projectName: 'proj', services, networks: {}, volumes: {} };
}

function mockDocker(opts: {
  list?: unknown[];
  inspectById?: Record<string, { Config?: { Image?: string; Healthcheck?: { Test?: unknown } } }>;
  image?: { Config?: { Healthcheck?: { Test?: unknown } } } | 'missing' | 'error';
}) {
  const getContainer = vi.fn((id: string) => ({
    inspect: vi.fn(async () => {
      const hit = opts.inspectById?.[id];
      if (!hit) {
        const err = Object.assign(new Error('not found'), { statusCode: 404 });
        throw err;
      }
      return hit;
    }),
  }));
  const listContainers = vi.fn(async () => opts.list ?? []);
  const getDocker = vi.fn(() => ({ listContainers, getContainer }));
  const inspectImage = vi.fn(async () => {
    if (opts.image === 'missing' || opts.image === 'error') {
      throw Object.assign(new Error('No such image'), { statusCode: 404 });
    }
    return { inspect: opts.image ?? { Config: {} }, history: [] };
  });
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDocker,
    inspectImage,
  } as unknown as DockerController);
  return { listContainers, getContainer, inspectImage };
}

describe('collectServiceHealthcheckEvidence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns compose-declared for an active Compose healthcheck without Docker calls', async () => {
    const { listContainers } = mockDocker({});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ hasHealthcheck: true, composeHealthcheck: 'active' })]), true,
    );
    expect(evidence.web).toEqual({ state: 'compose-declared', origin: 'compose', consistentReplicas: null });
    expect(listContainers).not.toHaveBeenCalled();
  });

  it('returns explicitly-disabled for Compose disablement', async () => {
    mockDocker({});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'disabled' })]), true,
    );
    expect(evidence.web.state).toBe('explicitly-disabled');
  });

  it('lists containers by Compose projectName, not the stack directory name', async () => {
    const { listContainers } = mockDocker({
      list: [{
        Id: 'c1',
        Labels: { 'com.docker.compose.service': 'web' },
        Image: 'nginx:1.27',
      }],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['CMD', 'true'] } } },
      },
    });
    const m: EffectiveModel = {
      projectName: 'qa-hc-1713',
      services: [svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })],
      networks: {},
      volumes: {},
    };
    const evidence = await collectServiceHealthcheckEvidence(1, 'qa-healthcheck', m, true);
    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['com.docker.compose.project=qa-hc-1713'] },
    });
    expect(evidence.web.state).toBe('runtime-inherited');
  });

  it('recognizes runtime-inherited healthchecks and never returns Test text', async () => {
    mockDocker({
      list: [{
        Id: 'c1',
        Names: ['/proj-web-1'],
        Labels: { 'com.docker.compose.service': 'web' },
        Image: 'nginx:1.27',
      }],
      inspectById: {
        c1: {
          Config: {
            Image: 'nginx:1.27',
            Healthcheck: { Test: ['CMD-SHELL', 'curl -f http://x/?token=secret-token || exit 1'] },
          },
        },
      },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web).toEqual({
      state: 'runtime-inherited',
      origin: 'runtime',
      consistentReplicas: true,
    });
    expect(JSON.stringify(evidence)).not.toContain('secret-token');
    expect(JSON.stringify(evidence)).not.toContain('CMD-SHELL');
  });

  it('matches containers via composeServiceMatch when the service label is absent', async () => {
    mockDocker({
      list: [{ Id: 'c1', Names: ['/web'], Image: 'nginx:1.27' }],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['CMD', 'true'] } } },
      },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ name: 'web', composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('runtime-inherited');
  });

  it('ignores stale image replicas and uses local-image evidence', async () => {
    mockDocker({
      list: [{
        Id: 'c1',
        Labels: { 'com.docker.compose.service': 'web' },
        Image: 'nginx:old',
      }],
      inspectById: {
        c1: { Config: { Image: 'nginx:old', Healthcheck: { Test: ['CMD', 'true'] } } },
      },
      image: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('local-image-inherited');
    expect(evidence.web.origin).toBe('local-image');
  });

  it('reports inconsistent-replicas when coverage mixes', async () => {
    mockDocker({
      list: [
        { Id: 'c1', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' },
        { Id: 'c2', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' },
      ],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['CMD', 'true'] } } },
        c2: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['NONE'] } } },
      },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('inconsistent-replicas');
  });

  it('reports unverifiable when Docker is unavailable', async () => {
    mockDocker({});
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent' })]), false,
    );
    expect(evidence.web.state).toBe('unverifiable');
  });

  it('reports unverifiable for a missing local image', async () => {
    mockDocker({ list: [], image: 'missing' });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('unverifiable');
  });

  it('reports unverifiable for build-only services with no image', async () => {
    mockDocker({ list: [] });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: undefined })]), true,
    );
    expect(evidence.web.state).toBe('unverifiable');
  });

  it('reports absent when local image has no healthcheck', async () => {
    mockDocker({ list: [], image: { Config: {} } });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web).toEqual({
      state: 'absent',
      origin: 'local-image',
      consistentReplicas: null,
    });
  });

  it('reports absent when matching replicas lack a healthcheck even if the local image has one', async () => {
    mockDocker({
      list: [{
        Id: 'c1',
        Labels: { 'com.docker.compose.service': 'web' },
        Image: 'nginx:1.27',
      }],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['NONE'] } } },
      },
      image: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web).toEqual({
      state: 'absent',
      origin: 'runtime',
      consistentReplicas: true,
    });
  });

  it('reports unverifiable when some replica inspects fail amid otherwise full coverage', async () => {
    mockDocker({
      list: [
        { Id: 'c1', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' },
        { Id: 'gone', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' },
      ],
      inspectById: {
        c1: { Config: { Image: 'nginx:1.27', Healthcheck: { Test: ['CMD', 'true'] } } },
      },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('unverifiable');
    expect(evidence.web.origin).toBe('runtime');
  });

  it('treats a disappearing container as inspect failure and falls through', async () => {
    mockDocker({
      list: [{ Id: 'gone', Labels: { 'com.docker.compose.service': 'web' }, Image: 'nginx:1.27' }],
      inspectById: {},
      image: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
    });
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('local-image-inherited');
  });
});

describe('collectServiceHealthcheckEvidence list failure', () => {
  beforeEach(() => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn(async () => { throw new Error('daemon down'); }),
        getContainer: vi.fn(),
      }),
      inspectImage: vi.fn(async () => ({
        inspect: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
        history: [],
      })),
    } as unknown as DockerController);
  });
  afterEach(() => vi.restoreAllMocks());

  it('falls through to local-image evidence when the container list fails', async () => {
    const evidence = await collectServiceHealthcheckEvidence(
      1, 'proj', model([svc({ composeHealthcheck: 'absent', image: 'nginx:1.27' })]), true,
    );
    expect(evidence.web.state).toBe('local-image-inherited');
  });
});

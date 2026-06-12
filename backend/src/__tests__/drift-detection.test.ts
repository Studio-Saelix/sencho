/**
 * Unit tests for the spatial drift engine: per-finding and per-status diff
 * behaviour of assembleStackDrift, image-reference normalization, and the
 * fail-soft boundaries of buildStackDriftReport (compose read failure → drifted,
 * Docker failure → unreachable).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  assembleStackDrift,
  normalizeImageRef,
  buildStackDriftReport,
} from '../services/DriftDetectionService';
import DockerController from '../services/DockerController';
import type { DependencyContainer, DependencyNetwork, DependencySnapshot } from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';
import type { DeclaredCompose, DeclaredService, DeclaredPort } from '../helpers/composeDependencyParse';

// ── builders ────────────────────────────────────────────────────────────

function port(publishedPort: number, protocol = 'tcp'): DeclaredPort {
  return { hostIp: '', publishedPort, protocol };
}

function service(p: Partial<DeclaredService> & { name: string }): DeclaredService {
  return { dependsOn: [], networks: [], volumes: [], ports: [], ...p };
}

function declared(services: DeclaredService[], parseError?: string): DeclaredCompose {
  return { services, networks: {}, volumes: {}, ...(parseError ? { parseError } : {}) };
}

function container(p: Partial<DependencyContainer> & { id: string }): DependencyContainer {
  return {
    name: p.id, service: null, composeProject: null, stack: 'app',
    state: 'running', image: 'img:latest', networks: [], volumes: [], ports: [], ...p,
  };
}

const findingKinds = (r: { findings: { kind: string }[] }): string[] => r.findings.map((f) => f.kind).sort();

// ── assembleStackDrift: statuses ──────────────────────────────────────────

describe('assembleStackDrift - status', () => {
  it('reports in-sync when running services, images and ports all match', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', image: 'nginx:1.25', ports: [port(8080)] })]),
      containers: [container({ id: 'c1', service: 'web', image: 'nginx:1.25', ports: [{ ip: '', publishedPort: 8080, privatePort: 80, protocol: 'tcp' }] })],
    });
    expect(report.status).toBe('in-sync');
    expect(report.findings).toEqual([]);
    expect(report.hasContainers).toBe(true);
  });

  it('reports missing-runtime with no findings when nothing is running', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' }), service({ name: 'db' })]),
      containers: [],
    });
    expect(report.status).toBe('missing-runtime');
    expect(report.findings).toEqual([]);
    expect(report.hasContainers).toBe(false);
  });

  it('treats a stack whose only container is exited as missing-runtime', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web', state: 'exited' })],
    });
    expect(report.status).toBe('missing-runtime');
    expect(report.findings).toEqual([]);
  });

  it('counts a restarting container as deployed', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', image: 'nginx:1.25' })]),
      containers: [container({ id: 'c1', service: 'web', image: 'nginx:1.25', state: 'restarting' })],
    });
    expect(report.status).toBe('in-sync');
    expect(report.hasContainers).toBe(true);
  });

  it('reports drifted with a synthetic-free parseError when compose cannot be parsed', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([], 'Could not parse compose file: bad yaml'),
      containers: [container({ id: 'c1', service: 'web' })],
      parseError: 'Could not parse compose file: bad yaml',
    });
    expect(report.status).toBe('drifted');
    expect(report.hasComposeFile).toBe(false);
    expect(report.parseError).toContain('Could not parse');
    expect(report.findings).toEqual([]);
    // hasContainers still reflects the runtime even when compose is unparseable.
    expect(report.hasContainers).toBe(true);
  });
});

// ── assembleStackDrift: findings ──────────────────────────────────────────

describe('assembleStackDrift - findings', () => {
  it('flags a declared service that has no running container', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' }), service({ name: 'db' })]),
      containers: [container({ id: 'c1', service: 'web' })],
    });
    expect(report.status).toBe('drifted');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: 'service-missing', service: 'db' });
  });

  it('flags a running container with no matching declared service', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web' }), container({ id: 'c2', service: 'sidecar' })],
    });
    expect(findingKinds(report)).toEqual(['service-undeclared']);
    expect(report.findings[0]).toMatchObject({ kind: 'service-undeclared', service: 'sidecar' });
  });

  it('flags an image mismatch with expected and actual values', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', image: 'nginx:1.25' })]),
      containers: [container({ id: 'c1', service: 'web', image: 'nginx:1.24' })],
    });
    expect(findingKinds(report)).toEqual(['image-mismatch']);
    expect(report.findings[0]).toMatchObject({ kind: 'image-mismatch', service: 'web', expected: 'nginx:1.25', actual: 'nginx:1.24' });
  });

  it('does not flag an image mismatch for tag-equivalent references', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', image: 'nginx' })]),
      containers: [container({ id: 'c1', service: 'web', image: 'docker.io/library/nginx:latest' })],
    });
    expect(report.status).toBe('in-sync');
    expect(report.findings).toEqual([]);
  });

  it('skips the image check for a build-only service (no declared image)', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web', image: 'app-web:built' })],
    });
    expect(report.status).toBe('in-sync');
    expect(report.findings).toEqual([]);
  });

  it('flags a port mismatch with expected and actual sets', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', ports: [port(8080)] })]),
      containers: [container({ id: 'c1', service: 'web', ports: [{ ip: '', publishedPort: 9090, privatePort: 80, protocol: 'tcp' }] })],
    });
    expect(findingKinds(report)).toEqual(['ports-mismatch']);
    expect(report.findings[0]).toMatchObject({ kind: 'ports-mismatch', service: 'web', expected: '8080/tcp', actual: '9090/tcp' });
  });

  it('treats the same port number on a different protocol as a mismatch', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', ports: [port(53, 'tcp')] })]),
      containers: [container({ id: 'c1', service: 'web', ports: [{ ip: '', publishedPort: 53, privatePort: 53, protocol: 'udp' }] })],
    });
    expect(findingKinds(report)).toEqual(['ports-mismatch']);
  });

  it('collapses replicas of one service without a spurious undeclared finding', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', image: 'nginx:1.25' })]),
      containers: [
        container({ id: 'c1', service: 'web', image: 'nginx:1.25' }),
        container({ id: 'c2', service: 'web', image: 'nginx:1.25' }),
      ],
    });
    expect(report.status).toBe('in-sync');
    expect(report.findings).toEqual([]);
  });

  it('ignores non-running containers when aggregating runtime state', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', image: 'nginx:1.25' })]),
      containers: [
        container({ id: 'c1', service: 'web', image: 'nginx:1.25' }),
        container({ id: 'c2', service: 'web', image: 'nginx:1.24', state: 'exited' }),
      ],
    });
    expect(report.status).toBe('in-sync');
    expect(report.findings).toEqual([]);
  });

  it('reports multiple distinct findings without double-reporting a service', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', image: 'nginx:1.25' }), service({ name: 'db' })]),
      containers: [
        container({ id: 'c1', service: 'web', image: 'nginx:1.24' }),
        container({ id: 'c2', service: 'cache' }),
      ],
    });
    // web -> image-mismatch, db -> service-missing, cache -> service-undeclared.
    expect(findingKinds(report)).toEqual(['image-mismatch', 'service-missing', 'service-undeclared']);
    expect(report.findings.filter((f) => f.service === 'web')).toHaveLength(1);
  });

  it('flags an image mismatch when replicas run divergent images', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', image: 'nginx:1.25' })]),
      containers: [
        container({ id: 'c1', service: 'web', image: 'nginx:1.25' }),
        container({ id: 'c2', service: 'web', image: 'nginx:1.24' }),
      ],
    });
    expect(findingKinds(report)).toEqual(['image-mismatch']);
    expect(report.findings[0].actual).toContain('nginx:1.24');
    expect(report.findings[0].actual).toContain('nginx:1.25');
  });

  it('falls back to the container name when the compose service label is null', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [
        container({ id: 'c1', service: 'web' }),
        container({ id: 'orphan', service: null, name: 'orphan' }),
      ],
    });
    expect(findingKinds(report)).toEqual(['service-undeclared']);
    expect(report.findings[0].service).toBe('orphan');
  });

  it('reports "none" as the runtime side when a declared port is unpublished', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', ports: [port(8080)] })]),
      containers: [container({ id: 'c1', service: 'web', ports: [] })],
    });
    expect(findingKinds(report)).toEqual(['ports-mismatch']);
    expect(report.findings[0]).toMatchObject({ expected: '8080/tcp', actual: 'none' });
  });
});

// ── assembleStackDrift: network drift ─────────────────────────────────────

function depNet(name: string, p: Partial<DependencyNetwork> = {}): DependencyNetwork {
  return { id: name, name, driver: 'bridge', scope: 'local', isSystem: false, composeProject: 'app', stack: 'app', ...p };
}

describe('assembleStackDrift - network drift', () => {
  it('flags a runtime-only attachment to a stack-owned undeclared network', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web', networks: [{ name: 'app_default', id: 'd', ip: '' }, { name: 'app_extra', id: 'e', ip: '' }] })],
      networks: [depNet('app_default'), depNet('app_extra')],
    });
    const f = report.findings.find(x => x.kind === 'network-undeclared');
    expect(f).toMatchObject({ service: 'web', actual: 'app_extra' });
    expect(f?.detail).not.toContain('app_default'); // the implicit default is declared
  });

  it('maps a foreign network attachment back to its service (not the container name)', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      // Distinct container name vs service proves the service-map lookup ran, not the name fallback.
      containers: [container({ id: 'c1', name: 'app-web-1', service: 'web', networks: [{ name: 'other_net', id: 'o', ip: '' }] })],
      networks: [depNet('other_net', { stack: 'other', composeProject: 'other' })],
    });
    expect(report.findings.find(x => x.kind === 'network-undeclared')).toMatchObject({ service: 'web', actual: 'other_net' });
  });

  it('aggregates multiple undeclared networks on one service into a single finding', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web', networks: [{ name: 'app_extra1', id: '1', ip: '' }, { name: 'app_extra2', id: '2', ip: '' }] })],
      networks: [depNet('app_extra1'), depNet('app_extra2')],
    });
    const f = report.findings.filter(x => x.kind === 'network-undeclared');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ service: 'web', actual: 'app_extra1, app_extra2' });
    expect(f[0].detail).toContain('networks not declared'); // plural wording
  });

  it('flags a declared network that no running service uses, by its runtime name', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: { services: [service({ name: 'web', networks: ['frontend'] })], networks: { frontend: { external: false }, backend: { external: false } }, volumes: {} },
      containers: [container({ id: 'c1', service: 'web', networks: [{ name: 'app_frontend', id: 'f', ip: '' }] })],
      networks: [depNet('app_frontend'), depNet('app_backend')],
    });
    expect(report.findings.find(x => x.kind === 'network-missing')).toMatchObject({ service: '', expected: 'app_backend' });
  });

  it('reports unused and absent declared networks together in one consistent namespace', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: { services: [service({ name: 'web', networks: ['frontend'] })], networks: { frontend: { external: false }, backend: { external: false }, gamma: { external: false } }, volumes: {} },
      containers: [container({ id: 'c1', service: 'web', networks: [{ name: 'app_frontend', id: 'f', ip: '' }] })],
      // app_backend exists but is unused; app_gamma is absent from the runtime.
      networks: [depNet('app_frontend'), depNet('app_backend')],
    });
    const f = report.findings.filter(x => x.kind === 'network-missing');
    expect(f).toHaveLength(1);
    expect(f[0].expected).toBe('app_backend, app_gamma'); // both as runtime names, not mixed keys
  });

  it('ignores system and default networks', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web', networks: [{ name: 'bridge', id: 'b', ip: '' }, { name: 'app_default', id: 'd', ip: '' }] })],
      networks: [depNet('bridge', { isSystem: true, stack: null }), depNet('app_default')],
    });
    expect(report.findings.filter(x => x.kind.startsWith('network-'))).toEqual([]);
  });

  it('reports no network drift for a stopped stack', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web', state: 'exited', networks: [{ name: 'app_extra', id: 'e', ip: '' }] })],
      networks: [depNet('app_extra')],
    });
    expect(report.status).toBe('missing-runtime');
    expect(report.findings).toEqual([]);
  });

  it('resolves runtime network names via the compose top-level name (no false drift)', () => {
    // Stack dir is "app" but the compose declares `name: acme`, so Docker names
    // the network acme_backend. With the project name carried through, that
    // matches and produces no network-undeclared / network-missing.
    const report = assembleStackDrift({
      stack: 'app',
      declared: { services: [service({ name: 'web', networks: ['backend'] })], networks: { backend: { external: false } }, volumes: {}, projectName: 'acme' },
      containers: [container({ id: 'c1', service: 'web', networks: [{ name: 'acme_default', id: 'd', ip: '' }, { name: 'acme_backend', id: 'b', ip: '' }] })],
      networks: [depNet('acme_default'), depNet('acme_backend')],
    });
    expect(report.findings.filter(f => f.kind.startsWith('network-'))).toEqual([]);
  });
});

// ── normalizeImageRef ─────────────────────────────────────────────────────

describe('normalizeImageRef', () => {
  it('appends :latest when no tag is present', () => {
    expect(normalizeImageRef('nginx')).toBe('nginx:latest');
  });

  it('strips the docker.io/library prefix for official images', () => {
    expect(normalizeImageRef('docker.io/library/nginx')).toBe('nginx:latest');
    expect(normalizeImageRef('docker.io/library/redis:7')).toBe('redis:7');
  });

  it('does not mistake a registry port for a tag', () => {
    expect(normalizeImageRef('registry:5000/team/app')).toBe('registry:5000/team/app:latest');
  });

  it('leaves a digest-pinned reference intact', () => {
    expect(normalizeImageRef('nginx@sha256:abc')).toBe('nginx@sha256:abc');
  });
});

// ── buildStackDriftReport: fail-soft boundaries ───────────────────────────

describe('buildStackDriftReport - boundaries', () => {
  it('reports unreachable when the Docker snapshot fails', async () => {
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      getStackContent: vi.fn().mockResolvedValue('services:\n  web:\n    image: nginx:1.25\n'),
      getStacks: vi.fn().mockResolvedValue(['app']),
    } as unknown as FileSystemService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockRejectedValue(new Error('docker down')),
    } as unknown as DockerController);

    const report = await buildStackDriftReport(0, 'app');
    expect(report.status).toBe('unreachable');
    expect(report.findings).toEqual([]);
    vi.restoreAllMocks();
  });

  it('reports drifted with a parseError when the compose file cannot be read', async () => {
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      getStackContent: vi.fn().mockRejectedValue(new Error('ENOENT')),
      getStacks: vi.fn().mockResolvedValue(['app']),
    } as unknown as FileSystemService);

    const report = await buildStackDriftReport(0, 'app');
    expect(report.status).toBe('drifted');
    expect(report.hasComposeFile).toBe(false);
    expect(report.parseError).toBe('ENOENT');
    vi.restoreAllMocks();
  });

  it('diffs a real snapshot into an image-mismatch finding', async () => {
    const snapshot: DependencySnapshot = {
      containers: [container({ id: 'c1', service: 'web', stack: 'app', image: 'nginx:1.24' })],
      networks: [],
      volumes: [],
    };
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      getStackContent: vi.fn().mockResolvedValue('services:\n  web:\n    image: nginx:1.25\n'),
      getStacks: vi.fn().mockResolvedValue(['app']),
    } as unknown as FileSystemService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue(snapshot),
    } as unknown as DockerController);

    const report = await buildStackDriftReport(0, 'app');
    expect(report.status).toBe('drifted');
    expect(findingKinds(report)).toEqual(['image-mismatch']);
    vi.restoreAllMocks();
  });

  it('threads the snapshot networks through into a network-undeclared finding', async () => {
    const snapshot: DependencySnapshot = {
      containers: [container({ id: 'c1', service: 'web', stack: 'app', image: 'nginx:1.25', networks: [{ name: 'app_rogue', id: 'r', ip: '' }] })],
      networks: [depNet('app_rogue')],
      volumes: [],
    };
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      getStackContent: vi.fn().mockResolvedValue('services:\n  web:\n    image: nginx:1.25\n'),
      getStacks: vi.fn().mockResolvedValue(['app']),
    } as unknown as FileSystemService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue(snapshot),
    } as unknown as DockerController);

    const report = await buildStackDriftReport(0, 'app');
    expect(findingKinds(report)).toContain('network-undeclared');
    vi.restoreAllMocks();
  });
});

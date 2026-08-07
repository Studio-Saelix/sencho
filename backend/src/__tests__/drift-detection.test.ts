/**
 * Unit tests for the spatial drift engine: per-finding and per-status diff
 * behaviour of assembleStackDrift, image-reference normalization, and the
 * fail-soft boundaries of buildStackDriftReport (render failure → drifted,
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
import { ComposeService } from '../services/ComposeService';
import { declaredFromEffectiveModel } from '../helpers/effectiveToDeclaredCompose';
import type { DeclaredCompose, DeclaredService, DeclaredPort } from '../helpers/composeDependencyParse';
import type { EffectiveModel, EffService } from '../services/preflight/effectiveModel';
import { fromDeclaredCompose, fromEffectiveModel } from '../services/network/normalize';
import { DatabaseService } from '../services/DatabaseService';

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
    state: 'running', exitCode: null, image: 'img:latest', networks: [], volumes: [], ports: [], ...p,
  };
}

const findingKinds = (r: { findings: { kind: string }[] }): string[] => r.findings.map((f) => f.kind).sort();

function effSvc(over: Partial<EffService> = {}): EffService {
  const hasHealthcheck = over.hasHealthcheck ?? true;
  const composeHealthcheck = over.composeHealthcheck ?? (hasHealthcheck ? 'active' : 'absent');
  return {
    name: 'web', image: 'nginx:1.27', ports: [], binds: [], namedVolumes: [], storageMounts: [],
    privileged: false, restart: 'unless-stopped', envKeys: [],
    enabledProxyApiFlags: [],
    networks: [], extraHosts: [], labelKeys: [],
    ...over,
    hasHealthcheck,
    composeHealthcheck,
  };
}

function stubDockerRender(
  rendered: object | null,
  stderr = '',
) {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: rendered === null ? null : JSON.stringify(rendered),
      stderr,
      code: rendered === null ? 1 : 0,
      timedOut: false,
    }),
  } as unknown as ComposeService);
}

function stubFsAndSnapshot(snapshot: DependencySnapshot) {
  vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
    getStacks: vi.fn().mockResolvedValue(['app']),
  } as unknown as FileSystemService);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue(snapshot),
  } as unknown as DockerController);
}

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

  it('does not emit service-missing for a clean one-shot beside a running service', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([
        service({ name: 'app', image: 'app:1', restart: 'unless-stopped' }),
        service({ name: 'migrate', image: 'migrate:1', restart: 'no' }),
      ]),
      containers: [
        container({ id: 'c1', service: 'app', image: 'app:1', state: 'running' }),
        container({ id: 'c2', service: 'migrate', image: 'migrate:1', state: 'exited', exitCode: 0 }),
      ],
    });
    expect(findingKinds(report)).not.toContain('service-missing');
    expect(report.status).toBe('in-sync');
    expect(report.hasContainers).toBe(true);
  });

  it('still emits service-missing when a one-shot exits non-zero', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([
        service({ name: 'app', image: 'app:1', restart: 'unless-stopped' }),
        service({ name: 'migrate', image: 'migrate:1', restart: 'no' }),
      ]),
      containers: [
        container({ id: 'c1', service: 'app', image: 'app:1', state: 'running' }),
        container({ id: 'c2', service: 'migrate', image: 'migrate:1', state: 'exited', exitCode: 1 }),
      ],
    });
    expect(findingKinds(report)).toContain('service-missing');
    expect(report.findings.find(f => f.kind === 'service-missing')?.service).toBe('migrate');
  });

  it('still treats exited unless-stopped as missing even with exit 0', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web', restart: 'unless-stopped' })]),
      containers: [container({ id: 'c1', service: 'web', state: 'exited', exitCode: 0 })],
    });
    expect(report.status).toBe('missing-runtime');
    expect(report.hasContainers).toBe(false);
  });

  it('fails closed when exitCode is null even with restart no', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([
        service({ name: 'app', image: 'app:1', restart: 'unless-stopped' }),
        service({ name: 'migrate', image: 'migrate:1', restart: 'no' }),
      ]),
      containers: [
        container({ id: 'c1', service: 'app', image: 'app:1', state: 'running' }),
        container({ id: 'c2', service: 'migrate', image: 'migrate:1', state: 'exited', exitCode: null }),
      ],
    });
    expect(findingKinds(report)).toContain('service-missing');
    expect(report.findings.find(f => f.kind === 'service-missing')?.service).toBe('migrate');
  });

  it('does not treat absent declared restart as a clean one-shot', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([
        service({ name: 'app', image: 'app:1', restart: 'unless-stopped' }),
        service({ name: 'daemon-default', image: 'daemon:1' }),
      ]),
      containers: [
        container({ id: 'c1', service: 'app', image: 'app:1' }),
        container({ id: 'c2', service: 'daemon-default', image: 'daemon:1', state: 'exited', exitCode: 0 }),
      ],
    });
    expect(findingKinds(report)).toContain('service-missing');
    expect(report.findings.find((f) => f.kind === 'service-missing')?.service).toBe('daemon-default');
  });

  it('all-one-shot stack with dedicated network is not missing-runtime but keeps network-missing and hasContainers false', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: {
        services: [service({ name: 'migrate', restart: 'no', networks: ['jobs'] })],
        networks: { jobs: { external: false } },
        volumes: {},
        projectName: 'app',
      },
      containers: [
        container({
          id: 'c1', service: 'migrate', state: 'exited', exitCode: 0,
          networks: [{ name: 'app_jobs', id: 'j', ip: '' }],
        }),
      ],
      networks: [depNet('app_jobs')],
    });
    expect(report.status).not.toBe('missing-runtime');
    expect(findingKinds(report)).not.toContain('service-missing');
    expect(report.hasContainers).toBe(false);
    expect(findingKinds(report)).toContain('network-missing');
    expect(report.status).toBe('drifted');
  });

  it('all-one-shot stack without network findings is in-sync with hasContainers false', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'migrate', restart: 'no' })]),
      containers: [container({ id: 'c1', service: 'migrate', state: 'exited', exitCode: 0 })],
    });
    expect(report.status).toBe('in-sync');
    expect(report.hasContainers).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('emits service-missing when normalized restart is always (deploy any)', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([
        service({ name: 'app', image: 'app:1', restart: 'unless-stopped' }),
        service({ name: 'worker', image: 'worker:1', restart: 'always' }),
      ]),
      containers: [
        container({ id: 'c1', service: 'app', image: 'app:1' }),
        container({ id: 'c2', service: 'worker', image: 'worker:1', state: 'exited', exitCode: 0 }),
      ],
    });
    expect(findingKinds(report)).toContain('service-missing');
    expect(report.findings.find((f) => f.kind === 'service-missing')?.service).toBe('worker');
  });

  it('emits service-missing when normalized restart is on-failure', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([
        service({ name: 'app', image: 'app:1', restart: 'unless-stopped' }),
        service({ name: 'worker', image: 'worker:1', restart: 'on-failure' }),
      ]),
      containers: [
        container({ id: 'c1', service: 'app', image: 'app:1' }),
        container({ id: 'c2', service: 'worker', image: 'worker:1', state: 'exited', exitCode: 0 }),
      ],
    });
    expect(findingKinds(report)).toContain('service-missing');
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

  it('reports in-sync when declared image matches a resolved default tag (#1572)', () => {
    const image = 'ghcr.io/karakeep-app/karakeep:release';
    const report = assembleStackDrift({
      stack: 'karakeep',
      declared: declared([service({ name: 'karakeep', image })]),
      containers: [container({ id: 'c1', service: 'karakeep', image })],
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

  it('does not false-flag explicit network names equal to compose keys (regression: #1581)', () => {
    const report = assembleStackDrift({
      stack: 'network',
      declared: {
        services: [service({ name: 'tsbridge', networks: ['tailscale'] })],
        networks: {
          tailscale: { external: false, name: 'tailscale' },
        },
        volumes: {},
        projectName: 'network',
      },
      containers: [container({
        id: 'c1',
        service: 'tsbridge',
        stack: 'network',
        networks: [{ name: 'tailscale', id: 't', ip: '' }, { name: 'network_default', id: 'd', ip: '' }],
      })],
      networks: [depNet('tailscale'), depNet('network_default')],
    });
    expect(report.findings.filter(f => f.kind === 'network-undeclared')).toEqual([]);
    expect(report.findings.filter(f => f.kind === 'network-missing')).toEqual([]);
    expect(report.status).toBe('in-sync');
  });

  it('does not flag an attachment to a declared external network (regression: shared arr-net)', () => {
    // arr-net is declared `external: true` with no name override, so Docker attaches
    // the container to the pre-existing network named "arr-net" (no project prefix).
    // The runtime matches the compose, so this must read as in-sync rather than a
    // foreign/undeclared-network finding.
    const report = assembleStackDrift({
      stack: 'plex',
      declared: { services: [service({ name: 'plex', networks: ['arr-net'] })], networks: { 'arr-net': { external: true } }, volumes: {} },
      containers: [container({ id: 'plex', service: 'plex', stack: 'plex', networks: [{ name: 'arr-net', id: 'a', ip: '' }] })],
      networks: [depNet('arr-net', { composeProject: null, stack: null })],
    });
    expect(report.findings.filter(f => f.kind.startsWith('network-'))).toEqual([]);
    expect(report.status).toBe('in-sync');
  });

  it('reports in-sync when a verified Mesh attachment is the only runtime difference', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web', networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      networks: [depNet('sencho_mesh', { composeProject: null, stack: null })],
      managedNetworkAttachment: (_runtimeContainer, networkName) => networkName === 'sencho_mesh',
    });

    expect(report.status).toBe('in-sync');
    expect(report.findings.filter(f => f.kind === 'network-undeclared')).toEqual([]);
  });

  it('keeps an unverified manual Mesh attachment drifted', () => {
    const report = assembleStackDrift({
      stack: 'app',
      declared: declared([service({ name: 'web' })]),
      containers: [container({ id: 'c1', service: 'web', networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      networks: [depNet('sencho_mesh', { composeProject: null, stack: null })],
      managedNetworkAttachment: () => false,
    });

    expect(report.status).toBe('drifted');
    expect(report.findings.filter(f => f.kind === 'network-undeclared')).toHaveLength(1);
  });
});

// ── declaredFromEffectiveModel ─────────────────────────────────────────────

describe('declaredFromEffectiveModel', () => {
  it('maps resolved images and ports from the effective model', () => {
    const model: EffectiveModel = {
      projectName: 'app',
      services: [effSvc({
        name: 'karakeep',
        image: 'ghcr.io/karakeep-app/karakeep:release',
        ports: [{ startPort: 8080, endPort: 8082, hostIp: '127.0.0.1', protocol: 'tcp' }],
      })],
      networks: { default: { name: 'app_default', external: false, internal: false } },
      volumes: {},
    };
    const converted = declaredFromEffectiveModel(model);
    expect(converted.projectName).toBe('app');
    expect(converted.services[0].image).toBe('ghcr.io/karakeep-app/karakeep:release');
    expect(converted.services[0].ports).toEqual([{ hostIp: '127.0.0.1', publishedPort: 8080, protocol: 'tcp' }]);
  });

  it('preserves restart policy including no, unless-stopped, and absent', () => {
    const withNo = declaredFromEffectiveModel({
      projectName: 'app',
      services: [effSvc({ name: 'migrate', restart: 'no' })],
      networks: {},
      volumes: {},
    });
    expect(withNo.services[0].restart).toBe('no');

    const withUnless = declaredFromEffectiveModel({
      projectName: 'app',
      services: [effSvc({ name: 'web', restart: 'unless-stopped' })],
      networks: {},
      volumes: {},
    });
    expect(withUnless.services[0].restart).toBe('unless-stopped');

    const absent = declaredFromEffectiveModel({
      projectName: 'app',
      services: [effSvc({ name: 'job', restart: undefined })],
      networks: {},
      volumes: {},
    });
    expect(absent.services[0].restart).toBeNull();
  });

  it('normalizes deploy.restart_policy conditions with Compose precedence', () => {
    const none = declaredFromEffectiveModel({
      projectName: 'app',
      services: [effSvc({
        name: 'migrate',
        restart: 'unless-stopped',
        deploy: { restart_policy: { condition: 'none' } },
      })],
      networks: {},
      volumes: {},
    });
    expect(none.services[0].restart).toBe('no');

    const any = declaredFromEffectiveModel({
      projectName: 'app',
      services: [effSvc({
        name: 'worker',
        restart: 'no',
        deploy: { restart_policy: { condition: 'any' } },
      })],
      networks: {},
      volumes: {},
    });
    expect(any.services[0].restart).toBe('always');

    const onFailure = declaredFromEffectiveModel({
      projectName: 'app',
      services: [effSvc({
        name: 'worker',
        restart: undefined,
        deploy: { restart_policy: { condition: 'on-failure' } },
      })],
      networks: {},
      volumes: {},
    });
    expect(onFailure.services[0].restart).toBe('on-failure');

    const defaultAny = declaredFromEffectiveModel({
      projectName: 'app',
      services: [effSvc({
        name: 'worker',
        restart: 'no',
        deploy: { restart_policy: {} },
      })],
      networks: {},
      volumes: {},
    });
    expect(defaultAny.services[0].restart).toBe('always');
  });

  it('normalizes networks so drift matches the rendered model', () => {
    const model: EffectiveModel = {
      projectName: 'myapp',
      services: [effSvc({ name: 'web', networks: [{ key: 'backend', aliases: [] }, { key: 'shared', aliases: [] }] })],
      networks: {
        backend: { name: 'myapp_backend', external: false, internal: false },
        shared: { name: 'shared_net', external: true, internal: false },
      },
      volumes: {},
    };
    expect(fromDeclaredCompose(declaredFromEffectiveModel(model), 'myapp')).toEqual(fromEffectiveModel(model));
  });

  it('round-trips explicit network names equal to compose keys (regression: #1581)', () => {
    const model: EffectiveModel = {
      projectName: 'network',
      services: [effSvc({ name: 'tsbridge', networks: [{ key: 'tailscale', aliases: [] }] })],
      networks: {
        proxy: { name: 'proxy', external: false, internal: false },
        tailscale: { name: 'tailscale', external: false, internal: false },
        vlan: { name: 'vlan', external: false, internal: false },
      },
      volumes: {},
    };
    expect(fromDeclaredCompose(declaredFromEffectiveModel(model), 'network')).toEqual(fromEffectiveModel(model));
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
    stubDockerRender({ name: 'app', services: { web: { image: 'nginx:1.25' } } });
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      getStacks: vi.fn().mockResolvedValue(['app']),
    } as unknown as FileSystemService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockRejectedValue(new Error('docker down')),
    } as unknown as DockerController);

    const report = await buildStackDriftReport(0, 'app');
    expect(report.status).toBe('unreachable');
    expect(report.hasComposeFile).toBe(true);
    expect(report.findings).toEqual([]);
    vi.restoreAllMocks();
  });

  it('reports drifted with a parseError when the effective model cannot be rendered', async () => {
    stubDockerRender(null, 'invalid compose');

    const report = await buildStackDriftReport(0, 'app');
    expect(report.status).toBe('drifted');
    expect(report.hasComposeFile).toBe(false);
    expect(report.parseError).toContain('could not render');
    expect(report.findings).toEqual([]);
    vi.restoreAllMocks();
  });

  it('names missing required variables when render fails for unset interpolation', async () => {
    stubDockerRender(null, 'required variable REQ is missing a value: must be provided');

    const report = await buildStackDriftReport(0, 'app');
    expect(report.status).toBe('drifted');
    expect(report.parseError).toContain('REQ');
    expect(report.parseError).toContain('no value');
    vi.restoreAllMocks();
  });

  it('diffs a real snapshot into an image-mismatch finding', async () => {
    const snapshot: DependencySnapshot = {
      containers: [container({ id: 'c1', service: 'web', stack: 'app', image: 'nginx:1.24' })],
      networks: [],
      volumes: [],
    };
    stubDockerRender({ name: 'app', services: { web: { image: 'nginx:1.25' } } });
    stubFsAndSnapshot(snapshot);

    const report = await buildStackDriftReport(0, 'app');
    expect(report.status).toBe('drifted');
    expect(findingKinds(report)).toEqual(['image-mismatch']);
    vi.restoreAllMocks();
  });

  it('reports in-sync when render resolves a default image tag (#1572)', async () => {
    const image = 'ghcr.io/karakeep-app/karakeep:release';
    const snapshot: DependencySnapshot = {
      containers: [container({ id: 'c1', service: 'karakeep', stack: 'app', image })],
      networks: [],
      volumes: [],
    };
    stubDockerRender({ name: 'app', services: { karakeep: { image } } });
    stubFsAndSnapshot(snapshot);

    const report = await buildStackDriftReport(0, 'app');
    expect(report.status).toBe('in-sync');
    expect(report.findings).toEqual([]);
    vi.restoreAllMocks();
  });

  it('threads the snapshot networks through into a network-undeclared finding', async () => {
    const snapshot: DependencySnapshot = {
      containers: [container({ id: 'c1', service: 'web', stack: 'app', image: 'nginx:1.25', networks: [{ name: 'app_rogue', id: 'r', ip: '' }] })],
      networks: [depNet('app_rogue')],
      volumes: [],
    };
    stubDockerRender({
      name: 'app',
      services: { web: { image: 'nginx:1.25', networks: ['default'] } },
      networks: { default: { name: 'app_default' } },
    });
    stubFsAndSnapshot(snapshot);

    const report = await buildStackDriftReport(0, 'app');
    expect(findingKinds(report)).toContain('network-undeclared');
    vi.restoreAllMocks();
  });

  it('keeps the report available and Mesh drift actionable when opt-in authority fails', async () => {
    const snapshot: DependencySnapshot = {
      containers: [container({ id: 'c1', service: 'web', stack: 'app', image: 'nginx:1.25', networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      networks: [depNet('sencho_mesh', { composeProject: null, stack: null })],
      volumes: [],
    };
    stubDockerRender({ name: 'app', services: { web: { image: 'nginx:1.25' } } });
    stubFsAndSnapshot(snapshot);
    vi.spyOn(DatabaseService, 'getInstance').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await buildStackDriftReport(0, 'app');

    expect(report.status).toBe('drifted');
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: 'network-undeclared',
      actual: 'sencho_mesh',
    }));
    vi.restoreAllMocks();
  });

  it('reports in-sync through the public builder when DB authority opts the stack into Mesh', async () => {
    const snapshot: DependencySnapshot = {
      containers: [container({ id: 'c1', service: 'web', stack: 'app', image: 'nginx:1.25', networks: [{ name: 'sencho_mesh', id: 'm', ip: '' }] })],
      networks: [depNet('sencho_mesh', { composeProject: null, stack: null })],
      volumes: [],
    };
    stubDockerRender({ name: 'app', services: { web: { image: 'nginx:1.25' } } });
    stubFsAndSnapshot(snapshot);
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      isMeshStackEnabled: vi.fn().mockReturnValue(true),
    } as unknown as DatabaseService);

    const report = await buildStackDriftReport(0, 'app');

    expect(report.status).toBe('in-sync');
    expect(report.findings.filter(f => f.kind === 'network-undeclared')).toEqual([]);
    vi.restoreAllMocks();
  });
});

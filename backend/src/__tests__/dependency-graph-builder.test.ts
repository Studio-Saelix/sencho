/**
 * Unit tests for the dependency-map graph builder: runtime edge derivation,
 * the four anomaly flags (missing dependency, port conflict, orphan,
 * cross-stack shared), and fail-soft compose parsing.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  assembleGraph,
  detectPortConflicts,
  detectMissingDependencies,
  buildLocalGraph,
  type PortClaim,
} from '../services/DependencyGraphService';
import DockerController from '../services/DockerController';
import type {
  DependencySnapshot,
  DependencyContainer,
  DependencyNetwork,
  DependencyVolume,
} from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';
import type { DeclaredCompose } from '../helpers/composeDependencyParse';

// ── builders ────────────────────────────────────────────────────────────

const emptyDeclared = (): DeclaredCompose => ({ services: [], networks: {}, volumes: {} });

function snap(partial: Partial<DependencySnapshot>): DependencySnapshot {
  return { containers: [], networks: [], volumes: [], ...partial };
}

function container(p: Partial<DependencyContainer> & { id: string }): DependencyContainer {
  return {
    name: p.id, service: null, composeProject: null, stack: null,
    state: 'running', image: 'img:latest', networks: [], volumes: [], ports: [], ...p,
  };
}

function network(p: Partial<DependencyNetwork> & { name: string }): DependencyNetwork {
  return { id: p.name, driver: 'bridge', scope: 'local', isSystem: false, composeProject: null, stack: null, ...p };
}

function volume(p: Partial<DependencyVolume> & { name: string }): DependencyVolume {
  return { driver: 'local', composeProject: null, stack: null, ...p };
}

const declMap = (entries: [string, DeclaredCompose][]): Map<string, DeclaredCompose> => new Map(entries);

// ── assembleGraph: runtime edges + identity ──────────────────────────────

describe('assembleGraph - runtime structure', () => {
  it('emits host, stack, service nodes with compose service identity and runtime edges', () => {
    const snapshot = snap({
      containers: [
        container({
          id: 'c1', name: 'web-1', service: 'web', composeProject: 'web', stack: 'web',
          networks: [{ name: 'web_frontend', id: 'net1', ip: '172.18.0.2' }],
          volumes: ['web_data'],
          ports: [{ ip: '', publishedPort: 8080, privatePort: 80, protocol: 'tcp' }],
        }),
      ],
      networks: [network({ name: 'web_frontend', id: 'net1', composeProject: 'web', stack: 'web' })],
      volumes: [volume({ name: 'web_data', composeProject: 'web', stack: 'web' })],
    });

    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['web'], snapshot, declaredByStack: declMap([['web', emptyDeclared()]]), parseErrors: [] });

    expect(g.nodes.find((n) => n.kind === 'host')?.label).toBe('hub');
    const svc = g.nodes.find((n) => n.id === 'svc:web:web');
    expect(svc?.kind).toBe('service');
    expect(svc?.label).toBe('web');
    expect(g.nodes.some((n) => n.id === 'net:web_frontend')).toBe(true);
    expect(g.nodes.some((n) => n.id === 'vol:web_data')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'port' && n.id === 'port:*:8080/tcp')).toBe(true);

    const kinds = g.edges.map((e) => e.kind);
    expect(kinds).toContain('stack-node');
    expect(kinds).toContain('stack-service');
    expect(kinds).toContain('service-network');
    expect(kinds).toContain('service-volume');
    expect(kinds).toContain('service-port');
  });

  it('skips system networks (bridge/host/none)', () => {
    const snapshot = snap({
      containers: [container({ id: 'c1', service: 'app', stack: 'app', networks: [{ name: 'bridge', id: 'b', ip: '' }] })],
      networks: [network({ name: 'bridge', id: 'b', isSystem: true })],
    });
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['app'], snapshot, declaredByStack: declMap([['app', emptyDeclared()]]), parseErrors: [] });
    expect(g.nodes.some((n) => n.id === 'net:bridge')).toBe(false);
    expect(g.edges.some((e) => e.kind === 'service-network')).toBe(false);
  });

  it('passes compose parse errors through unchanged', () => {
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['web'], snapshot: snap({}), declaredByStack: declMap([['web', emptyDeclared()]]), parseErrors: [{ stack: 'web', error: 'bad yaml' }] });
    expect(g.parseErrors).toEqual([{ stack: 'web', error: 'bad yaml' }]);
  });

  it('returns only the host node for an empty node', () => {
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: [], snapshot: snap({}), declaredByStack: new Map(), parseErrors: [] });
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].kind).toBe('host');
    expect(g.flags).toHaveLength(0);
  });

  it('scales to a large stack without error', () => {
    const containers: DependencyContainer[] = [];
    for (let i = 0; i < 500; i++) {
      containers.push(container({ id: `c${i}`, service: `svc${i}`, stack: 'big' }));
    }
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['big'], snapshot: snap({ containers }), declaredByStack: declMap([['big', emptyDeclared()]]), parseErrors: [] });
    expect(g.nodes.filter((n) => n.kind === 'service')).toHaveLength(500);
  });
});

// ── assembleGraph: declared-only services + depends_on ───────────────────

describe('assembleGraph - declared services and depends_on', () => {
  it('adds declared-only service nodes (absent) with a depends-on edge and missing-dependency flag', () => {
    const snapshot = snap({
      containers: [container({ id: 'c1', service: 'web', stack: 'web' })],
    });
    const declared: DeclaredCompose = {
      services: [
        { name: 'web', dependsOn: ['db'], networks: [], volumes: [], ports: [] },
        { name: 'db', dependsOn: [], networks: [], volumes: [], ports: [] },
      ],
      networks: {}, volumes: {},
    };
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['web'], snapshot, declaredByStack: declMap([['web', declared]]), parseErrors: [] });

    const db = g.nodes.find((n) => n.id === 'svc:web:db');
    expect(db?.state).toBe('absent');
    expect(g.edges.some((e) => e.kind === 'depends-on' && e.declaredOnly && e.source === 'svc:web:web' && e.target === 'svc:web:db')).toBe(true);
    expect(g.flags.some((f) => f.kind === 'missing-dependency')).toBe(true);
    expect(g.nodes.find((n) => n.id === 'svc:web:web')?.flags).toContain('missing-dependency');
  });

  it('flags a depends_on target whose container is exited (not just absent)', () => {
    const snapshot = snap({
      containers: [
        container({ id: 'c1', service: 'web', stack: 'web', state: 'running' }),
        container({ id: 'c2', service: 'db', stack: 'web', state: 'exited' }),
      ],
    });
    const declared: DeclaredCompose = {
      services: [
        { name: 'web', dependsOn: ['db'], networks: [], volumes: [], ports: [] },
        { name: 'db', dependsOn: [], networks: [], volumes: [], ports: [] },
      ],
      networks: {}, volumes: {},
    };
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['web'], snapshot, declaredByStack: declMap([['web', declared]]), parseErrors: [] });
    expect(g.flags.some((f) => f.kind === 'missing-dependency')).toBe(true);
    expect(g.nodes.find((n) => n.id === 'svc:web:web')?.flags).toContain('missing-dependency');
  });

  it('does not flag internal dependencies of a fully stopped stack', () => {
    const snapshot = snap({
      containers: [
        container({ id: 'c1', service: 'web', stack: 'web', state: 'exited' }),
        container({ id: 'c2', service: 'db', stack: 'web', state: 'exited' }),
      ],
    });
    const declared: DeclaredCompose = {
      services: [
        { name: 'web', dependsOn: ['db'], networks: [], volumes: [], ports: [] },
        { name: 'db', dependsOn: [], networks: [], volumes: [], ports: [] },
      ],
      networks: {}, volumes: {},
    };
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['web'], snapshot, declaredByStack: declMap([['web', declared]]), parseErrors: [] });
    expect(g.flags.some((f) => f.kind === 'missing-dependency')).toBe(false);
  });
});

// ── assembleGraph: flags ─────────────────────────────────────────────────

describe('assembleGraph - flags', () => {
  it('flags a cross-stack shared network', () => {
    const snapshot = snap({
      containers: [
        container({ id: 'c1', service: 'a', stack: 'alpha', networks: [{ name: 'shared', id: 'sh', ip: '' }] }),
        container({ id: 'c2', service: 'b', stack: 'beta', networks: [{ name: 'shared', id: 'sh', ip: '' }] }),
      ],
      networks: [network({ name: 'shared', id: 'sh' })],
    });
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['alpha', 'beta'], snapshot, declaredByStack: declMap([['alpha', emptyDeclared()], ['beta', emptyDeclared()]]), parseErrors: [] });
    expect(g.nodes.find((n) => n.id === 'net:shared')?.flags).toContain('cross-stack-shared');
    expect(g.flags.some((f) => f.kind === 'cross-stack-shared')).toBe(true);
  });

  it('flags an orphaned (unmanaged, unreferenced) network and volume', () => {
    const snapshot = snap({
      networks: [network({ name: 'dangling_net', id: 'dn', stack: null })],
      volumes: [volume({ name: 'dangling_vol', stack: null })],
    });
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: [], snapshot, declaredByStack: new Map(), parseErrors: [] });
    expect(g.nodes.find((n) => n.id === 'net:dangling_net')?.flags).toContain('orphan');
    expect(g.nodes.find((n) => n.id === 'vol:dangling_vol')?.flags).toContain('orphan');
    expect(g.flags.filter((f) => f.kind === 'orphan')).toHaveLength(2);
  });

  it('does not flag a system network as orphan', () => {
    const snapshot = snap({ networks: [network({ name: 'bridge', id: 'b', isSystem: true })] });
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: [], snapshot, declaredByStack: new Map(), parseErrors: [] });
    expect(g.flags.some((f) => f.kind === 'orphan')).toBe(false);
  });

  it('represents an orphan container as a flagged synthetic stack', () => {
    const snapshot = snap({
      containers: [container({ id: 'c1', name: 'ghost-1', service: 'ghost', composeProject: 'ghoststack', stack: null })],
    });
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['web'], snapshot, declaredByStack: declMap([['web', emptyDeclared()]]), parseErrors: [] });
    const orphanStack = g.nodes.find((n) => n.id === 'stack:__orphan__:ghoststack');
    expect(orphanStack?.flags).toContain('orphan');
    expect(g.nodes.some((n) => n.id === 'svc:__orphan__:ghoststack:ghost')).toBe(true);
  });

  it('groups multiple orphan containers under their compose project', () => {
    const snapshot = snap({
      containers: [
        container({ id: 'c1', name: 'g-1', service: 'svcA', composeProject: 'ghost', stack: null }),
        container({ id: 'c2', name: 'g-2', service: 'svcB', composeProject: 'ghost', stack: null }),
        container({ id: 'c3', name: 'h-1', service: 'svcC', composeProject: 'other', stack: null }),
      ],
    });
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: [], snapshot, declaredByStack: new Map(), parseErrors: [] });
    expect(g.nodes.filter((n) => n.id.startsWith('stack:__orphan__:')).length).toBe(2);
    expect(g.nodes.filter((n) => n.id.startsWith('svc:__orphan__:ghost:')).length).toBe(2);
  });

  it('attaches the port-conflict flag to the port node and the claiming services', () => {
    const snapshot = snap({
      containers: [
        container({ id: 'c1', service: 'a', stack: 'alpha', ports: [{ ip: '', publishedPort: 8080, privatePort: 80, protocol: 'tcp' }] }),
        container({ id: 'c2', service: 'b', stack: 'beta', ports: [{ ip: '', publishedPort: 8080, privatePort: 80, protocol: 'tcp' }] }),
      ],
    });
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['alpha', 'beta'], snapshot, declaredByStack: declMap([['alpha', emptyDeclared()], ['beta', emptyDeclared()]]), parseErrors: [] });
    expect(g.nodes.find((n) => n.id === 'port:*:8080/tcp')?.flags).toContain('port-conflict');
    expect(g.nodes.find((n) => n.id === 'svc:alpha:a')?.flags).toContain('port-conflict');
    const flag = g.flags.find((f) => f.kind === 'port-conflict');
    expect(flag?.subjects).toContain('port:*:8080/tcp');
  });

  it('flags a declared volume that does not exist at runtime', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: [], networks: [], volumes: ['data'], ports: [] }], networks: {}, volumes: { data: { external: false } } };
    const snapshot = snap({ containers: [container({ id: 'c1', service: 'web', stack: 'web' })] });
    const g = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['web'], snapshot, declaredByStack: declMap([['web', declared]]), parseErrors: [] });
    const missing = g.flags.filter((f) => f.kind === 'missing-dependency');
    expect(missing.length).toBe(1);
    expect(g.nodes.find((n) => n.id === 'svc:web:web')?.flags).toContain('missing-dependency');
  });
});

// ── detectPortConflicts ──────────────────────────────────────────────────

describe('detectPortConflicts', () => {
  const claim = (p: Partial<PortClaim>): PortClaim => ({ stack: 's', service: 'svc', hostIp: '', publishedPort: 80, protocol: 'tcp', ...p });

  it('flags two stacks claiming the same host port', () => {
    const conflicts = detectPortConflicts([claim({ stack: 'a', publishedPort: 8080 }), claim({ stack: 'b', publishedPort: 8080 })]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].port).toBe(8080);
    expect(conflicts[0].protocol).toBe('tcp');
  });

  it('flags only the clashing specific-IP claimants, not an unrelated bind on the same port', () => {
    const conflicts = detectPortConflicts([
      claim({ stack: 'a', service: 'x', hostIp: '10.0.0.1', publishedPort: 443 }),
      claim({ stack: 'b', service: 'y', hostIp: '10.0.0.1', publishedPort: 443 }),
      claim({ stack: 'c', service: 'z', hostIp: '10.0.0.2', publishedPort: 443 }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].scopes).toEqual(['10.0.0.1']);
    const stacks = conflicts[0].claimants.map((c) => c.stack).sort();
    expect(stacks).toEqual(['a', 'b']);
  });

  it('does not flag IPv4 + IPv6 bindings of one service publish', () => {
    const conflicts = detectPortConflicts([
      claim({ stack: 'a', service: 'x', hostIp: '0.0.0.0', publishedPort: 8080 }),
      claim({ stack: 'a', service: 'x', hostIp: '::', publishedPort: 8080 }),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it('flags two services in the same stack claiming the same port', () => {
    const conflicts = detectPortConflicts([claim({ stack: 'a', service: 'x', publishedPort: 9000 }), claim({ stack: 'a', service: 'y', publishedPort: 9000 })]);
    expect(conflicts).toHaveLength(1);
  });

  it('does not flag tcp vs udp on the same port', () => {
    const conflicts = detectPortConflicts([claim({ stack: 'a', publishedPort: 53, protocol: 'tcp' }), claim({ stack: 'b', publishedPort: 53, protocol: 'udp' })]);
    expect(conflicts).toHaveLength(0);
  });

  it('does not flag the same port bound to different specific host IPs', () => {
    const conflicts = detectPortConflicts([claim({ stack: 'a', hostIp: '10.0.0.1', publishedPort: 443 }), claim({ stack: 'b', hostIp: '10.0.0.2', publishedPort: 443 })]);
    expect(conflicts).toHaveLength(0);
  });

  it('flags the same port bound to the same specific host IP', () => {
    const conflicts = detectPortConflicts([claim({ stack: 'a', hostIp: '10.0.0.1', publishedPort: 443 }), claim({ stack: 'b', hostIp: '10.0.0.1', publishedPort: 443 })]);
    expect(conflicts).toHaveLength(1);
  });

  it('flags a wildcard bind clashing with a specific-IP bind', () => {
    const conflicts = detectPortConflicts([claim({ stack: 'a', hostIp: '', publishedPort: 443 }), claim({ stack: 'b', hostIp: '10.0.0.2', publishedPort: 443 })]);
    expect(conflicts).toHaveLength(1);
  });

  it('does not flag a single claimant', () => {
    expect(detectPortConflicts([claim({ publishedPort: 80 })])).toHaveLength(0);
  });
});

// ── detectMissingDependencies ────────────────────────────────────────────

describe('detectMissingDependencies', () => {
  const base = (declared: DeclaredCompose, over: Partial<Parameters<typeof detectMissingDependencies>[0]> = {}) => ({
    stack: 'web', declared, runningServices: new Set<string>(['web']), hasContainers: true,
    stackNetworkNames: ['web_frontend'], stackVolumeNames: ['web_data'],
    allNetworkNames: new Set(['web_frontend']), allVolumeNames: new Set(['web_data']), ...over,
  });

  it('returns nothing for a stack with no containers', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: ['db'], networks: [], volumes: [], ports: [] }], networks: {}, volumes: {} };
    expect(detectMissingDependencies(base(declared, { hasContainers: false }))).toHaveLength(0);
  });

  it('flags a depends_on target that is not running', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: ['db'], networks: [], volumes: [], ports: [] }], networks: {}, volumes: {} };
    const out = detectMissingDependencies(base(declared));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('service');
    expect(out[0].target).toBe('db');
  });

  it('does not flag an external network that exists on the host', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: [], networks: ['proxy'], volumes: [], ports: [] }], networks: { proxy: { external: true } }, volumes: {} };
    expect(detectMissingDependencies(base(declared, { allNetworkNames: new Set(['proxy']) }))).toHaveLength(0);
  });

  it('flags an external network that does not exist on the host', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: [], networks: ['proxy'], volumes: [], ports: [] }], networks: { proxy: { external: true } }, volumes: {} };
    const out = detectMissingDependencies(base(declared, { allNetworkNames: new Set() }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('network');
  });

  it('does not flag a network present via the project-prefix suffix match', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: [], networks: ['frontend'], volumes: [], ports: [] }], networks: { frontend: { external: false } }, volumes: {} };
    expect(detectMissingDependencies(base(declared))).toHaveLength(0);
  });

  it('matches a network by its explicit name: override', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: [], networks: ['proxy'], volumes: [], ports: [] }], networks: { proxy: { name: 'shared_net', external: false } }, volumes: {} };
    expect(detectMissingDependencies(base(declared, { stackNetworkNames: [], allNetworkNames: new Set(['shared_net']) }))).toHaveLength(0);
  });

  it('flags a name:-override network that is absent at runtime', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: [], networks: ['proxy'], volumes: [], ports: [] }], networks: { proxy: { name: 'shared_net', external: false } }, volumes: {} };
    const out = detectMissingDependencies(base(declared, { stackNetworkNames: [], allNetworkNames: new Set() }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('network');
  });

  it('flags a declared network that does not exist at runtime', () => {
    const declared: DeclaredCompose = { services: [{ name: 'web', dependsOn: [], networks: ['backend'], volumes: [], ports: [] }], networks: { backend: { external: false } }, volumes: {} };
    const out = detectMissingDependencies(base(declared));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('network');
  });
});

// ── buildLocalGraph: fail-soft orchestration (mocked) ────────────────────

describe('buildLocalGraph - fail-soft', () => {
  it('records a parse error for an unreadable stack and still builds the rest', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue(snap({})),
    } as unknown as DockerController);
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
      getStacks: vi.fn().mockResolvedValue(['web', 'broken']),
      getStackContent: vi.fn().mockImplementation(async (s: string) => {
        if (s === 'broken') throw new Error('EISDIR');
        return 'services:\n  web:\n    image: nginx';
      }),
    } as unknown as FileSystemService);

    const g = await buildLocalGraph(1, 'hub');
    expect(g.parseErrors.some((p) => p.stack === 'broken')).toBe(true);
    expect(g.nodes.some((n) => n.id === 'stack:web')).toBe(true);
    vi.restoreAllMocks();
  });
});

/**
 * The preflight rule registry. Each rule is a pure function over a
 * PreflightContext; these tests assert each fires on its positive case, stays
 * silent otherwise, and carries the right severity. They also pin the port
 * conflict semantics (protocol, interface overlap, same-stack, ranges) and keep
 * the registry aligned with the documented rule set.
 */
import { describe, it, expect } from 'vitest';
import { runRules, RULE_IDS } from '../services/preflight/rules';
import type { EffService, EffectiveModel } from '../services/preflight/effectiveModel';
import type { PreflightContext, PreflightFinding } from '../services/preflight/types';

function svc(over: Partial<EffService> = {}): EffService {
  return {
    name: 'web', image: 'nginx:1.27', ports: [], binds: [], namedVolumes: [],
    privileged: false, hasHealthcheck: true, restart: 'unless-stopped', envKeys: [], ...over,
  };
}

function model(services: EffService[], over: Partial<EffectiveModel> = {}): EffectiveModel {
  return { projectName: 'proj', services, networks: {}, volumes: {}, ...over };
}

function ctx(over: Partial<PreflightContext> = {}): PreflightContext {
  const m = over.model !== undefined ? over.model : model([]);
  return {
    stackName: 'proj', platform: 'linux', model: m, renderable: true, renderError: null, unsetEnvVars: [],
    sourceServiceNames: m ? m.services.map(s => s.name) : [], sourceReadable: true,
    nodePorts: [], existingNetworkNames: new Set(), existingVolumeNames: new Set(),
    existingContainers: [], bindChecks: [], ...over,
  };
}

const ids = (findings: PreflightFinding[], ruleId: string) => findings.filter(f => f.ruleId === ruleId);

describe('render-failed', () => {
  it('fires only when the model is unrenderable', () => {
    const f = runRules(ctx({ renderable: false, model: null, renderError: 'boom' }));
    expect(ids(f, 'render-failed')).toHaveLength(1);
    expect(ids(f, 'render-failed')[0].severity).toBe('blocker');
    expect(ids(f, 'render-failed')[0].message).toContain('boom');
  });
  it('stays silent and runs model rules when renderable', () => {
    expect(ids(runRules(ctx({ model: model([svc()]) })), 'render-failed')).toHaveLength(0);
  });
});

describe('env-unset', () => {
  it('emits one high finding per unset variable name', () => {
    const f = ids(runRules(ctx({ unsetEnvVars: ['FOO', 'BAR'] })), 'env-unset');
    expect(f).toHaveLength(2);
    expect(f[0].severity).toBe('high');
    expect(f.map(x => x.sourcePath)).toEqual(['FOO', 'BAR']);
  });
});

describe('port-conflict-node', () => {
  const withPort = (proto = 'tcp', hostIp = '') => model([svc({ ports: [{ startPort: 8080, endPort: 8080, hostIp, protocol: proto }] })]);

  it('blocks a port held by a different stack', () => {
    const f = runRules(ctx({ model: withPort(), nodePorts: [{ publishedPort: 8080, protocol: 'tcp', ip: '', stack: 'other' }] }));
    expect(ids(f, 'port-conflict-node')).toHaveLength(1);
    expect(ids(f, 'port-conflict-node')[0].severity).toBe('blocker');
  });
  it('ignores the same stack reusing its own port', () => {
    const f = runRules(ctx({ stackName: 'proj', model: withPort(), nodePorts: [{ publishedPort: 8080, protocol: 'tcp', ip: '', stack: 'proj' }] }));
    expect(ids(f, 'port-conflict-node')).toHaveLength(0);
  });
  it('does not conflict TCP with UDP on the same number', () => {
    const f = runRules(ctx({ model: withPort('tcp'), nodePorts: [{ publishedPort: 8080, protocol: 'udp', ip: '', stack: 'other' }] }));
    expect(ids(f, 'port-conflict-node')).toHaveLength(0);
  });
  it('treats a loopback bind as overlapping an all-interfaces bind', () => {
    const f = runRules(ctx({ model: withPort('tcp', '127.0.0.1'), nodePorts: [{ publishedPort: 8080, protocol: 'tcp', ip: '', stack: 'other' }] }));
    expect(ids(f, 'port-conflict-node')).toHaveLength(1);
  });
  it('catches a port inside a published range', () => {
    const m = model([svc({ ports: [{ startPort: 9000, endPort: 9002, hostIp: '', protocol: 'tcp' }] })]);
    const f = runRules(ctx({ model: m, nodePorts: [{ publishedPort: 9001, protocol: 'tcp', ip: '', stack: 'other' }] }));
    expect(ids(f, 'port-conflict-node')).toHaveLength(1);
  });
});

describe('port-conflict-internal', () => {
  it('blocks two services publishing the same host port', () => {
    const m = model([
      svc({ name: 'a', ports: [{ startPort: 80, endPort: 80, hostIp: '', protocol: 'tcp' }] }),
      svc({ name: 'b', ports: [{ startPort: 80, endPort: 80, hostIp: '', protocol: 'tcp' }] }),
    ]);
    expect(ids(runRules(ctx({ model: m })), 'port-conflict-internal')).toHaveLength(1);
  });
  it('allows the same number on different interfaces', () => {
    const m = model([
      svc({ name: 'a', ports: [{ startPort: 80, endPort: 80, hostIp: '127.0.0.1', protocol: 'tcp' }] }),
      svc({ name: 'b', ports: [{ startPort: 80, endPort: 80, hostIp: '192.168.1.5', protocol: 'tcp' }] }),
    ]);
    expect(ids(runRules(ctx({ model: m })), 'port-conflict-internal')).toHaveLength(0);
  });
});

describe('port-exposed-all-interfaces', () => {
  it('flags an all-interfaces bind but not a loopback bind', () => {
    const open = model([svc({ ports: [{ startPort: 80, endPort: 80, hostIp: '', protocol: 'tcp' }] })]);
    const local = model([svc({ ports: [{ startPort: 80, endPort: 80, hostIp: '127.0.0.1', protocol: 'tcp' }] })]);
    expect(ids(runRules(ctx({ model: open })), 'port-exposed-all-interfaces')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: local })), 'port-exposed-all-interfaces')).toHaveLength(0);
  });
  it('treats :: (IPv6 all-interfaces) as exposed and overlapping', () => {
    const v6 = model([svc({ ports: [{ startPort: 80, endPort: 80, hostIp: '::', protocol: 'tcp' }] })]);
    expect(ids(runRules(ctx({ model: v6 })), 'port-exposed-all-interfaces')).toHaveLength(1);
    const f = runRules(ctx({ model: v6, nodePorts: [{ publishedPort: 80, protocol: 'tcp', ip: '127.0.0.1', stack: 'other' }] }));
    expect(ids(f, 'port-conflict-node')).toHaveLength(1);
  });
});

describe('bind-path-missing / bind-path-permission', () => {
  it('flags a missing within-base bind as high', () => {
    const f = runRules(ctx({ bindChecks: [{ service: 'web', source: '/base/proj/data', target: '/data', withinBase: true, exists: false, ownerUid: null }] }));
    expect(ids(f, 'bind-path-missing')).toHaveLength(1);
    expect(ids(f, 'bind-path-missing')[0].severity).toBe('high');
  });
  it('does not assert an absolute (outside-base) bind as missing', () => {
    const f = runRules(ctx({ bindChecks: [{ service: 'web', source: '/mnt/media', target: '/media', withinBase: false, exists: false, ownerUid: null }] }));
    expect(ids(f, 'bind-path-missing')).toHaveLength(0);
  });
  it('warns on a root-owned within-base bind when the service drops privileges', () => {
    const m = model([svc({ envKeys: ['PUID'] })]);
    const bind = { service: 'web', source: '/base/proj/data', target: '/data', withinBase: true, exists: true, ownerUid: 0 };
    expect(ids(runRules(ctx({ model: m, bindChecks: [bind] })), 'bind-path-permission')).toHaveLength(1);
  });
  it('skips the ownership heuristic on Windows', () => {
    const m = model([svc({ envKeys: ['PUID'] })]);
    const bind = { service: 'web', source: 'C:/base/proj/data', target: '/data', withinBase: true, exists: true, ownerUid: 0 };
    expect(ids(runRules(ctx({ platform: 'win32', model: m, bindChecks: [bind] })), 'bind-path-permission')).toHaveLength(0);
  });
});

describe('security rules', () => {
  it('flags a docker socket mount', () => {
    const m = model([svc({ binds: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] })]);
    expect(ids(runRules(ctx({ model: m })), 'docker-socket-mount')[0].severity).toBe('high');
  });
  it('flags privileged and host networking', () => {
    expect(ids(runRules(ctx({ model: model([svc({ privileged: true })]) })), 'privileged')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: model([svc({ networkMode: 'host' })]) })), 'network-mode-host')).toHaveLength(1);
  });
});

describe('uid-gid-risk', () => {
  it('fires only for unverifiable (outside-base) binds', () => {
    const m = model([svc({ name: 'web', envKeys: ['PUID'] })]);
    const outside = [{ service: 'web', source: '/mnt/x', target: '/x', withinBase: false, exists: false, ownerUid: null }];
    const inside = [{ service: 'web', source: '/base/proj/x', target: '/x', withinBase: true, exists: true, ownerUid: 1000 }];
    expect(ids(runRules(ctx({ model: m, bindChecks: outside })), 'uid-gid-risk')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: m, bindChecks: inside })), 'uid-gid-risk')).toHaveLength(0);
  });
});

describe('hygiene rules', () => {
  it('flags a moving image tag but not a pinned one', () => {
    expect(ids(runRules(ctx({ model: model([svc({ image: 'nginx:latest' })]) })), 'image-latest')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: model([svc({ image: 'nginx' })]) })), 'image-latest')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: model([svc({ image: 'nginx:1.27' })]) })), 'image-latest')).toHaveLength(0);
    expect(ids(runRules(ctx({ model: model([svc({ image: 'nginx@sha256:abc' })]) })), 'image-latest')).toHaveLength(0);
  });
  it('flags a missing restart policy and healthcheck', () => {
    const bare = model([svc({ restart: undefined, hasHealthcheck: false })]);
    expect(ids(runRules(ctx({ model: bare })), 'no-restart-policy')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: bare })), 'no-healthcheck')).toHaveLength(1);
    const withDeployRestart = model([svc({ restart: undefined, deploy: { restart_policy: { condition: 'any' } }})]);
    expect(ids(runRules(ctx({ model: withDeployRestart })), 'no-restart-policy')).toHaveLength(0);
  });
  it('flags swarm-only deploy fields but not honored ones', () => {
    expect(ids(runRules(ctx({ model: model([svc({ deploy: { placement: {} }})]) })), 'deploy-swarm-only')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: model([svc({ deploy: { replicas: 3 }})]) })), 'deploy-swarm-only')).toHaveLength(0);
  });
});

describe('network / volume rules', () => {
  it('blocks a missing external network and volume', () => {
    const m = model([svc()], { networks: { ext: { name: 'shared', external: true } }, volumes: { v: { name: 'data', external: true } } });
    const f = runRules(ctx({ model: m }));
    expect(ids(f, 'external-network-missing')).toHaveLength(1);
    expect(ids(f, 'external-volume-missing')).toHaveLength(1);
  });
  it('does not block an external resource that exists', () => {
    const m = model([svc()], { networks: { ext: { name: 'shared', external: true } } });
    const f = runRules(ctx({ model: m, existingNetworkNames: new Set(['shared']) }));
    expect(ids(f, 'external-network-missing')).toHaveLength(0);
  });
  it('reports a new network/volume as info when absent on the node', () => {
    const m = model([svc()], { networks: { backend: { name: 'backend', external: false } }, volumes: { data: { name: 'data', external: false } } });
    const f = runRules(ctx({ model: m }));
    expect(ids(f, 'new-network')[0].severity).toBe('info');
    expect(ids(f, 'new-volume')[0].message).toContain('proj_data');
  });
});

describe('container_name rules', () => {
  it('blocks a duplicate container_name within the stack', () => {
    const m = model([svc({ name: 'a', containerName: 'dup' }), svc({ name: 'b', containerName: 'dup' })]);
    expect(ids(runRules(ctx({ model: m })), 'container-name-internal-dup')[0].severity).toBe('blocker');
  });
  it('blocks a container_name owned by a different stack', () => {
    const m = model([svc({ containerName: 'taken' })]);
    const f = runRules(ctx({ model: m, existingContainers: [{ name: 'taken', stack: 'other' }] }));
    expect(ids(f, 'container-name-collision')[0].severity).toBe('blocker');
  });
  it('does not flag a container_name owned by the same stack', () => {
    const m = model([svc({ containerName: 'mine' })]);
    const f = runRules(ctx({ stackName: 'proj', model: m, existingContainers: [{ name: 'mine', stack: 'proj' }] }));
    expect(ids(f, 'container-name-collision')).toHaveLength(0);
  });
});

describe('effective-model-expanded', () => {
  it('flags services present in the rendered model but not the source', () => {
    const m = model([svc({ name: 'web' }), svc({ name: 'sidecar' })]);
    const f = runRules(ctx({ model: m, sourceServiceNames: ['web'] }));
    expect(ids(f, 'effective-model-expanded')).toHaveLength(1);
    expect(ids(f, 'effective-model-expanded')[0].message).toContain('sidecar');
  });
  it('stays silent when source and effective services match', () => {
    const m = model([svc({ name: 'web' })]);
    expect(ids(runRules(ctx({ model: m, sourceServiceNames: ['web'] })), 'effective-model-expanded')).toHaveLength(0);
  });
  it('stays silent when the source could not be read (empty != zero services)', () => {
    const m = model([svc({ name: 'web' }), svc({ name: 'sidecar' })]);
    const f = runRules(ctx({ model: m, sourceServiceNames: [], sourceReadable: false }));
    expect(ids(f, 'effective-model-expanded')).toHaveLength(0);
  });
});

describe('rule registry completeness', () => {
  // The canonical rule set. Adding or removing a rule must update this list,
  // which forces a deliberate pass over the docs and the frontend severity map.
  const EXPECTED_RULE_IDS = [
    'render-failed', 'env-unset', 'port-conflict-node', 'port-conflict-internal', 'port-exposed-all-interfaces',
    'bind-path-missing', 'bind-path-permission', 'docker-socket-mount', 'privileged', 'network-mode-host',
    'uid-gid-risk', 'image-latest', 'no-restart-policy', 'no-healthcheck', 'deploy-swarm-only',
    'external-network-missing', 'external-volume-missing', 'new-network', 'new-volume',
    'container-name-internal-dup', 'container-name-collision', 'effective-model-expanded',
  ];
  it('the registry contains exactly the expected rules', () => {
    expect([...RULE_IDS].sort()).toEqual([...EXPECTED_RULE_IDS].sort());
  });
});

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
  const hasHealthcheck = over.hasHealthcheck ?? true;
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

function model(services: EffService[], over: Partial<EffectiveModel> = {}): EffectiveModel {
  return { projectName: 'proj', services, networks: {}, volumes: {}, ...over };
}

function ctx(over: Partial<PreflightContext> = {}): PreflightContext {
  const m = over.model !== undefined ? over.model : model([]);
  return {
    stackName: 'proj', platform: 'linux', model: m, renderable: true, renderError: null, unsetEnvVars: [],
    literalDollarWarnings: [],
    missingEnvFiles: [],
    sourceServiceNames: m ? m.services.map(s => s.name) : [], sourceReadable: true,
    nodePorts: [], existingNetworkNames: new Set(), existingVolumeNames: new Set(),
    existingContainers: [], nodeStateAvailable: true, bindChecks: [],
    stackIntent: null, serviceIntents: {}, accessUrlPorts: new Set(), hasAccessUrls: false,
    exposureAvailable: true,
    isSelfStack: false,
    healthchecks: {},
    ...over,
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
  it('mentions literal-dollar escapes in remediation', () => {
    const f = ids(runRules(ctx({ unsetEnvVars: ['FOO'] })), 'env-unset');
    expect(f[0].remediation).toContain('$$');
    expect(f[0].remediation).toContain('single-quote');
  });
});

describe('env-literal-dollar', () => {
  it('emits a safe finding for likely-secret literal dollar warnings', () => {
    const f = ids(runRules(ctx({
      literalDollarWarnings: [{ envKey: 'EXAMPLE_AUTH_HASH', likelySecret: true, service: 'demo' }],
    })), 'env-literal-dollar');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('high');
    expect(f[0].title).toContain('likely secret');
    expect(f[0].sourcePath).toBe('EXAMPLE_AUTH_HASH');
    expect(f[0].service).toBe('demo');
    expect(f[0].title).not.toContain('E6SDEbshpc');
    expect(f[0].remediation).toContain('$$');
  });
  it('omits fragment names from generic literal-dollar findings', () => {
    const f = ids(runRules(ctx({
      literalDollarWarnings: [{ likelySecret: false }],
    })), 'env-literal-dollar');
    expect(f).toHaveLength(1);
    expect(f[0].sourcePath).toBeUndefined();
    expect(f[0].title).toContain('environment value');
  });
});

describe('env-file-missing', () => {
  it('emits one high finding per missing required env file', () => {
    const f = ids(runRules(ctx({ missingEnvFiles: [{ rawPath: './db.env', services: ['db'] }] })), 'env-file-missing');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('high');
    expect(f[0].sourcePath).toBe('./db.env');
    expect(f[0].service).toBe('db');
  });
  it('stays silent when there are no missing env files (optional/unverifiable are pre-filtered)', () => {
    expect(ids(runRules(ctx({ missingEnvFiles: [] })), 'env-file-missing')).toHaveLength(0);
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
  const sockBind = { source: '/var/run/docker.sock', target: '/var/run/docker.sock' };
  const sockRo = { type: 'bind' as const, source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: true };
  const sockRw = { type: 'bind' as const, source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false };
  const internalNet = { app_internal: { name: 'proj_app_internal', external: false, internal: true } };
  const publicNet = { lan: { name: 'proj_lan', external: false, internal: false } };

  it('flags a direct docker socket mount as high', () => {
    const m = model([svc({ binds: [sockBind], storageMounts: [sockRw] })]);
    const f = ids(runRules(ctx({ model: m })), 'docker-socket-mount');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('high');
    expect(f[0].remediation).toMatch(/scoped socket proxy/i);
    expect(ids(runRules(ctx({ model: m })), 'docker-socket-proxy')).toHaveLength(0);
  });

  it('classifies known proxy images as info, not high', () => {
    const m = model([svc({
      name: 'proxy',
      image: 'lscr.io/linuxserver/socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      networks: [{ key: 'app_internal', aliases: [] }],
    })], { networks: internalNet });
    expect(ids(runRules(ctx({ model: m })), 'docker-socket-mount')).toHaveLength(0);
    const f = ids(runRules(ctx({ model: m })), 'docker-socket-proxy');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('info');
  });

  it('classifies tecnativa image and corroborated name-hint proxies', () => {
    const byImage = model([svc({
      name: 'api', image: 'tecnativa/docker-socket-proxy:latest', binds: [sockBind], storageMounts: [sockRw],
    })]);
    expect(ids(runRules(ctx({ model: byImage })), 'docker-socket-proxy')).toHaveLength(1);
    const byNameAndReadOnly = model([svc({
      name: 'docker-socket-proxy', image: 'custom/proxy:1', binds: [sockBind], storageMounts: [sockRo],
    })]);
    expect(ids(runRules(ctx({ model: byNameAndReadOnly })), 'docker-socket-proxy')).toHaveLength(1);
    const byNameAndApiKey = model([svc({
      name: 'docker-socket-proxy', image: 'custom/proxy:1', binds: [sockBind], storageMounts: [sockRw],
      envKeys: ['CONTAINERS'],
    })]);
    expect(ids(runRules(ctx({ model: byNameAndApiKey })), 'docker-socket-proxy')).toHaveLength(1);
  });

  it('does not let a service name alone downgrade a writable socket mount', () => {
    // The name is free text the author controls; without a read-only socket or
    // a scoped API group key there is nothing observable to corroborate it.
    const nameOnly = model([svc({
      name: 'docker-socket-proxy', image: 'custom/proxy:1', binds: [sockBind], storageMounts: [sockRw],
    })]);
    expect(ids(runRules(ctx({ model: nameOnly })), 'docker-socket-proxy')).toHaveLength(0);
    expect(ids(runRules(ctx({ model: nameOnly })), 'docker-socket-mount')[0].severity).toBe('high');
  });

  it('classifies unknown RO socket plus two API keys as proxy; RW stays high', () => {
    const keys = ['CONTAINERS', 'IMAGES'];
    const ro = model([svc({
      name: 'mystery', image: 'custom:1', binds: [sockBind], storageMounts: [sockRo], envKeys: keys,
    })]);
    expect(ids(runRules(ctx({ model: ro })), 'docker-socket-proxy')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: ro })), 'docker-socket-mount')).toHaveLength(0);
    const rw = model([svc({
      name: 'mystery', image: 'custom:1', binds: [sockBind], storageMounts: [sockRw], envKeys: keys,
    })]);
    expect(ids(runRules(ctx({ model: rw })), 'docker-socket-mount')[0].severity).toBe('high');
    expect(ids(runRules(ctx({ model: rw })), 'docker-socket-proxy')).toHaveLength(0);
  });

  it('does not downgrade on a single API key or Portainer', () => {
    const oneKey = model([svc({
      binds: [sockBind], storageMounts: [sockRo], envKeys: ['CONTAINERS'],
    })]);
    expect(ids(runRules(ctx({ model: oneKey })), 'docker-socket-mount')).toHaveLength(1);
    const portainer = model([svc({
      name: 'portainer', image: 'portainer/portainer-ce:latest', binds: [sockBind], storageMounts: [sockRw],
    })]);
    expect(ids(runRules(ctx({ model: portainer })), 'docker-socket-mount')).toHaveLength(1);
  });

  it('matches docker.sock on source-only or target-only binds', () => {
    const sourceOnly = model([svc({
      binds: [{ source: '/var/run/docker.sock', target: '/run/docker.sock' }],
      storageMounts: [{ type: 'bind', source: '/var/run/docker.sock', target: '/run/docker.sock', readOnly: false }],
    })]);
    expect(ids(runRules(ctx({ model: sourceOnly })), 'docker-socket-mount')).toHaveLength(1);
    const targetOnly = model([svc({
      binds: [{ source: '/host/custom', target: '/var/run/docker.sock' }],
      storageMounts: [{ type: 'bind', source: '/host/custom', target: '/var/run/docker.sock', readOnly: false }],
    })]);
    expect(ids(runRules(ctx({ model: targetOnly })), 'docker-socket-mount')).toHaveLength(1);
  });

  it('warns when a proxy publishes any host port', () => {
    const m = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      ports: [{ startPort: 2375, endPort: 2375, hostIp: '', protocol: 'tcp' }],
      networks: [{ key: 'app_internal', aliases: [] }],
    })], { networks: internalNet });
    expect(ids(runRules(ctx({ model: m })), 'docker-socket-proxy-published')[0].severity).toBe('high');
    const remapped = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      ports: [{ startPort: 12375, endPort: 12375, hostIp: '127.0.0.1', protocol: 'tcp' }],
    })]);
    expect(ids(runRules(ctx({ model: remapped })), 'docker-socket-proxy-published')).toHaveLength(1);
    const none = model([svc({
      name: 'proxy', image: 'tecnativa/docker-socket-proxy:latest', binds: [sockBind], storageMounts: [sockRo],
    })]);
    expect(ids(runRules(ctx({ model: none })), 'docker-socket-proxy-published')).toHaveLength(0);
  });

  it('warns on enabled POST/DELETE flags only', () => {
    const mutating = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      enabledProxyApiFlags: ['POST', 'DELETE', 'CONTAINERS'],
    })]);
    const f = ids(runRules(ctx({ model: mutating })), 'docker-socket-proxy-mutating');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warning');
    expect(f[0].message).toMatch(/POST and DELETE/);
    const safe = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      enabledProxyApiFlags: ['CONTAINERS'],
      envKeys: ['POST', 'DELETE', 'CONTAINERS'],
    })]);
    expect(ids(runRules(ctx({ model: safe })), 'docker-socket-proxy-mutating')).toHaveLength(0);
  });

  it('warns when a proxy attaches to any non-internal network, including mixed', () => {
    const internalOnly = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      networks: [{ key: 'app_internal', aliases: [] }],
    })], { networks: internalNet });
    expect(ids(runRules(ctx({ model: internalOnly })), 'docker-socket-proxy-exposure')).toHaveLength(0);

    const mixed = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      networks: [{ key: 'app_internal', aliases: [] }, { key: 'lan', aliases: [] }],
    })], { networks: { ...internalNet, ...publicNet } });
    expect(ids(runRules(ctx({ model: mixed })), 'docker-socket-proxy-exposure')).toHaveLength(1);

    // A network the model cannot show to be internal, and the implicit default
    // network, both count as non-internal.
    const missingMeta = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      networks: [{ key: 'undeclared', aliases: [] }],
    })]);
    expect(ids(runRules(ctx({ model: missingMeta })), 'docker-socket-proxy-exposure')).toHaveLength(1);

    const implicitDefault = model([svc({
      name: 'proxy', image: 'tecnativa/docker-socket-proxy:latest', binds: [sockBind], storageMounts: [sockRo],
    })]);
    expect(ids(runRules(ctx({ model: implicitDefault })), 'docker-socket-proxy-exposure')).toHaveLength(1);
  });

  it('flags a classified proxy that mounts the socket read-write as high', () => {
    const rw = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRw],
      networks: [{ key: 'app_internal', aliases: [] }],
    })], { networks: internalNet });
    const f = ids(runRules(ctx({ model: rw })), 'docker-socket-proxy-writable');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('high');
    // A name-hint match corroborated by an API group key cannot silence it either.
    const byName = model([svc({
      name: 'my-socket-proxy', image: 'custom:1', binds: [sockBind], storageMounts: [sockRw],
      envKeys: ['CONTAINERS'],
    })]);
    expect(ids(runRules(ctx({ model: byName })), 'docker-socket-proxy-writable')[0].severity).toBe('high');
    const ro = model([svc({
      name: 'proxy', image: 'tecnativa/docker-socket-proxy:latest', binds: [sockBind], storageMounts: [sockRo],
    })]);
    expect(ids(runRules(ctx({ model: ro })), 'docker-socket-proxy-writable')).toHaveLength(0);
    // A second, writable socket mount is not made safe by the read-only one.
    const both = model([svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo, { type: 'bind', source: '/var/run/docker.sock', target: '/tmp/docker.sock', readOnly: false }],
    })]);
    expect(ids(runRules(ctx({ model: both })), 'docker-socket-proxy-writable')).toHaveLength(1);
  });

  it('matches underscore and dot separated proxy names', () => {
    const underscore = model([svc({
      name: 'docker_socket_proxy', image: 'custom/proxy:1', binds: [sockBind], storageMounts: [sockRo],
    })]);
    expect(ids(runRules(ctx({ model: underscore })), 'docker-socket-proxy')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: underscore })), 'docker-socket-mount')).toHaveLength(0);
  });

  it('points a direct mount at the proxy the stack already runs', () => {
    const m = model([
      svc({
        name: 'proxy',
        image: 'tecnativa/docker-socket-proxy:latest',
        binds: [sockBind],
        storageMounts: [sockRo],
        networks: [{ key: 'app_internal', aliases: [] }],
      }),
      svc({
        name: 'app', image: 'myapp:1', binds: [sockBind], storageMounts: [sockRw],
        networks: [{ key: 'app_internal', aliases: [] }],
      }),
    ], { networks: internalNet });
    const f = ids(runRules(ctx({ model: m })), 'docker-socket-mount');
    expect(f).toHaveLength(1);
    expect(f[0].service).toBe('app');
    expect(f[0].remediation).toMatch(/already runs a socket proxy \("proxy"\)/);
  });

  it('emits a client note for a tcp:// endpoint on the command line', () => {
    const m = model([
      svc({
        name: 'proxy',
        image: 'tecnativa/docker-socket-proxy:latest',
        binds: [sockBind],
        storageMounts: [sockRo],
        networks: [{ key: 'app_internal', aliases: ['dockerproxy'] }],
      }),
      svc({
        name: 'traefik',
        image: 'traefik:v3',
        dockerEndpointHosts: ['dockerproxy'],
        networks: [{ key: 'app_internal', aliases: [] }],
      }),
    ], { networks: internalNet });
    const note = ids(runRules(ctx({ model: m })), 'docker-socket-proxy-client');
    expect(note).toHaveLength(1);
    expect(note[0].service).toBe('traefik');

    const unrelatedHost = model([
      svc({
        name: 'proxy',
        image: 'tecnativa/docker-socket-proxy:latest',
        binds: [sockBind],
        storageMounts: [sockRo],
        networks: [{ key: 'app_internal', aliases: [] }],
      }),
      svc({
        name: 'traefik', image: 'traefik:v3', dockerEndpointHosts: ['somewhere-else'],
        networks: [{ key: 'app_internal', aliases: [] }],
      }),
    ], { networks: internalNet });
    expect(ids(runRules(ctx({ model: unrelatedHost })), 'docker-socket-proxy-client')).toHaveLength(0);
  });

  it('emits a client note when DOCKER_HOST shares a network with a proxy', () => {
    const m = model([
      svc({
        name: 'proxy',
        image: 'tecnativa/docker-socket-proxy:latest',
        binds: [sockBind],
        storageMounts: [sockRo],
        networks: [{ key: 'app_internal', aliases: [] }],
      }),
      svc({
        name: 'app',
        image: 'myapp:1',
        envKeys: ['DOCKER_HOST'],
        networks: [{ key: 'app_internal', aliases: [] }],
      }),
    ], { networks: internalNet });
    const note = ids(runRules(ctx({ model: m })), 'docker-socket-proxy-client');
    expect(note).toHaveLength(1);
    expect(note[0].message).toMatch(/appears to use/i);
  });

  it('skips the client note without DOCKER_HOST, shared network, or when the app mounts the socket', () => {
    const proxy = svc({
      name: 'proxy',
      image: 'tecnativa/docker-socket-proxy:latest',
      binds: [sockBind],
      storageMounts: [sockRo],
      networks: [{ key: 'app_internal', aliases: [] }],
    });
    const noKey = model([
      proxy,
      svc({ name: 'app', networks: [{ key: 'app_internal', aliases: [] }] }),
    ], { networks: internalNet });
    expect(ids(runRules(ctx({ model: noKey })), 'docker-socket-proxy-client')).toHaveLength(0);
    const noShare = model([
      proxy,
      svc({ name: 'app', envKeys: ['DOCKER_HOST'], networks: [{ key: 'other', aliases: [] }] }),
    ], { networks: internalNet });
    expect(ids(runRules(ctx({ model: noShare })), 'docker-socket-proxy-client')).toHaveLength(0);
    const alsoMounts = model([
      proxy,
      svc({
        name: 'app',
        envKeys: ['DOCKER_HOST'],
        binds: [sockBind],
        storageMounts: [sockRw],
        networks: [{ key: 'app_internal', aliases: [] }],
      }),
    ], { networks: internalNet });
    expect(ids(runRules(ctx({ model: alsoMounts })), 'docker-socket-proxy-client')).toHaveLength(0);
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
    const restartFindings = ids(runRules(ctx({ model: bare })), 'no-restart-policy');
    expect(restartFindings).toHaveLength(1);
    expect(restartFindings[0].remediation).toMatch(/one-shot|init jobs/i);
    expect(restartFindings[0].remediation).toMatch(/restart: "no"/);
    expect(restartFindings[0].remediation).toMatch(/unless-stopped/);
    expect(ids(runRules(ctx({
      model: bare,
      healthchecks: { web: { state: 'absent', origin: 'local-image', consistentReplicas: null } },
    })), 'no-healthcheck')).toHaveLength(1);
    const withDeployRestart = model([svc({ restart: undefined, deploy: { restart_policy: { condition: 'any' } }})]);
    expect(ids(runRules(ctx({ model: withDeployRestart })), 'no-restart-policy')).toHaveLength(0);
  });

  it('emits the healthcheck evidence rule family', () => {
    const bare = model([svc({ hasHealthcheck: false })]);
    expect(ids(runRules(ctx({
      model: bare,
      healthchecks: { web: { state: 'explicitly-disabled', origin: 'compose', consistentReplicas: null } },
    })), 'healthcheck-disabled')).toHaveLength(1);
    expect(ids(runRules(ctx({
      model: bare,
      healthchecks: { web: { state: 'runtime-inherited', origin: 'runtime', consistentReplicas: true } },
    })), 'healthcheck-inherited')[0]).toMatchObject({
      severity: 'info',
      title: 'Healthcheck inherited from image',
    });
    expect(ids(runRules(ctx({
      model: bare,
      healthchecks: { web: { state: 'local-image-inherited', origin: 'local-image', consistentReplicas: null } },
    })), 'healthcheck-inherited')[0].remediation).toMatch(/Optionally declare/);
    expect(ids(runRules(ctx({
      model: bare,
      healthchecks: { web: { state: 'unverifiable', origin: 'none', consistentReplicas: null } },
    })), 'healthcheck-unverifiable')[0].severity).toBe('info');
    expect(ids(runRules(ctx({
      model: bare,
      healthchecks: { web: { state: 'inconsistent-replicas', origin: 'runtime', consistentReplicas: false } },
    })), 'healthcheck-inconsistent')).toHaveLength(1);
    expect(ids(runRules(ctx({
      model: bare,
      healthchecks: { web: { state: 'compose-declared', origin: 'compose', consistentReplicas: null } },
    })), 'no-healthcheck')).toHaveLength(0);
  });

  it('never embeds healthcheck Test command text in findings', () => {
    const bare = model([svc({ hasHealthcheck: false })]);
    const findings = runRules(ctx({
      model: bare,
      healthchecks: { web: { state: 'runtime-inherited', origin: 'runtime', consistentReplicas: true } },
    }));
    const blob = findings.map(f => `${f.title}\n${f.message}\n${f.remediation ?? ''}`).join('\n');
    expect(blob).not.toMatch(/\bCMD\b/);
    expect(blob).not.toMatch(/CMD-SHELL/);
    expect(blob).not.toContain('secret-token');
  });
  it('flags swarm-only deploy fields but not honored ones', () => {
    expect(ids(runRules(ctx({ model: model([svc({ deploy: { placement: {} }})]) })), 'deploy-swarm-only')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: model([svc({ deploy: { replicas: 3 }})]) })), 'deploy-swarm-only')).toHaveLength(0);
  });
});

describe('network / volume rules', () => {
  it('blocks a missing external network and volume', () => {
    const m = model([svc()], { networks: { ext: { name: 'shared', external: true, internal: false } }, volumes: { v: { name: 'data', external: true, internal: false } } });
    const f = runRules(ctx({ model: m }));
    expect(ids(f, 'external-network-missing')).toHaveLength(1);
    expect(ids(f, 'external-volume-missing')).toHaveLength(1);
  });
  it('does not block an external resource that exists', () => {
    const m = model([svc()], { networks: { ext: { name: 'shared', external: true, internal: false } } });
    const f = runRules(ctx({ model: m, existingNetworkNames: new Set(['shared']) }));
    expect(ids(f, 'external-network-missing')).toHaveLength(0);
  });
  it('reports a new network/volume as info when absent on the node (implicit default names)', () => {
    const m = model([svc()], {
      networks: { backend: { name: 'proj_backend', external: false, internal: false } },
      volumes: { data: { name: 'proj_data', external: false, internal: false } },
    });
    const f = runRules(ctx({ model: m }));
    expect(ids(f, 'new-network')[0].severity).toBe('info');
    expect(ids(f, 'new-network')[0].message).toContain('proj_backend');
    expect(ids(f, 'new-volume')[0].message).toContain('proj_data');
  });
  it('uses explicit name equal to the compose key for new-network/new-volume (regression: #1581)', () => {
    const m = model([svc()], {
      projectName: 'proj',
      networks: { backend: { name: 'backend', external: false, internal: false } },
      volumes: { data: { name: 'data', external: false, internal: false } },
    });
    const f = runRules(ctx({ model: m }));
    expect(ids(f, 'new-network')[0].message).toContain('"backend"');
    expect(ids(f, 'new-network')[0].message).not.toContain('proj_backend');
    expect(ids(f, 'new-volume')[0].message).toContain('"data"');
    expect(ids(f, 'new-volume')[0].message).not.toContain('proj_data');
  });
  it('reports new-network with the true explicit name when project and key collide (regression: #1581)', () => {
    const m = model([svc()], {
      projectName: 'network',
      networks: { tailscale: { name: 'tailscale', external: false, internal: false } },
    });
    const f = runRules(ctx({ model: m }));
    const finding = ids(f, 'new-network')[0];
    expect(finding.message).toContain('tailscale');
    expect(finding.message).not.toContain('network_tailscale');
  });
  it('flags an anonymous volume as info and stays silent without one', () => {
    const anon = model([svc({ storageMounts: [{ type: 'anonymous', target: '/data', readOnly: false }] })]);
    const f = runRules(ctx({ model: anon }));
    expect(ids(f, 'anonymous-volume')[0].severity).toBe('info');
    expect(ids(f, 'anonymous-volume')[0].message).toContain('/data');
    const named = model([svc({ storageMounts: [{ type: 'named', source: 'db', target: '/db', readOnly: false }] })]);
    expect(ids(runRules(ctx({ model: named })), 'anonymous-volume')).toHaveLength(0);
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

describe('exposure-intent rules', () => {
  const withPort = (hostIp = '0.0.0.0', over: Partial<EffService> = {}) =>
    model([svc({ name: 'web', ports: [{ startPort: 8080, endPort: 8080, hostIp, protocol: 'tcp' }], ...over })]);

  it('flags a service classified internal that publishes a host port', () => {
    const f = runRules(ctx({ model: withPort(), stackIntent: 'internal' }));
    expect(ids(f, 'exposure-internal-published')).toHaveLength(1);
    expect(ids(f, 'exposure-internal-published')[0].severity).toBe('high');
  });
  it('lets same-node tolerate a loopback bind but not a broad one', () => {
    expect(ids(runRules(ctx({ model: withPort('127.0.0.1'), stackIntent: 'same-node' })), 'exposure-internal-published')).toHaveLength(0);
    expect(ids(runRules(ctx({ model: withPort('0.0.0.0'), stackIntent: 'same-node' })), 'exposure-internal-published')).toHaveLength(1);
  });
  it('lets a per-service intent override the stack intent', () => {
    // Stack is internal, but the service is reclassified public, so no finding.
    const f = runRules(ctx({ model: withPort(), stackIntent: 'internal', serviceIntents: { web: 'public' } }));
    expect(ids(f, 'exposure-internal-published')).toHaveLength(0);
  });
  it('same-node lists only the broad port when a service binds both loopback and broad', () => {
    const m = model([svc({ name: 'web', ports: [
      { startPort: 9000, endPort: 9000, hostIp: '127.0.0.1', protocol: 'tcp' },
      { startPort: 8080, endPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' },
    ] })]);
    const f = ids(runRules(ctx({ model: m, stackIntent: 'same-node' })), 'exposure-internal-published');
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('8080');
    expect(f[0].message).not.toContain('9000');
  });
  it('warns when a port-publishing stack has no exposure intent', () => {
    expect(ids(runRules(ctx({ model: withPort(), stackIntent: null })), 'exposure-unclassified')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: withPort(), stackIntent: 'unknown' })), 'exposure-unclassified')).toHaveLength(1);
    expect(ids(runRules(ctx({ model: withPort(), stackIntent: 'lan' })), 'exposure-unclassified')).toHaveLength(0);
  });
  it('lets a service-level intent suppress the unclassified warning even when the stack is unset', () => {
    // web is the only publishing service; classifying it removes the gap.
    expect(ids(runRules(ctx({ model: withPort(), stackIntent: null, serviceIntents: { web: 'public' } })), 'exposure-unclassified')).toHaveLength(0);
  });
  it('still warns when a publishing service is explicitly unknown over a classified stack', () => {
    expect(ids(runRules(ctx({ model: withPort(), stackIntent: 'public', serviceIntents: { web: 'unknown' } })), 'exposure-unclassified')).toHaveLength(1);
  });
  it('does not warn unclassified when no port is published', () => {
    expect(ids(runRules(ctx({ model: model([svc()]), stackIntent: null })), 'exposure-unclassified')).toHaveLength(0);
  });
  it('does not fabricate intent findings when the exposure context is unavailable', () => {
    // A DB read failure leaves every intent null and no access URLs; the
    // interpretation rules must stay silent rather than read that as unclassified
    // or undocumented.
    const rp = model([svc({ name: 'web', labelKeys: ['traefik.enable'], ports: [{ startPort: 8080, endPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' }] })]);
    const f = runRules(ctx({ model: rp, exposureAvailable: false }));
    expect(ids(f, 'exposure-unclassified')).toHaveLength(0);
    expect(ids(f, 'reverse-proxy-undocumented')).toHaveLength(0);
  });
  it('flags a published port absent from the documented access URLs', () => {
    const f = runRules(ctx({ model: withPort(), hasAccessUrls: true, accessUrlPorts: new Set([443]) }));
    expect(ids(f, 'exposure-port-vs-dossier')).toHaveLength(1);
    // No finding once the port is documented.
    expect(ids(runRules(ctx({ model: withPort(), hasAccessUrls: true, accessUrlPorts: new Set([8080]) })), 'exposure-port-vs-dossier')).toHaveLength(0);
    // Gated off when the dossier records no access URL.
    expect(ids(runRules(ctx({ model: withPort(), hasAccessUrls: false })), 'exposure-port-vs-dossier')).toHaveLength(0);
  });
  it('flags a published port absent from the documented access URLs, listing all undocumented ports', () => {
    const m = model([svc({ name: 'web', ports: [
      { startPort: 8080, endPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' },
      { startPort: 9090, endPort: 9090, hostIp: '0.0.0.0', protocol: 'tcp' },
    ] })]);
    const f = ids(runRules(ctx({ model: m, hasAccessUrls: true, accessUrlPorts: new Set([8080]) })), 'exposure-port-vs-dossier');
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('9090');
    expect(f[0].message).not.toContain('8080');
  });
  it('flags reverse-proxy labels with no documented URL or intent', () => {
    const m = model([svc({ name: 'web', labelKeys: ['traefik.enable', 'traefik.http.routers.web.rule'] })]);
    expect(ids(runRules(ctx({ model: m })), 'reverse-proxy-undocumented')).toHaveLength(1);
    // A caddy-docker-proxy label also trips it.
    const caddy = model([svc({ name: 'web', labelKeys: ['caddy', 'caddy.reverse_proxy'] })]);
    expect(ids(runRules(ctx({ model: caddy })), 'reverse-proxy-undocumented')).toHaveLength(1);
    // An unrelated vendor label that merely contains "caddy" does not.
    const vendor = model([svc({ name: 'web', labelKeys: ['com.caddyserver.unrelated'] })]);
    expect(ids(runRules(ctx({ model: vendor })), 'reverse-proxy-undocumented')).toHaveLength(0);
    // Silenced once documented, stack-intent reverse-proxy, or service-intent reverse-proxy.
    expect(ids(runRules(ctx({ model: m, hasAccessUrls: true })), 'reverse-proxy-undocumented')).toHaveLength(0);
    expect(ids(runRules(ctx({ model: m, stackIntent: 'reverse-proxy' })), 'reverse-proxy-undocumented')).toHaveLength(0);
    expect(ids(runRules(ctx({ model: m, serviceIntents: { web: 'reverse-proxy' } })), 'reverse-proxy-undocumented')).toHaveLength(0);
  });
  it('flags a sensitive image exposed on all interfaces', () => {
    const m = model([svc({ name: 'db', image: 'postgres:16', ports: [{ startPort: 5432, endPort: 5432, hostIp: '0.0.0.0', protocol: 'tcp' }] })]);
    expect(ids(runRules(ctx({ model: m })), 'sensitive-service-broad-exposure')[0].severity).toBe('high');
    // A loopback bind of the same image does not flag.
    const loop = model([svc({ name: 'db', image: 'postgres:16', ports: [{ startPort: 5432, endPort: 5432, hostIp: '127.0.0.1', protocol: 'tcp' }] })]);
    expect(ids(runRules(ctx({ model: loop })), 'sensitive-service-broad-exposure')).toHaveLength(0);
    // A build-only service with no image is not matched, even on a broad bind.
    const build = model([svc({ name: 'postgres-ish', image: undefined, ports: [{ startPort: 5432, endPort: 5432, hostIp: '0.0.0.0', protocol: 'tcp' }] })]);
    expect(ids(runRules(ctx({ model: build })), 'sensitive-service-broad-exposure')).toHaveLength(0);
  });
});

describe('node-state availability', () => {
  // When the node's Docker snapshot could not be collected, the empty sets must not
  // be read as "resource absent" or "no conflict". Every node-state rule suppresses
  // itself, and one advisory explains the partial coverage.
  const externalRes = model([svc()], {
    networks: { ext: { name: 'shared', external: true, internal: false } },
    volumes: { v: { name: 'data', external: true, internal: false } },
  });
  const newRes = model([svc()], {
    networks: { backend: { name: 'backend', external: false, internal: false } },
    volumes: { data: { name: 'data', external: false, internal: false } },
  });
  const portModel = model([svc({ ports: [{ startPort: 8080, endPort: 8080, hostIp: '', protocol: 'tcp' }] })]);
  const nameModel = model([svc({ containerName: 'taken' })]);

  it('does not assert an external network/volume is absent', () => {
    const f = runRules(ctx({ model: externalRes, nodeStateAvailable: false }));
    expect(ids(f, 'external-network-missing')).toHaveLength(0);
    expect(ids(f, 'external-volume-missing')).toHaveLength(0);
  });
  it('does not claim a network/volume is new', () => {
    const f = runRules(ctx({ model: newRes, nodeStateAvailable: false }));
    expect(ids(f, 'new-network')).toHaveLength(0);
    expect(ids(f, 'new-volume')).toHaveLength(0);
  });
  it('does not report a clean all-clear over a real port conflict', () => {
    const f = runRules(ctx({ model: portModel, nodeStateAvailable: false,
      nodePorts: [{ publishedPort: 8080, protocol: 'tcp', ip: '', stack: 'other' }] }));
    expect(ids(f, 'port-conflict-node')).toHaveLength(0);
  });
  it('does not report a clean all-clear over a real container_name collision', () => {
    const f = runRules(ctx({ model: nameModel, nodeStateAvailable: false,
      existingContainers: [{ name: 'taken', stack: 'other' }] }));
    expect(ids(f, 'container-name-collision')).toHaveLength(0);
  });
  it('still runs node-state rules when the snapshot is available', () => {
    const f = runRules(ctx({ model: externalRes, nodeStateAvailable: true }));
    expect(ids(f, 'external-network-missing')).toHaveLength(1);
    expect(ids(f, 'external-volume-missing')).toHaveLength(1);
  });
  it('does not suppress higher-severity model findings while node state is unavailable', () => {
    const f = runRules(ctx({ model: model([svc({ privileged: true })]), nodeStateAvailable: false }));
    expect(ids(f, 'node-state-unavailable')).toHaveLength(1);
    expect(ids(f, 'privileged')).toHaveLength(1); // a real model finding is still reported alongside the advisory
  });

  describe('node-state-unavailable advisory', () => {
    it('fires one info finding when the model rendered but node state is unavailable', () => {
      const f = ids(runRules(ctx({ model: model([svc()]), nodeStateAvailable: false })), 'node-state-unavailable');
      expect(f).toHaveLength(1);
      expect(f[0].severity).toBe('info');
    });
    it('stays silent when node state is available', () => {
      expect(ids(runRules(ctx({ model: model([svc()]), nodeStateAvailable: true })), 'node-state-unavailable')).toHaveLength(0);
    });
    it('stays silent when the model is unrenderable (render-failed already covers it)', () => {
      const f = runRules(ctx({ model: null, renderable: false, renderError: 'boom', nodeStateAvailable: false }));
      expect(ids(f, 'node-state-unavailable')).toHaveLength(0);
    });
  });
});

describe('self-managed-stack', () => {
  it('fires a warning when the stack is the running Sencho instance', () => {
    const f = ids(runRules(ctx({ isSelfStack: true })), 'self-managed-stack');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warning');
  });
  it('stays silent for ordinary stacks', () => {
    expect(ids(runRules(ctx({ isSelfStack: false })), 'self-managed-stack')).toHaveLength(0);
  });
});

describe('rule registry completeness', () => {
  // The canonical rule set. Adding or removing a rule must update this list,
  // which forces a deliberate pass over the docs and the frontend severity map.
  const EXPECTED_RULE_IDS = [
    'render-failed', 'env-unset', 'env-literal-dollar', 'env-file-missing', 'port-conflict-node', 'port-conflict-internal', 'port-exposed-all-interfaces',
    'bind-path-missing', 'bind-path-permission', 'docker-socket-mount',
    'docker-socket-proxy', 'docker-socket-proxy-writable', 'docker-socket-proxy-published',
    'docker-socket-proxy-mutating',
    'docker-socket-proxy-exposure', 'docker-socket-proxy-client',
    'privileged', 'network-mode-host',
    'uid-gid-risk', 'image-latest', 'no-restart-policy', 'no-healthcheck',
    'healthcheck-disabled', 'healthcheck-inherited', 'healthcheck-unverifiable', 'healthcheck-inconsistent',
    'deploy-swarm-only',
    'node-state-unavailable',
    'external-network-missing', 'external-volume-missing', 'new-network', 'new-volume', 'anonymous-volume',
    'container-name-internal-dup', 'container-name-collision',
    'exposure-internal-published', 'sensitive-service-broad-exposure', 'exposure-unclassified',
    'exposure-port-vs-dossier', 'reverse-proxy-undocumented', 'effective-model-expanded', 'self-managed-stack',
  ];
  it('the registry contains exactly the expected rules', () => {
    expect([...RULE_IDS].sort()).toEqual([...EXPECTED_RULE_IDS].sort());
  });
});

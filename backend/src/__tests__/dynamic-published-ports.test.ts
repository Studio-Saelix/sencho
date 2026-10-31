/**
 * A host port Docker assigns at start (a container-only `ports:` entry, an empty
 * or `0` host port, a long entry with no `published`) is still a publication.
 * These tests follow such a port through every reader of the port facts: tunnel
 * detection (WireGuard server signal and host-network reach), the Security
 * exposure descriptor, the Networking facts, findings and per-network counters,
 * the node overview, and the Doctor rules. They also pin the readers that need
 * a port number (conflicts, drift), which must skip it rather than invent one.
 * Fixtures go through parseEffectiveModel: long-form entries mirror the JSON
 * `docker compose config` emits, while short-string entries exercise the
 * adapter's fallback. The Docker-backed parity cases in
 * docker-integration/tunnel-compose-render compare real renders, including
 * IPv6 and raw env files, and drift-ledger.test.ts pins the ledger hash.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEffectiveModel, type EffectiveModel } from '../services/preflight/effectiveModel';
import { detectTunnels, tunnelExposureByService, type TunnelConnector } from '../services/network/tunnelDetection';
import { deriveStackExposure } from '../services/preflight/exposure';
import { buildImageExposureContextRows } from '../services/securityExposureTargets';
import { runRules } from '../services/preflight/rules';
import type { PreflightContext, PreflightFinding } from '../services/preflight/types';
import { assembleStackNetworkFacts } from '../services/network/composeNetworkInspector';
import { buildNodeNetworkingFindings } from '../services/network/networkingFindings';
import { DatabaseService } from '../services/DatabaseService';
import { declaredFromEffectiveModel } from '../helpers/effectiveToDeclaredCompose';
import { assembleStackDrift } from '../services/DriftDetectionService';
import { assembleGraph } from '../services/DependencyGraphService';
import { enrichNetworkRows } from '../services/network/networkingInventory';
import { buildOverview } from '../services/network/networkingAggregate';
import { parseComposeDependencies } from '../helpers/composeDependencyParse';
import { fixedPorts } from '../helpers/composePortSpec';
import type { DependencyContainer, DependencySnapshot } from '../services/DockerController';
import type { NetworkingNetworkBase } from '../services/network/networkingTypes';

type RawService = Record<string, unknown>;

function render(services: Record<string, RawService>): EffectiveModel {
  const withDefaults = Object.fromEntries(Object.entries(services).map(([name, svc]) => [
    name,
    svc.network_mode !== undefined ? svc : { ...svc, networks: { default: null } },
  ]));
  return parseEffectiveModel({ name: 'proj', services: withDefaults, networks: { default: { name: 'proj_default' } } }, 'proj');
}

const app: RawService = { image: 'ghcr.io/example/app:1.2' };
const SOCKET = { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' };

/** Every form a UDP publication with no host port takes, rendered or authored. */
const DYNAMIC_UDP: Array<[string, unknown]> = [
  ['a container-only entry', { mode: 'ingress', target: 51820, protocol: 'udp' }],
  ['an interface with no host port', { mode: 'ingress', host_ip: '127.0.0.1', target: 51820, protocol: 'udp' }],
  ['host port "0"', { mode: 'ingress', host_ip: '127.0.0.1', target: 51820, published: '0', protocol: 'udp' }],
  ['host port 0', { target: 51820, published: 0, protocol: 'udp' }],
  ['an empty host port', { target: 51820, published: '', protocol: 'udp' }],
  ['a short entry', '51820/udp'],
  ['a short entry with an empty host port', '127.0.0.1::51820/udp'],
];

function connector(model: EffectiveModel, service: string): TunnelConnector {
  const found = detectTunnels(model).find(c => c.service === service);
  if (!found) throw new Error(`no connector ${service}`);
  return found;
}

function ctx(model: EffectiveModel, over: Partial<PreflightContext> = {}): PreflightContext {
  return {
    stackName: 'proj', platform: 'linux', model, renderable: true, renderError: null, unsetEnvVars: [],
    literalDollarWarnings: [], missingEnvFiles: [], sourceServiceNames: model.services.map(s => s.name),
    sourceReadable: true, nodePorts: [], existingNetworkNames: new Set(), existingVolumeNames: new Set(),
    existingContainers: [], nodeStateAvailable: true, bindChecks: [],
    stackIntent: null, serviceIntents: {}, accessUrlPorts: new Set(), hasAccessUrls: false,
    exposureAvailable: true, isSelfStack: false, meshManaged: false, healthchecks: {},
    ...over,
  };
}

const byRule = (findings: PreflightFinding[], ruleId: string) => findings.filter(f => f.ruleId === ruleId);

describe('the rendered adapter keeps a dynamic publication without inventing a port', () => {
  it.each(DYNAMIC_UDP)('%s', (_label, entry) => {
    const { ports } = render({ web: { ...app, ports: [entry] } }).services[0];
    expect(ports[0]).toMatchObject({ startPort: 0, endPort: 0, protocol: 'udp', dynamic: true });
    expect(fixedPorts(ports)).toEqual([]);
  });

  it('treats `expose` as no publication at all', () => {
    expect(render({ web: { ...app, expose: ['51820/udp'] } }).services[0].ports).toEqual([]);
  });

  it.each(['8080x', '80-', '80-90-100', '65536', '0', '0-80', '+80x'])('drops %s, which Compose refuses as a container port', (target) => {
    expect(render({ web: { ...app, ports: [{ target }] } }).services[0].ports).toEqual([]);
  });
});

describe('tunnel detection with an auto-assigned host port', () => {
  const wireguard = (ports: unknown[]) => ({ image: 'lscr.io/linuxserver/wireguard:latest', ports });

  it.each(DYNAMIC_UDP)('recognises a generic WireGuard server through %s', (_label, entry) => {
    const namespace = render({ wireguard: wireguard([entry]), app: { ...app, network_mode: 'service:wireguard' } });
    expect(connector(namespace, 'wireguard')).toMatchObject({ provider: 'wireguard' });
    expect(connector(namespace, 'wireguard').signals).toContain('udp-port');
    expect(tunnelExposureByService(detectTunnels(namespace)).get('app')).toMatchObject({ provider: 'wireguard', path: 'shared-namespace' });

    const shared = render({ wireguard: wireguard([entry]), app });
    expect(tunnelExposureByService(detectTunnels(shared)).get('app')).toMatchObject({ provider: 'wireguard', path: 'shared-network' });
  });

  it('keeps a WireGuard client with a dynamic TCP port, or only `expose`, out of the server class', () => {
    expect(detectTunnels(render({ wireguard: wireguard([{ target: 51820, protocol: 'tcp' }]), app }))).toEqual([]);
    expect(detectTunnels(render({ wireguard: { image: 'lscr.io/linuxserver/wireguard:latest', expose: ['51820/udp'] }, app }))).toEqual([]);
  });

  const HOST_CONNECTORS: Array<[string, RawService]> = [
    ['cloudflared', { image: 'cloudflare/cloudflared:latest', command: ['tunnel', 'run'], network_mode: 'host', environment: { TUNNEL_TOKEN: 'tunnel-secret' } }],
    ['tailscale', { image: 'tailscale/tailscale', network_mode: 'host', environment: { TS_AUTHKEY: 'tskey-secret' } }],
    ['wireguard', { image: 'ghcr.io/wg-easy/wg-easy:15', network_mode: 'host' }],
  ];

  describe.each(HOST_CONNECTORS)('a %s host-network connector', (provider, edge) => {
    it.each(DYNAMIC_UDP)('reaches an app published through %s', (_label, entry) => {
      const model = render({ edge, app: { ...app, ports: [entry] } });
      expect(connector(model, 'edge')).toMatchObject({ provider });
      expect(tunnelExposureByService(detectTunnels(model)).get('app')).toMatchObject({ path: 'host-network' });
    });

    it('does not reach an app that only declares `expose`', () => {
      const model = render({ edge, app: { ...app, expose: ['8080'] } });
      expect(tunnelExposureByService(detectTunnels(model)).get('app')).toBeUndefined();
    });
  });
});

describe('the Security exposure descriptor', () => {
  it('marks a service with a dynamic all-interface port as publicly exposed by its published port', () => {
    const exposure = deriveStackExposure(render({ web: { ...app, ports: [{ target: 8080 }] } }), 'proj', 1);
    expect(exposure.services[0]).toMatchObject({ publiclyExposed: true, reason: 'published-port', bindings: ['0.0.0.0:auto/tcp'] });
  });

  it('leaves a loopback-only dynamic port internal', () => {
    const exposure = deriveStackExposure(render({ web: { ...app, ports: [{ target: 8080, host_ip: '127.0.0.1' }] } }), 'proj', 1);
    expect(exposure.services[0]).toMatchObject({ publiclyExposed: false, reason: null, bindings: [] });
  });

  it('reports an app behind a WireGuard server found by its dynamic UDP port, and emits its Security target', () => {
    const model = render({
      wireguard: { image: 'lscr.io/linuxserver/wireguard:latest', ports: ['51820/udp'] },
      app: { ...app, network_mode: 'service:wireguard' },
    });
    const exposure = deriveStackExposure(model, 'proj', 1);
    expect(exposure.services.find(s => s.service === 'app')).toMatchObject({ publiclyExposed: true, reason: 'tunnel' });
    const rows = buildImageExposureContextRows({
      nodeId: 1,
      exposures: [exposure],
      getContext: () => ({ available: true, stackIntent: null, serviceIntents: {}, accessUrlPorts: new Set(), hasAccessUrls: false }),
    });
    expect(rows.find(r => r.serviceName === 'app')).toMatchObject({ exposureReason: 'tunnel', intentStatus: 'unset' });
  });
});

describe('the Networking facts and findings', () => {
  afterEach(() => vi.restoreAllMocks());

  const model = render({
    wireguard: { image: 'lscr.io/linuxserver/wireguard:latest', ports: ['51820/udp'] },
    app: { ...app, network_mode: 'service:wireguard' },
    web: { ...app, ports: [{ target: 8080 }] },
  });

  it('carries the dynamic flag on the published port and the tunnel on the reached service', () => {
    const facts = assembleStackNetworkFacts('proj', model, null, null);
    const wireguard = facts.services.find(s => s.name === 'wireguard');
    expect(wireguard?.publishedPorts).toEqual([
      { hostIp: '', startPort: 0, endPort: 0, protocol: 'udp', dynamic: true, allInterfaces: true, loopbackOnly: false },
    ]);
    expect(facts.services.find(s => s.name === 'app')?.tunnel).toMatchObject({ provider: 'wireguard', path: 'shared-namespace' });
  });

  it('reports an internal intent that a dynamic port contradicts on the live Networking page', () => {
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      getStackExposureIntents: vi.fn().mockReturnValue([{ service: '', intent: 'internal' }]),
      getStackDossier: vi.fn().mockReturnValue(null),
    } as unknown as DatabaseService);
    const findings = buildNodeNetworkingFindings(1, null, [assembleStackNetworkFacts('proj', model, null, null)], []);
    const mismatches = findings.filter(f => f.kind === 'exposure-intent-mismatch' && f.title === 'Internal intent with host publish');
    expect(mismatches.map(f => f.service).sort()).toEqual(['web', 'wireguard']);
    expect(new Set(mismatches.map(f => f.fingerprint)).size).toBe(2);
  });
});

describe('the Compose Doctor rules', () => {
  const dynamicWeb = render({ web: { ...app, ports: [{ target: 8080 }, { target: 9090 }] } });

  it('flags an all-interface dynamic port once per protocol, without a port number', () => {
    const findings = byRule(runRules(ctx(dynamicWeb)), 'port-exposed-all-interfaces');
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('An auto-assigned tcp port is exposed on all interfaces');
    expect(findings[0].remediation).toBe('Bind to a specific interface, e.g. 127.0.0.1::<container port>, if this should not be public.');
  });

  it('asks for an exposure intent on a stack that only publishes dynamic ports', () => {
    const findings = byRule(runRules(ctx(dynamicWeb)), 'exposure-unclassified');
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Stack publishes ports without an exposure intent');
  });

  it('reports an internal intent that a dynamic port contradicts', () => {
    const findings = byRule(runRules(ctx(dynamicWeb, { stackIntent: 'internal' })), 'exposure-internal-published');
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('an auto-assigned host port');
  });

  it('never reports a port conflict, or an undocumented port, for a number nobody chose', () => {
    const two = render({ a: { ...app, ports: [{ target: 80 }] }, b: { ...app, ports: ['80'] } });
    const rules = runRules(ctx(two, {
      nodePorts: [{ publishedPort: 0, protocol: 'tcp', ip: '', stack: 'other' }],
      hasAccessUrls: true,
    }));
    expect(byRule(rules, 'port-conflict-internal')).toEqual([]);
    expect(byRule(rules, 'port-conflict-node')).toEqual([]);
    expect(byRule(rules, 'exposure-port-vs-dossier')).toEqual([]);
  });

  it('still reports a fixed port beside a dynamic one by its number', () => {
    const mixed = render({ web: { ...app, ports: [{ target: 80 }, { target: 80, published: '8080' }] } });
    expect(byRule(runRules(ctx(mixed)), 'port-exposed-all-interfaces').map(f => f.title).sort()).toEqual([
      'An auto-assigned tcp port is exposed on all interfaces',
      'Port 8080 exposed on all interfaces',
    ]);
  });
});

describe('readers that need a port number skip a dynamic one', () => {
  const dynamicModel = render({ web: { ...app, ports: ['80'] } });

  it('keeps a dynamic IPv6 binding as broad or loopback, so exposure and findings agree', () => {
    const wide = render({ web: { ...app, ports: ['[::]:0:8080'] } });
    expect(assembleStackNetworkFacts('proj', wide, null, null).services[0].publishedPorts[0])
      .toMatchObject({ hostIp: '::', dynamic: true, allInterfaces: true, loopbackOnly: false });
    expect(deriveStackExposure(wide, 'proj', 1).services[0]).toMatchObject({ publiclyExposed: true, reason: 'published-port' });

    const loopback = render({ web: { ...app, ports: ['[::1]::8080'] } });
    expect(assembleStackNetworkFacts('proj', loopback, null, null).services[0].publishedPorts[0])
      .toMatchObject({ hostIp: '::1', dynamic: true, allInterfaces: false, loopbackOnly: true });
    expect(deriveStackExposure(loopback, 'proj', 1).services[0]).toMatchObject({ publiclyExposed: false, reason: null });
  });

  it('carries the flag from the rendered model into the declared view, and out of drift', () => {
    const declared = declaredFromEffectiveModel(dynamicModel);
    expect(declared.services[0].ports).toEqual([{ hostIp: '', publishedPort: 0, protocol: 'tcp', dynamic: true }]);
    const container: DependencyContainer = {
      id: 'c1', name: 'c1', service: 'web', composeProject: null, stack: 'proj', state: 'running', exitCode: null,
      image: 'ghcr.io/example/app:1.2', networks: [], volumes: [], ports: [],
    };
    const report = assembleStackDrift({ stack: 'proj', declared, containers: [container] });
    expect(report.findings.filter(f => f.kind === 'ports-mismatch')).toEqual([]);
  });

  it('does not make two services claiming a dynamic port a port conflict', () => {
    const declared = parseComposeDependencies('services:\n  a:\n    image: x\n    ports:\n      - "80"\n  b:\n    image: y\n    ports:\n      - "80"\n');
    const snapshot: DependencySnapshot = { containers: [], networks: [], volumes: [] };
    const graph = assembleGraph({ nodeId: 1, nodeName: 'hub', stacks: ['alpha'], snapshot, declaredByStack: new Map([['alpha', declared]]), parseErrors: [] });
    expect(graph.flags.filter(f => f.kind === 'port-conflict')).toEqual([]);
  });
});

describe('exposure consumers count an auto-assigned port as published', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists each auto-assigned binding once, whatever the number of entries', () => {
    const exposure = deriveStackExposure(render({ web: { ...app, ports: [{ target: 80 }, { target: 81 }, { target: 82, protocol: 'udp' }] } }), 'proj', 1);
    expect(exposure.services[0].bindings).toEqual(['0.0.0.0:auto/tcp', '0.0.0.0:auto/udp']);
  });

  it('flags a database or a socket proxy on an auto-assigned all-interface port', () => {
    const model = render({
      db: { image: 'postgres:16', ports: [{ target: 5432 }] },
      proxy: { image: 'tecnativa/docker-socket-proxy', ports: ['2375'], volumes: [SOCKET] },
    });
    const findings = runRules(ctx(model));
    expect(byRule(findings, 'sensitive-service-broad-exposure').map(f => f.service).sort()).toEqual(['db', 'proxy']);
    expect(byRule(findings, 'docker-socket-proxy-published').map(f => f.service)).toEqual(['proxy']);
  });

  it('keeps a same-node service with only a loopback auto-assigned port clean, and flags a wider one', () => {
    const loopback = render({ web: { ...app, ports: [{ target: 80, host_ip: '127.0.0.1' }] } });
    expect(byRule(runRules(ctx(loopback, { stackIntent: 'same-node' })), 'exposure-internal-published')).toEqual([]);
    const wide = render({ web: { ...app, ports: [{ target: 80 }] } });
    expect(byRule(runRules(ctx(wide, { stackIntent: 'same-node' })), 'exposure-internal-published')).toHaveLength(1);
  });

  it('reports a dynamic TCP and a dynamic UDP port separately, each once', () => {
    const model = render({ web: { ...app, ports: [{ target: 80 }, { target: 81 }, { target: 82, protocol: 'udp' }] } });
    expect(byRule(runRules(ctx(model)), 'port-exposed-all-interfaces').map(f => f.title).sort()).toEqual([
      'An auto-assigned tcp port is exposed on all interfaces',
      'An auto-assigned udp port is exposed on all interfaces',
    ]);
    const proxy = render({ proxy: { image: 'tecnativa/docker-socket-proxy', ports: ['2375', '2376'], volumes: [SOCKET] } });
    expect(byRule(runRules(ctx(proxy)), 'docker-socket-proxy-published')[0].message).toContain('publishes an auto-assigned host port to the host');
  });

  const web = render({ web: { ...app, ports: ['80'] } });
  const facts = assembleStackNetworkFacts('proj', web, null, null);

  it('asks for an intent, and flags the broad bind when the exposure context is unreadable', () => {
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      getStackExposureIntents: vi.fn().mockReturnValue([]),
      getStackDossier: vi.fn().mockReturnValue(null),
    } as unknown as DatabaseService);
    expect(buildNodeNetworkingFindings(1, null, [facts], []).filter(f => f.kind === 'exposure-unclassified' && f.service === 'web')).toHaveLength(1);

    vi.spyOn(DatabaseService, 'getInstance').mockImplementation(() => { throw new Error('db down'); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildNodeNetworkingFindings(1, null, [facts], []).filter(f => f.kind === 'exposure-all-interfaces' && f.service === 'web')).toHaveLength(1);
  });

  it('gives an auto-assigned port a finding fingerprint of its own', () => {
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      getStackExposureIntents: vi.fn().mockReturnValue([{ service: '', intent: 'internal' }]),
      getStackDossier: vi.fn().mockReturnValue(null),
    } as unknown as DatabaseService);
    const fingerprintOf = (ports: unknown[]) => {
      const model = render({ web: { ...app, ports } });
      return buildNodeNetworkingFindings(1, null, [assembleStackNetworkFacts('proj', model, null, null)], [])
        .find(f => f.kind === 'exposure-intent-mismatch')?.fingerprint;
    };
    const dynamic = fingerprintOf([{ target: 80 }]);
    expect(dynamic).toBeDefined();
    expect(dynamic).toBe(fingerprintOf([{ target: 81 }]));
    // Adding another auto-assigned port of the same protocol must not move the
    // fingerprint, or an acknowledgement would stop matching.
    expect(dynamic).toBe(fingerprintOf([{ target: 80 }, { target: 81 }]));
    expect(dynamic).not.toBe(fingerprintOf([{ target: 80, published: '8080' }]));
    expect(dynamic).not.toBe(fingerprintOf([{ target: 80, protocol: 'udp' }]));
  });

  it('counts the stack on a network and in the node overview as exposed and unclassified', () => {
    const snapshot: DependencySnapshot = {
      containers: [{
        id: 'c1', name: 'proj-web-1', service: 'web', composeProject: 'proj', stack: 'proj', state: 'running', exitCode: null,
        image: 'example', networks: [{ name: 'proj_default', id: 'id-default', ip: '172.18.0.2' }], volumes: [], ports: [],
      }],
      networks: [{ id: 'id-default', name: 'proj_default', driver: 'bridge', scope: 'local', isSystem: false, composeProject: 'proj', stack: 'proj' }],
      volumes: [],
    };
    const baseRow: NetworkingNetworkBase = {
      id: 'id-default', name: 'proj_default', driver: 'bridge', scope: 'local', isSystem: false, ingress: false,
      composeProject: 'proj', stack: 'proj', connectedCount: 1, isSencho: false, ownership: 'compose-managed',
      declaredByStacks: ['proj'], declaredExternalByStacks: [], isExternalDependency: false,
    };
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      getStackExposureIntents: vi.fn().mockReturnValue([]),
    } as unknown as DatabaseService);
    const [row] = enrichNetworkRows(1, [baseRow], [facts], snapshot, []);
    expect(row.exposureSummary).toMatchObject({ publishingStackCount: 1, broadExposureCount: 1, unclassifiedStackCount: 1 });
    const overview = buildOverview(1, ['proj'], snapshot, [facts], [], [row]);
    expect(overview).toMatchObject({ exposedStackCount: 1, unknownExposureStackCount: 1 });
  });
});

describe('drift against a running service with an auto-assigned port', () => {
  const running = (ports: DependencyContainer['ports']): DependencyContainer => ({
    id: 'c1', name: 'c1', service: 'web', composeProject: null, stack: 'proj', state: 'running', exitCode: null,
    image: 'ghcr.io/example/app:1.2', networks: [], volumes: [], ports,
  });
  const drift = (ports: unknown[], runtime: DependencyContainer['ports']) =>
    assembleStackDrift({
      stack: 'proj',
      declared: declaredFromEffectiveModel(render({ web: { ...app, ports } })),
      containers: [running(runtime)],
    }).findings.filter(f => f.kind === 'ports-mismatch');

  it('does not report the host port Docker picked as drift', () => {
    expect(drift(['80'], [{ ip: '0.0.0.0', publishedPort: 32768, privatePort: 80, protocol: 'tcp' }])).toEqual([]);
  });

  it('still reports a declared fixed port that is not running, and nothing else for a fixed-only service', () => {
    const picked = { ip: '0.0.0.0', publishedPort: 32768, privatePort: 80, protocol: 'tcp' };
    expect(drift(['80', '8080:81'], [picked])).toHaveLength(1);
    expect(drift(['80', '8080:81'], [picked, { ip: '0.0.0.0', publishedPort: 8080, privatePort: 81, protocol: 'tcp' }])).toEqual([]);
    expect(drift(['8080:81'], [{ ip: '0.0.0.0', publishedPort: 9090, privatePort: 81, protocol: 'tcp' }])).toHaveLength(1);
  });
});

describe('authored port forms beyond the audit matrix', () => {
  const ports = (entry: string) => parseComposeDependencies(`services:\n  web:\n    ports:\n      - ${entry}\n`).services[0].ports;

  it('reads an unbracketed IPv6 interface with an empty host port, and keeps the protocol case as written', () => {
    expect(ports('"::1::51820/udp"')).toEqual([{ hostIp: '::1', publishedPort: 0, protocol: 'udp', dynamic: true }]);
    expect(ports('"51820/UDP"')).toEqual([{ hostIp: '', publishedPort: 0, protocol: 'UDP', dynamic: true }]);
  });

  it('keeps a TCP and a UDP auto-assigned port as two entries', () => {
    const r = parseComposeDependencies('services:\n  web:\n    ports:\n      - "80"\n      - "51820/udp"\n');
    expect(r.services[0].ports.map(p => p.protocol)).toEqual(['tcp', 'udp']);
  });

  it.each(['"0abc:80"', '"0x50:80"', '"127.0.0.1:80"', '"8080x:80"'])('drops %s, which Compose refuses', (entry) => {
    expect(ports(entry)).toEqual([]);
  });
});

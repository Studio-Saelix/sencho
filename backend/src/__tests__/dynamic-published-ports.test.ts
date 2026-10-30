/**
 * A host port Docker assigns at start (a container-only `ports:` entry, an empty
 * or `0` host port, a long entry with no `published`) is still a publication.
 * These tests follow such a port through every reader of the port facts: tunnel
 * detection (WireGuard server signal and host-network reach), the Security
 * exposure descriptor, the Networking facts and findings, and the Doctor rules.
 * They also pin the readers that need a port number (conflicts, drift, the
 * ledger hash), which must skip it rather than invent one. Fixtures go through
 * parseEffectiveModel with `docker compose config` shaped JSON; the Docker-backed
 * parity cases check the same forms against a real render.
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
import { parseComposeDependencies } from '../helpers/composeDependencyParse';
import { fixedPorts } from '../helpers/composePortSpec';
import type { DependencyContainer, DependencySnapshot } from '../services/DockerController';

type RawService = Record<string, unknown>;

function render(services: Record<string, RawService>): EffectiveModel {
  const withDefaults = Object.fromEntries(Object.entries(services).map(([name, svc]) => [
    name,
    svc.network_mode !== undefined ? svc : { ...svc, networks: { default: null } },
  ]));
  return parseEffectiveModel({ name: 'proj', services: withDefaults, networks: { default: { name: 'proj_default' } } }, 'proj');
}

const app: RawService = { image: 'ghcr.io/example/app:1.2' };

/** Every way `docker compose config` renders a port with no host port, in UDP. */
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
    const [port] = render({ web: { ...app, ports: [entry] } }).services[0].ports;
    expect(port).toMatchObject({ startPort: 0, endPort: 0, protocol: 'udp', dynamic: true });
    expect(fixedPorts(render({ web: { ...app, ports: [entry] } }).services[0].ports)).toEqual([]);
  });

  it('treats `expose` as no publication at all', () => {
    expect(render({ web: { ...app, expose: ['51820/udp'] } }).services[0].ports).toEqual([]);
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
      expect(connector(model, 'edge')).toMatchObject({ provider: provider === 'cloudflared' ? 'cloudflared' : provider });
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

  it('reports an internal intent that a dynamic port contradicts', () => {
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
    expect(findings[0].remediation).toBe('Bind to a specific interface, e.g. 127.0.0.1, if this should not be public.');
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
    expect(graph.nodes.filter(n => n.kind === 'port')).toEqual([]);
  });
});

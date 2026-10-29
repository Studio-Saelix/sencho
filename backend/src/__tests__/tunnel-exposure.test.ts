/**
 * Tunnel and private-overlay exposure (Cloudflare Tunnel, Tailscale, WireGuard):
 * detection from the effective model, the Security exposure descriptor and
 * intent conflicts, the Compose Doctor rules, and the live Networking findings.
 * Fixtures go through parseEffectiveModel with `docker compose config` shaped
 * JSON, so the parse path is covered too. Fixtures that set a token or auth key
 * use real-looking values, and the tests that read them assert none reaches an
 * output.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEffectiveModel, type EffectiveModel } from '../services/preflight/effectiveModel';
import {
  describeTunnelConnector,
  detectTunnels,
  imageBaseName,
  tunnelExposureByService,
  type TunnelConnector,
} from '../services/network/tunnelDetection';
import { buildExposedImageMap, deriveStackExposure } from '../services/preflight/exposure';
import { buildImageExposureContextRows, settleTunnelExposure, toPostureTarget } from '../services/securityExposureTargets';
import { classifyImageExposureBucket } from '../services/securityExposureClassification';
import { isPreflightNoteFinding, runRules } from '../services/preflight/rules';
import type { PreflightContext, PreflightFinding } from '../services/preflight/types';
import { assembleStackNetworkFacts } from '../services/network/composeNetworkInspector';
import { buildNodeNetworkingFindings } from '../services/network/networkingFindings';
import { applyDoctorNetworkingFindings } from '../services/network/doctorNetworkingFindings';
import { ComposeDoctorService } from '../services/ComposeDoctorService';
import { DatabaseService } from '../services/DatabaseService';
import type { ExposureContext } from '../services/network/exposureContext';
import type { ExposureIntent } from '../services/network/types';

const CF_TOKEN = 'eyJhIjoiY2xvdWRmbGFyZS1zZWNyZXQtdG9rZW4ifQ';
const TS_KEY = 'tskey-auth-kSECRETVALUE-0123456789abcdef';
const WG_PASSWORD = 'wg-easy-admin-password-value';
const SECRETS = [CF_TOKEN, TS_KEY, WG_PASSWORD];

type RawService = Record<string, unknown>;

function render(services: Record<string, RawService>, networks: Record<string, unknown> = { default: { name: 'proj_default' } }): EffectiveModel {
  const withDefaults = Object.fromEntries(Object.entries(services).map(([name, svc]) => [
    name,
    svc.network_mode !== undefined || svc.networks !== undefined ? svc : { ...svc, networks: { default: null } },
  ]));
  return parseEffectiveModel({ name: 'proj', services: withDefaults, networks }, 'proj');
}

const app: RawService = { image: 'ghcr.io/example/app:1.2' };
const db: RawService = { image: 'postgres:16', environment: { POSTGRES_PASSWORD: 'db-secret' } };

function connector(model: EffectiveModel, service: string): TunnelConnector {
  const found = detectTunnels(model).find(c => c.service === service);
  if (!found) throw new Error(`no connector ${service}`);
  return found;
}

function reachOf(c: TunnelConnector): Record<string, string> {
  return Object.fromEntries(c.reaches.map(r => [r.service, r.path]));
}

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe('imageBaseName', () => {
  it('drops registry, namespace, tag and digest', () => {
    expect(imageBaseName('cloudflare/cloudflared:2024.10.0')).toBe('cloudflared');
    expect(imageBaseName('registry.local:5000/mirror/Cloudflared:latest@sha256:abc')).toBe('cloudflared');
    expect(imageBaseName('ghcr.io/wg-easy/wg-easy:15')).toBe('wg-easy');
    expect(imageBaseName('tailscale')).toBe('tailscale');
  });
});

describe('detectTunnels: Cloudflare Tunnel', () => {
  it('detects a remotely managed connector and every service it shares a network with, routing unverified', () => {
    const model = render({
      cloudflared: { image: 'cloudflare/cloudflared:latest', command: ['tunnel', '--no-autoupdate', 'run', '--token', CF_TOKEN], environment: { TUNNEL_TOKEN: CF_TOKEN } },
      app,
      db,
    });
    const c = connector(model, 'cloudflared');
    expect(c).toMatchObject({ provider: 'cloudflared', scope: 'public-edge', localConfig: false, meshAttached: false });
    expect(c.signals).toEqual(['image', 'env:TUNNEL_TOKEN']);
    expect(reachOf(c)).toEqual({ app: 'shared-network', db: 'shared-network' });
    expect(c.reaches.find(r => r.service === 'app')?.networks).toEqual(['default']);
    expect(describeTunnelConnector(c).message).toContain('ingress rules in Cloudflare, which Sencho cannot see');
    expectNoSecrets(c);
    expectNoSecrets(describeTunnelConnector(c));
  });

  it('treats a cloudflared sidecar in the app namespace as a certain reach', () => {
    const model = render({ app, cloudflared: { image: 'cloudflare/cloudflared', network_mode: 'service:app', environment: { TUNNEL_TOKEN: CF_TOKEN } }, db });
    expect(reachOf(connector(model, 'cloudflared'))).toEqual({ app: 'shared-namespace', db: 'shared-network' });
  });

  it('notes a locally configured tunnel when a cloudflared config directory is mounted', () => {
    const model = render({
      tunnel: { image: 'cloudflare/cloudflared', command: ['tunnel', 'run'], volumes: [{ type: 'bind', source: '/srv/cf', target: '/etc/cloudflared' }] },
      app,
    });
    const c = connector(model, 'tunnel');
    expect(c.localConfig).toBe(true);
    expect(describeTunnelConnector(c).message).toContain('mounted cloudflared config');
  });

  it('identifies a custom image by the TUNNEL_TOKEN key name alone', () => {
    const c = connector(render({ edge: { image: 'example/edge:1', environment: [`TUNNEL_TOKEN=${CF_TOKEN}`] }, app }), 'edge');
    expect(c.provider).toBe('cloudflared');
    expect(c.signals).toEqual(['env:TUNNEL_TOKEN']);
  });

  it('reaches only services that share one of its networks', () => {
    const model = render({
      cloudflared: { image: 'cloudflare/cloudflared', networks: { edge: null } },
      app: { ...app, networks: { edge: null, backend: null } },
      db: { ...db, networks: { backend: null } },
    }, { edge: { name: 'proj_edge' }, backend: { name: 'proj_backend', internal: true } });
    expect(reachOf(connector(model, 'cloudflared'))).toEqual({ app: 'shared-network' });
  });

  it('flags a connector on the Sencho Mesh network as possibly routing to other nodes', () => {
    const model = render({
      cloudflared: { image: 'cloudflare/cloudflared', networks: { default: null, sencho_mesh: null } },
      app,
    }, { default: { name: 'proj_default' }, sencho_mesh: { name: 'sencho_mesh', external: true } });
    const c = connector(model, 'cloudflared');
    expect(c.meshAttached).toBe(true);
    expect(describeTunnelConnector(c).message).toContain('Sencho Mesh network');
  });
});

describe('detectTunnels: Tailscale', () => {
  it('detects a sidecar and reaches only the services in its namespace', () => {
    const model = render({
      tailscale: {
        image: 'tailscale/tailscale:stable',
        environment: { TS_AUTHKEY: TS_KEY, TS_STATE_DIR: '/var/lib/tailscale' },
        cap_add: ['net_admin', 'SYS_MODULE'],
        devices: [{ source: '/dev/net/tun', target: '/dev/net/tun', permissions: 'rwm' }],
      },
      app: { ...app, network_mode: 'service:tailscale' },
      db,
    });
    const c = connector(model, 'tailscale');
    expect(c).toMatchObject({ provider: 'tailscale', scope: 'private-overlay', serveConfig: false });
    expect(c.signals).toEqual(['image', 'env:TS_AUTHKEY', 'env:TS_STATE_DIR', 'cap:NET_ADMIN', 'device:/dev/net/tun']);
    expect(reachOf(c)).toEqual({ app: 'shared-namespace' });
    expectNoSecrets(c);
  });

  it('reaches shared networks only as a subnet router', () => {
    const model = render({ ts: { image: 'ghcr.io/tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY, TS_ROUTES: '172.20.0.0/16' } }, db });
    expect(reachOf(connector(model, 'ts'))).toEqual({ db: 'shared-network' });
  });

  it('says Funnel can make Serve targets public when a Serve config is set', () => {
    const model = render({ ts: { image: 'tailscale/tailscale', environment: { TS_AUTH_KEY: TS_KEY, TS_SERVE_CONFIG: '/config/serve.json' } }, app });
    const c = connector(model, 'ts');
    expect(c.serveConfig).toBe(true);
    expect(reachOf(c)).toEqual({ app: 'shared-network' });
    expect(describeTunnelConnector(c).message).toContain('if Funnel is on, those services are public');
  });

  it('follows a namespace chain to the connector', () => {
    const model = render({
      tailscale: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY } },
      app: { ...app, network_mode: 'service:tailscale' },
      worker: { image: 'example/worker', network_mode: 'service:app' },
    });
    expect(reachOf(connector(model, 'tailscale'))).toEqual({ app: 'shared-namespace', worker: 'shared-namespace' });
  });
});

describe('detectTunnels: WireGuard', () => {
  it('detects wg-easy as a server that reaches its networks', () => {
    const model = render({
      'wg-easy': { image: 'ghcr.io/wg-easy/wg-easy:15', environment: { WG_HOST: 'vpn.example.com', PASSWORD: WG_PASSWORD }, ports: [{ published: '51820', target: 51820, protocol: 'udp' }], cap_add: ['NET_ADMIN'] },
      app,
    });
    const c = connector(model, 'wg-easy');
    expect(c).toMatchObject({ provider: 'wireguard', scope: 'private-overlay' });
    expect(c.signals).toEqual(['image', 'env:WG_HOST', 'cap:NET_ADMIN', 'udp-port']);
    expect(reachOf(c)).toEqual({ app: 'shared-network' });
    expectNoSecrets(c);
  });

  it('detects a linuxserver/wireguard server and the services in its namespace', () => {
    const model = render({
      wireguard: { image: 'lscr.io/linuxserver/wireguard:latest', environment: { PEERS: '3', SERVERURL: 'auto' }, devices: ['/dev/net/tun:/dev/net/tun'] },
      app: { ...app, network_mode: 'service:wireguard' },
    });
    const c = connector(model, 'wireguard');
    expect(c.signals).toEqual(['image', 'env:PEERS', 'env:SERVERURL', 'device:/dev/net/tun']);
    expect(reachOf(c)).toEqual({ app: 'shared-namespace' });
  });

  it('ignores a WireGuard client with no server signal (an outbound VPN exposes nothing)', () => {
    const model = render({
      wireguard: { image: 'linuxserver/wireguard', cap_add: ['NET_ADMIN'], devices: ['/dev/net/tun'] },
      torrent: { image: 'linuxserver/qbittorrent', network_mode: 'service:wireguard' },
    });
    expect(detectTunnels(model)).toEqual([]);
  });

  it('ignores a generic VPN client that only has NET_ADMIN and /dev/net/tun', () => {
    const model = render({
      gluetun: { image: 'qmcgaw/gluetun', cap_add: ['NET_ADMIN'], devices: ['/dev/net/tun:/dev/net/tun'], environment: { WIREGUARD_PRIVATE_KEY: 'k' } },
      torrent: { image: 'linuxserver/qbittorrent', network_mode: 'service:gluetun' },
    });
    expect(detectTunnels(model)).toEqual([]);
  });
});

describe('tunnelExposureByService', () => {
  it('keeps the strongest path per service: certain over unverified, public over private', () => {
    const model = render({
      cloudflared: { image: 'cloudflare/cloudflared' },
      tailscale: { image: 'tailscale/tailscale' },
      app: { ...app, network_mode: 'service:tailscale' },
      db,
    });
    const byService = tunnelExposureByService(detectTunnels(model));
    expect(byService.get('app')).toEqual({ connector: 'tailscale', provider: 'tailscale', scope: 'private-overlay', path: 'shared-namespace' });
    expect(byService.get('db')).toEqual({ connector: 'cloudflared', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' });
    expect(byService.get('tailscale')).toEqual({ connector: 'cloudflared', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' });
  });
});

describe('deriveStackExposure with tunnels', () => {
  const model = render({
    cloudflared: { image: 'cloudflare/cloudflared', environment: { TUNNEL_TOKEN: CF_TOKEN } },
    app,
    web: { image: 'nginx:1.27', ports: [{ published: '8080', target: 80, protocol: 'tcp' }] },
  });
  const exposure = deriveStackExposure(model, 'proj', 1);

  it('marks a tunnel-reached service with no published port as exposed through the tunnel', () => {
    const svc = exposure.services.find(s => s.service === 'app');
    expect(svc).toMatchObject({ publiclyExposed: true, reason: 'tunnel', bindings: [] });
    expect(svc?.tunnel).toEqual({ connector: 'cloudflared', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' });
    expect(buildExposedImageMap([exposure]).get('ghcr.io/example/app:1.2')).toBe(true);
  });

  it('keeps a published port as the reason and records the tunnel alongside', () => {
    const svc = exposure.services.find(s => s.service === 'web');
    expect(svc?.reason).toBe('published-port');
    expect(svc?.tunnel?.provider).toBe('cloudflared');
  });

  it('does not count the connector itself as exposed', () => {
    expect(exposure.services.find(s => s.service === 'cloudflared')).toMatchObject({ publiclyExposed: false, reason: null });
    expectNoSecrets(exposure);
  });
});

describe('Security exposure targets with tunnels', () => {
  const exposure = deriveStackExposure(render({
    tailscale: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY } },
    app: { ...app, network_mode: 'service:tailscale' },
    cloudflared: { image: 'cloudflare/cloudflared' },
    db,
  }), 'proj', 1);
  const context = (serviceIntents: Record<string, ExposureIntent>): ExposureContext => ({
    available: true, stackIntent: null, serviceIntents, accessUrlPorts: new Set(), hasAccessUrls: false,
  });
  const rows = (serviceIntents: Record<string, ExposureIntent>) =>
    buildImageExposureContextRows({ nodeId: 1, exposures: [exposure], getContext: () => context(serviceIntents) });

  it('emits a target for each tunnel-reached service with its tunnel path', () => {
    const app = rows({}).find(r => r.serviceName === 'app');
    expect(app).toMatchObject({ exposureReason: 'tunnel', intentStatus: 'unset' });
    expect(app?.tunnel?.path).toBe('shared-namespace');
  });

  it('treats an internal intent on a certain tunnel reach as a conflict', () => {
    const app = rows({ app: 'internal' }).find(r => r.serviceName === 'app');
    expect(app?.intentConflict).toBe(true);
    expect(classifyImageExposureBucket([toPostureTarget(app!)])).toBe('conflict');
  });

  it('takes an internal intent on an unverified tunnel reach at the operator\'s word', () => {
    const settled = settleTunnelExposure(1, [exposure], () => context({ db: 'internal', app: 'internal' }));
    expect(settled[0].services.find(s => s.service === 'db')?.publiclyExposed).toBe(false);
    // A certain reach stays exposed and still conflicts with the intent.
    expect(settled[0].services.find(s => s.service === 'app')?.publiclyExposed).toBe(true);
    expect(buildExposedImageMap(settled).get('postgres:16')).toBe(false);
    const settledRows = buildImageExposureContextRows({ nodeId: 1, exposures: settled, getContext: () => context({ db: 'internal', app: 'internal' }) });
    expect(settledRows.map(r => r.serviceName)).not.toContain('db');
    expect(settledRows.find(r => r.serviceName === 'app')?.intentConflict).toBe(true);
  });

  it('leaves unverified tunnel exposure counted when the intent is unset, deliberate, or unreadable', () => {
    const cases: Record<string, ExposureIntent>[] = [{}, { db: 'public' }];
    for (const intents of cases) {
      const settled = settleTunnelExposure(1, [exposure], () => context(intents));
      expect(settled[0].services.find(s => s.service === 'db')?.publiclyExposed).toBe(true);
    }
    const unreadable = settleTunnelExposure(1, [exposure], () => ({ available: false }));
    expect(unreadable[0].services.find(s => s.service === 'db')?.publiclyExposed).toBe(true);
  });

  it('accepts a deliberate intent on a tunnel-reached service', () => {
    const app = rows({ app: 'lan' }).find(r => r.serviceName === 'app');
    expect(classifyImageExposureBucket([toPostureTarget(app!)])).toBe('intentional');
  });
});

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

describe('Compose Doctor tunnel rules', () => {
  const model = render({
    cloudflared: { image: 'cloudflare/cloudflared', environment: { TUNNEL_TOKEN: CF_TOKEN } },
    app,
    tailscale: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY }, networks: { tail: null } },
    admin: { image: 'example/admin', network_mode: 'service:tailscale' },
  }, { default: { name: 'proj_default' }, tail: { name: 'proj_tail' } });

  it('reports each connector as an informational note naming provider, scope, and what is unverified', () => {
    const findings = byRule(runRules(ctx(model, { stackIntent: 'public' })), 'tunnel-exposure');
    const bySvc = Object.fromEntries(findings.map(f => [f.service, f]));
    expect(Object.keys(bySvc).sort()).toEqual(['cloudflared', 'tailscale']);
    expect(findings.every(f => f.severity === 'info')).toBe(true);
    expect(bySvc.cloudflared.title).toBe('Cloudflare Tunnel connector "cloudflared" (public edge)');
    expect(bySvc.cloudflared.message).toContain('"app" shares a network with it');
    expect(bySvc.cloudflared.message).toContain('Sencho cannot see');
    expect(bySvc.tailscale.title).toBe('Tailscale connector "tailscale" (private overlay)');
    expect(bySvc.tailscale.message).toContain('"admin" shares its network namespace');
    expect(isPreflightNoteFinding('tunnel-exposure')).toBe(true);
    expectNoSecrets(findings);
  });

  it('flags an internal intent on a tunnel-reached service, high when certain and a warning when unverified', () => {
    const findings = byRule(runRules(ctx(model, { stackIntent: 'internal' })), 'exposure-internal-tunneled');
    const bySvc = Object.fromEntries(findings.map(f => [f.service, f]));
    expect(Object.fromEntries(findings.map(f => [f.service, f.severity]))).toEqual({ app: 'warning', admin: 'high' });
    expect(bySvc.app.message).toContain('that routing is unverified');
    expect(bySvc.admin.message).toContain('devices on the tailnet can reach it');
  });

  it('stays silent for deliberate intents', () => {
    expect(byRule(runRules(ctx(model, { stackIntent: 'public' })), 'exposure-internal-tunneled')).toEqual([]);
  });

  it('asks for an exposure intent when a stack is reachable only through a tunnel', () => {
    const findings = byRule(runRules(ctx(model)), 'exposure-unclassified');
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Stack is reachable without an exposure intent');
    expect(byRule(runRules(ctx(model, { serviceIntents: { app: 'public', admin: 'lan' } })), 'exposure-unclassified')).toEqual([]);
  });

  it('skips the unclassified interpretation when the exposure context could not be read', () => {
    expect(byRule(runRules(ctx(model, { exposureAvailable: false })), 'exposure-unclassified')).toEqual([]);
  });
});

describe('live Networking findings for tunnels', () => {
  afterEach(() => vi.restoreAllMocks());

  const model = render({
    cloudflared: { image: 'cloudflare/cloudflared', environment: { TUNNEL_TOKEN: CF_TOKEN } },
    app,
    tailscale: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY }, networks: { tail: null } },
    admin: { image: 'example/admin', network_mode: 'service:tailscale' },
  }, { default: { name: 'proj_default' }, tail: { name: 'proj_tail' } });
  const facts = assembleStackNetworkFacts('proj', model, null, null);

  function withIntents(rows: { service: string; intent: ExposureIntent }[]) {
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      getStackExposureIntents: vi.fn().mockReturnValue(rows),
      getStackDossier: vi.fn().mockReturnValue(null),
    } as unknown as DatabaseService);
  }

  it('carries the connectors and each reached service\'s tunnel path on the stack facts', () => {
    expect(facts.tunnels.map(c => c.service)).toEqual(['cloudflared', 'tailscale']);
    expect(Object.fromEntries(facts.services.map(s => [s.name, s.tunnel?.path ?? null]))).toEqual({
      cloudflared: null, app: 'shared-network', tailscale: null, admin: 'shared-namespace',
    });
    expectNoSecrets(facts);
  });

  it('emits a connector card and asks for intent on each reached service', () => {
    withIntents([]);
    const findings = buildNodeNetworkingFindings(1, null, [facts], []);
    expect(findings.filter(f => f.kind === 'tunnel-exposure').map(f => f.service)).toEqual(['cloudflared', 'tailscale']);
    const unclassified = findings.filter(f => f.kind === 'exposure-unclassified');
    expect(Object.fromEntries(unclassified.map(f => [f.service, f.title]))).toEqual({
      app: 'Reachable through a tunnel without exposure intent',
      admin: 'Reachable through a tunnel without exposure intent',
    });
    expectNoSecrets(findings);
  });

  it('reports an internal intent on a tunnel-reached service as a mismatch, high only when certain', () => {
    withIntents([{ service: '', intent: 'internal' }]);
    const mismatches = buildNodeNetworkingFindings(1, null, [facts], [])
      .filter(f => f.kind === 'exposure-intent-mismatch');
    expect(Object.fromEntries(mismatches.map(f => [f.service, f.severity]))).toEqual({ app: 'medium', admin: 'high' });
    expect(new Set(mismatches.map(f => f.title))).toEqual(new Set(['Internal intent with tunnel access']));
  });

  it('keeps the connector card but skips intent interpretation when the context is unavailable', () => {
    vi.spyOn(DatabaseService, 'getInstance').mockImplementation(() => { throw new Error('db down'); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const findings = buildNodeNetworkingFindings(1, null, [facts], []);
    expect(findings.filter(f => f.kind === 'tunnel-exposure')).toHaveLength(2);
    expect(findings.filter(f => f.kind === 'exposure-unclassified' || f.kind === 'exposure-intent-mismatch')).toEqual([]);
  });

  it('does not double-flag a service the published-port pass already flagged', () => {
    const published = render({
      cloudflared: { image: 'cloudflare/cloudflared' },
      web: { image: 'nginx', ports: [{ published: '8080', target: 80, protocol: 'tcp' }] },
    });
    withIntents([]);
    const findings = buildNodeNetworkingFindings(1, null, [assembleStackNetworkFacts('proj', published, null, null)], []);
    expect(findings.filter(f => f.kind === 'exposure-unclassified' && f.service === 'web')).toHaveLength(1);
  });

  it('merges the cached Doctor connector finding into the live connector card', () => {
    withIntents([{ service: '', intent: 'public' }]);
    const live = buildNodeNetworkingFindings(1, null, [facts], []);
    const doctorFindings = runRules(ctx(model, { stackIntent: 'public' }))
      .filter(f => f.ruleId === 'tunnel-exposure');
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue({ status: 'info', ranAt: 1, findings: doctorFindings }),
    } as unknown as ComposeDoctorService);
    const merged = applyDoctorNetworkingFindings(live, { nodeId: 1, stackNames: ['proj'], stackFacts: [facts], snapshot: null });
    const cards = merged.filter(f => f.kind === 'tunnel-exposure');
    expect(cards).toHaveLength(2);
    expect(cards.every(c => c.sources.includes('doctor') && c.sources.includes('live'))).toBe(true);
  });
});

describe('detectTunnels: connector attachment and identification edge cases', () => {
  it('reaches services that publish a host port when the connector uses the host network, routing unverified', () => {
    const model = render({
      cloudflared: { image: 'cloudflare/cloudflared', network_mode: 'host', environment: { TUNNEL_TOKEN: CF_TOKEN } },
      app: { ...app, ports: [{ published: '3000', target: 3000, host_ip: '127.0.0.1', protocol: 'tcp' }] },
      db,
    });
    const c = connector(model, 'cloudflared');
    expect(c.attachment).toBe('host');
    expect(reachOf(c)).toEqual({ app: 'host-network' });
    expect(describeTunnelConnector(c).message).toContain('"app" publishes a host port it can reach over the host network');
    const svc = deriveStackExposure(model, 'proj', 1).services.find(s => s.service === 'app');
    expect(svc).toMatchObject({ publiclyExposed: true, reason: 'tunnel', tunnel: { path: 'host-network' } });
  });

  it('says so when a host-network connector finds no published port', () => {
    const c = connector(render({ cloudflared: { image: 'cloudflare/cloudflared', network_mode: 'host' }, db }), 'cloudflared');
    expect(c.reaches).toEqual([]);
    expect(describeTunnelConnector(c).message).toContain('It uses the host network, so it can reach any port published on the host');
  });

  it('reports an unknown reach, not an empty one, for a connector in another container\'s namespace', () => {
    for (const mode of ['container:edge-proxy', 'none']) {
      const c = connector(render({ cloudflared: { image: 'cloudflare/cloudflared', network_mode: mode }, app }), 'cloudflared');
      expect(c.attachment).toBe('other');
      expect(c.reaches).toEqual([]);
      expect(describeTunnelConnector(c).message).toContain('Sencho cannot see which services it reaches');
    }
  });

  it('does not loop or invent a reach on a network_mode cycle', () => {
    const model = render({
      cloudflared: { image: 'cloudflare/cloudflared' },
      a: { image: 'example/a', network_mode: 'service:b' },
      b: { image: 'example/b', network_mode: 'service:a' },
    });
    expect(reachOf(connector(model, 'cloudflared'))).toEqual({});
  });

  it('names external networks the connector shares with other stacks as unknown reach', () => {
    const model = render({ cloudflared: { image: 'cloudflare/cloudflared', networks: { proxy: null } } }, { proxy: { name: 'proxy', external: true } });
    const c = connector(model, 'cloudflared');
    expect(c.externalNetworks).toEqual(['proxy']);
    expect(c.reaches).toEqual([]);
    expect(describeTunnelConnector(c).message).toContain('external network "proxy", so services of other stacks on that network may be reachable');
  });

  it('marks a connector Mesh-attached when the stack is opted into Mesh, unless it uses a network_mode', () => {
    const model = render({ cloudflared: { image: 'cloudflare/cloudflared' }, sidecar: { image: 'cloudflare/cloudflared', network_mode: 'service:app' }, app });
    expect(connector(model, 'cloudflared').meshAttached).toBe(false);
    const managed = detectTunnels(model, { meshManaged: true });
    expect(managed.find(c => c.service === 'cloudflared')?.meshAttached).toBe(true);
    // The sidecar runs in app's namespace, which Mesh opt-in does attach.
    expect(managed.find(c => c.service === 'sidecar')?.meshAttached).toBe(true);
    const hostMode = detectTunnels(render({ cloudflared: { image: 'cloudflare/cloudflared', network_mode: 'host' } }), { meshManaged: true });
    expect(hostMode[0].meshAttached).toBe(false);
  });

  it('ignores a cloudflared DNS proxy or access client, but keeps a tunnel that says so', () => {
    expect(detectTunnels(render({ dns: { image: 'cloudflare/cloudflared', command: 'proxy-dns --port 5053' }, pihole: { image: 'pihole/pihole' } }))).toEqual([]);
    expect(detectTunnels(render({ dns: { image: 'crazymax/cloudflared', environment: { TUNNEL_DNS_UPSTREAM: 'https://1.1.1.1/dns-query' } }, pihole: { image: 'pihole/pihole' } }))).toEqual([]);
    expect(detectTunnels(render({ ssh: { image: 'cloudflare/cloudflared', command: ['access', 'tcp', '--hostname', 'ssh.example.com'] }, app }))).toEqual([]);
    expect(detectTunnels(render({ cf: { image: 'cloudflare/cloudflared', command: ['tunnel', 'run', '--token', CF_TOKEN] }, app }))).toHaveLength(1);
  });

  it('identifies custom images by TUNNEL_TOKEN_FILE, TS_AUTH_KEY, or WG_HOST key names', () => {
    expect(connector(render({ edge: { image: 'example/edge', environment: { TUNNEL_TOKEN_FILE: '/run/secrets/cf' } }, app }), 'edge').provider).toBe('cloudflared');
    expect(connector(render({ mesh: { image: 'example/ts', environment: { TS_AUTH_KEY: TS_KEY } }, app }), 'mesh').provider).toBe('tailscale');
    expect(connector(render({ vpn: { image: 'example/wg', environment: { WG_HOST: 'vpn.example.com' } }, app }), 'vpn').provider).toBe('wireguard');
  });

  it('treats a wireguard image publishing a UDP port as a server, and accepts a CAP_ prefixed capability', () => {
    const c = connector(render({
      wireguard: { image: 'linuxserver/wireguard', cap_add: ['CAP_NET_ADMIN'], ports: [{ published: '51820', target: 51820, protocol: 'udp' }] },
      app,
    }), 'wireguard');
    expect(c.signals).toEqual(['image', 'cap:NET_ADMIN', 'udp-port']);
    expect(reachOf(c)).toEqual({ app: 'shared-network' });
  });

  it('lets a Tailscale node forward to shared networks when TS_EXTRA_ARGS or TS_DEST_IP is set', () => {
    for (const key of ['TS_EXTRA_ARGS', 'TS_DEST_IP']) {
      const c = connector(render({ ts: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: TS_KEY, [key]: 'x' } }, db }), 'ts');
      expect(reachOf(c)).toEqual({ db: 'shared-network' });
    }
  });
});

describe('cached Doctor tunnel findings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retires a cached tunnel finding once the current facts no longer show the tunnel', () => {
    const before = render({ cloudflared: { image: 'cloudflare/cloudflared' }, app });
    const cached = runRules(ctx(before, { stackIntent: 'internal' }))
      .filter(f => f.ruleId === 'tunnel-exposure' || f.ruleId === 'exposure-internal-tunneled');
    expect(cached.map(f => f.ruleId).sort()).toEqual(['exposure-internal-tunneled', 'tunnel-exposure']);
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue({ status: 'warning', ranAt: 1, findings: cached }),
    } as unknown as ComposeDoctorService);
    const options = (model: EffectiveModel) => ({
      nodeId: 1, stackNames: ['proj'], stackFacts: [assembleStackNetworkFacts('proj', model, null, null)], snapshot: null,
    });

    const stillThere = applyDoctorNetworkingFindings([], options(before));
    expect(stillThere.map(f => f.kind).sort()).toEqual(['exposure-intent-mismatch', 'tunnel-exposure']);

    const removed = applyDoctorNetworkingFindings([], options(render({ app })));
    expect(removed).toEqual([]);
  });
});

describe('Networking overview counters with tunnels', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts a tunnel-only stack as exposed and, without an intent, as unknown exposure', async () => {
    const { buildNodeNetworkingAggregate } = await import('../services/network/networkingAggregate');
    const { ComposeService } = await import('../services/ComposeService');
    const { FileSystemService } = await import('../services/FileSystemService');
    const DockerController = (await import('../services/DockerController')).default;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({ getStacks: vi.fn().mockResolvedValue(['proj']) } as unknown as ReturnType<typeof FileSystemService.getInstance>);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockRejectedValue(new Error('docker down')),
    } as unknown as ReturnType<typeof DockerController.getInstance>);
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue({
        rendered: JSON.stringify({ name: 'proj', services: { cloudflared: { image: 'cloudflare/cloudflared', networks: { default: null } }, app: { image: 'example/app', networks: { default: null } } }, networks: { default: { name: 'proj_default' } } }),
        stderr: '',
      }),
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    vi.spyOn(DatabaseService, 'getInstance').mockReturnValue({
      getStackExposureIntents: vi.fn().mockReturnValue([]),
      getStackDossier: vi.fn().mockReturnValue(null),
      isMeshStackEnabled: vi.fn().mockReturnValue(false),
      getNodeStackActivity: vi.fn().mockReturnValue([]),
    } as unknown as DatabaseService);
    vi.spyOn(ComposeDoctorService, 'getInstance').mockReturnValue({
      getLatest: vi.fn().mockReturnValue({ status: 'never-run', ranAt: null, findings: [] }),
    } as unknown as ComposeDoctorService);

    const aggregate = await buildNodeNetworkingAggregate(90_683, {});
    expect(aggregate.overview.exposedStackCount).toBe(1);
    expect(aggregate.overview.unknownExposureStackCount).toBe(1);
  });
});

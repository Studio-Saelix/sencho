/**
 * Read-only detection of tunnel and private-overlay exposure (Cloudflare Tunnel,
 * Tailscale, WireGuard) from the rendered effective model. Tunnels publish no
 * host ports, so the port-based exposure facts alone report a tunnel-reached
 * service as internal. This module finds the tunnel connectors in a stack and
 * the services each one can reach, and says how sure that reach is.
 *
 * Signals are structural only: the image name, environment KEY names,
 * `cap_add`, `devices`, bind-mount targets, `network_mode`, and shared
 * networks. No environment value, label value, command argument, or file
 * content is read, so a tunnel token can never reach a finding or a log.
 *
 * Which services a connector actually routes to is configured outside the
 * Compose file (Cloudflare ingress rules, Tailscale Serve and ACLs, WireGuard
 * AllowedIPs). Only a shared network namespace proves the reach; a shared
 * network means the connector can reach the service, with routing unverified.
 */
import type { EffService, EffectiveModel } from '../preflight/effectiveModel';
import { SENCHO_MESH_NETWORK } from '../MeshComposeOverride';

export type TunnelProvider = 'cloudflared' | 'tailscale' | 'wireguard';

/** Who can reach a tunnel-exposed service: anyone through a provider's public
 *  edge, or only identified peers of a private overlay. */
export type TunnelScope = 'public-edge' | 'private-overlay';

/** How a connector reaches a service. `shared-namespace`: the two share one
 *  network namespace (`network_mode: service:<x>`), so the reach is certain.
 *  `shared-network`: they share a Compose network, so the connector can reach
 *  the service but whether it routes to it is configured elsewhere. */
export type TunnelPath = 'shared-namespace' | 'shared-network';

export interface TunnelReach {
  service: string;
  path: TunnelPath;
  /** Network keys shared with the connector (empty for `shared-namespace`). */
  networks: string[];
}

export interface TunnelConnector {
  /** Compose service running the tunnel connector. */
  service: string;
  provider: TunnelProvider;
  scope: TunnelScope;
  /** Structural evidence that identified the connector: `image`, `env:<KEY>`,
   *  `cap:NET_ADMIN`, `device:/dev/net/tun`, `udp-port`. Never a value. */
  signals: string[];
  /** Cloudflare Tunnel only: a cloudflared config directory is mounted, so the
   *  ingress rules live in a local file rather than in Cloudflare. */
  localConfig: boolean;
  /** Tailscale only: `TS_SERVE_CONFIG` is set, so Serve or Funnel may publish
   *  services, and Funnel makes them public. */
  serveConfig: boolean;
  /** The connector is attached to the Sencho Mesh network, so it may also route
   *  to services on other nodes through Mesh aliases, which Sencho cannot see. */
  meshAttached: boolean;
  reaches: TunnelReach[];
}

/** The strongest tunnel path to one service, for exposure descriptors. */
export interface ServiceTunnelExposure {
  connector: string;
  provider: TunnelProvider;
  scope: TunnelScope;
  path: TunnelPath;
}

export const TUNNEL_PROVIDER_LABEL: Record<TunnelProvider, string> = {
  cloudflared: 'Cloudflare Tunnel',
  tailscale: 'Tailscale',
  wireguard: 'WireGuard',
};

const PROVIDER_SCOPE: Record<TunnelProvider, TunnelScope> = {
  cloudflared: 'public-edge',
  tailscale: 'private-overlay',
  wireguard: 'private-overlay',
};

/** Image repository base names, matched against the last path segment. */
const IMAGE_PROVIDER: Record<string, TunnelProvider> = {
  cloudflared: 'cloudflared',
  tailscale: 'tailscale',
  'wg-easy': 'wireguard',
  wireguard: 'wireguard',
};

/** Environment key names that identify a provider on their own (custom images). */
const ENV_PROVIDER: Record<string, TunnelProvider> = {
  TUNNEL_TOKEN: 'cloudflared',
  TS_AUTHKEY: 'tailscale',
  TS_AUTH_KEY: 'tailscale',
  WG_HOST: 'wireguard',
};

/** Supporting environment key names, reported as signals once a provider is known. */
const ENV_HINTS: Record<TunnelProvider, readonly string[]> = {
  cloudflared: ['TUNNEL_TOKEN', 'TUNNEL_TOKEN_FILE'],
  tailscale: ['TS_AUTHKEY', 'TS_AUTH_KEY', 'TS_ROUTES', 'TS_SERVE_CONFIG', 'TS_STATE_DIR', 'TS_EXTRA_ARGS'],
  wireguard: ['WG_HOST', 'PEERS', 'SERVERURL', 'SERVERPORT'],
};

/** WireGuard keys that mark a server (peers dial in). Without one, a generic
 *  `wireguard` image is most often an outbound VPN client, which exposes nothing. */
const WIREGUARD_SERVER_KEYS = ['WG_HOST', 'PEERS', 'SERVERURL', 'SERVERPORT'];

/** Last path segment of an image reference, without tag or digest, lowercased. */
export function imageBaseName(image: string): string {
  const noDigest = image.toLowerCase().split('@')[0];
  const lastSegment = noDigest.slice(noDigest.lastIndexOf('/') + 1);
  const colon = lastSegment.indexOf(':');
  return colon === -1 ? lastSegment : lastSegment.slice(0, colon);
}

function providerOf(svc: EffService): { provider: TunnelProvider; byImage: boolean } | null {
  const fromImage = svc.image ? IMAGE_PROVIDER[imageBaseName(svc.image)] : undefined;
  if (fromImage) return { provider: fromImage, byImage: true };
  for (const key of svc.envKeys) {
    const fromEnv = ENV_PROVIDER[key];
    if (fromEnv) return { provider: fromEnv, byImage: false };
  }
  return null;
}

function isWireguardServer(svc: EffService, byImage: boolean): boolean {
  if (svc.image && imageBaseName(svc.image) === 'wg-easy') return true;
  if (!byImage) return true; // identified by WG_HOST, a server-only key
  return svc.envKeys.some(k => WIREGUARD_SERVER_KEYS.includes(k))
    || svc.ports.some(p => p.protocol === 'udp');
}

function signalsOf(svc: EffService, provider: TunnelProvider, byImage: boolean): string[] {
  const signals: string[] = [];
  if (byImage) signals.push('image');
  for (const key of ENV_HINTS[provider]) if (svc.envKeys.includes(key)) signals.push(`env:${key}`);
  if ((svc.capAdd ?? []).some(c => c.toUpperCase().replace(/^CAP_/, '') === 'NET_ADMIN')) signals.push('cap:NET_ADMIN');
  if ((svc.devices ?? []).includes('/dev/net/tun')) signals.push('device:/dev/net/tun');
  if (provider === 'wireguard' && svc.ports.some(p => p.protocol === 'udp')) signals.push('udp-port');
  return signals;
}

function hasCloudflaredConfigMount(svc: EffService): boolean {
  return svc.binds.some(b => /(^|\/)\.?cloudflared(\/|$)/.test(b.target));
}

const SERVICE_MODE = /^service:(.+)$/;

/** The service whose network namespace `name` runs in (itself when it owns one). */
function namespaceRoot(name: string, byName: Map<string, EffService>): string {
  let current = name;
  for (let hops = 0; hops < byName.size; hops += 1) {
    const target = byName.get(current)?.networkMode?.match(SERVICE_MODE)?.[1];
    if (!target || !byName.has(target)) return current;
    current = target;
  }
  return current;
}

/** Network keys a namespace owner joins; none when it uses host, none, or a container namespace. */
function networksOf(owner: EffService | undefined): string[] {
  if (!owner) return [];
  if (owner.networkMode !== undefined && owner.networkMode !== '' && owner.networkMode !== 'bridge') return [];
  return owner.networks.length > 0 ? owner.networks.map(n => n.key) : ['default'];
}

/** Whether the provider can carry traffic to services beyond its own namespace. */
function reachesSharedNetworks(connector: EffService, provider: TunnelProvider): boolean {
  if (provider !== 'tailscale') return true;
  // A Tailscale node only forwards to other containers as a subnet router or
  // through Serve; otherwise tailnet peers reach the node itself.
  return connector.envKeys.includes('TS_ROUTES') || connector.envKeys.includes('TS_SERVE_CONFIG');
}

/** Detect every tunnel connector in the model and the services it reaches. */
export function detectTunnels(model: EffectiveModel): TunnelConnector[] {
  const byName = new Map(model.services.map(s => [s.name, s]));
  const connectors: TunnelConnector[] = [];

  for (const svc of model.services) {
    const match = providerOf(svc);
    if (!match) continue;
    const { provider, byImage } = match;
    if (provider === 'wireguard' && !isWireguardServer(svc, byImage)) continue;

    const root = namespaceRoot(svc.name, byName);
    const connectorNetworks = new Set(networksOf(byName.get(root)));
    const networkReach = reachesSharedNetworks(svc, provider);
    const reaches: TunnelReach[] = [];

    for (const other of model.services) {
      if (other.name === svc.name) continue;
      const otherRoot = namespaceRoot(other.name, byName);
      if (otherRoot === root) {
        reaches.push({ service: other.name, path: 'shared-namespace', networks: [] });
        continue;
      }
      if (!networkReach) continue;
      const shared = networksOf(byName.get(otherRoot)).filter(key => connectorNetworks.has(key));
      if (shared.length > 0) reaches.push({ service: other.name, path: 'shared-network', networks: shared });
    }

    connectors.push({
      service: svc.name,
      provider,
      scope: PROVIDER_SCOPE[provider],
      signals: signalsOf(svc, provider, byImage),
      localConfig: provider === 'cloudflared' && hasCloudflaredConfigMount(svc),
      serveConfig: provider === 'tailscale' && svc.envKeys.includes('TS_SERVE_CONFIG'),
      meshAttached: [...connectorNetworks].some(key => model.networks[key]?.name === SENCHO_MESH_NETWORK),
      reaches,
    });
  }

  return connectors;
}

function strength(e: ServiceTunnelExposure): number {
  return (e.path === 'shared-namespace' ? 2 : 0) + (e.scope === 'public-edge' ? 1 : 0);
}

/** The strongest tunnel path to each reached service: a certain reach beats an
 *  unverified one, and a public edge beats a private overlay. */
export function tunnelExposureByService(connectors: TunnelConnector[]): Map<string, ServiceTunnelExposure> {
  const out = new Map<string, ServiceTunnelExposure>();
  for (const c of connectors) {
    for (const r of c.reaches) {
      const candidate: ServiceTunnelExposure = { connector: c.service, provider: c.provider, scope: c.scope, path: r.path };
      const current = out.get(r.service);
      if (!current || strength(candidate) > strength(current)) out.set(r.service, candidate);
    }
  }
  return out;
}

/** Who can reach a service through this connector, in one phrase. */
export function tunnelScopePhrase(provider: TunnelProvider): string {
  switch (provider) {
    case 'cloudflared': return 'anyone on the internet through Cloudflare\'s edge';
    case 'tailscale': return 'devices on the tailnet';
    case 'wireguard': return 'WireGuard peers';
  }
}

/** What Sencho cannot see about this connector's routing, in one sentence. */
export function tunnelUnverifiedSentence(c: Pick<TunnelConnector, 'provider' | 'localConfig' | 'serveConfig' | 'meshAttached'>): string {
  const parts: string[] = [];
  switch (c.provider) {
    case 'cloudflared':
      parts.push(c.localConfig
        ? 'Which services it routes to is set by the ingress rules in the mounted cloudflared config, which Sencho does not read.'
        : 'Which services it routes to is set by the tunnel\'s ingress rules in Cloudflare, which Sencho cannot see.');
      break;
    case 'tailscale':
      parts.push(c.serveConfig
        ? 'Which services it forwards to is set by its Serve config and tailnet ACLs, which Sencho does not read; if Funnel is on, those services are public.'
        : 'Who can connect is set by tailnet ACLs, which Sencho cannot see.');
      break;
    case 'wireguard':
      parts.push('What peers can reach is set by their AllowedIPs and the server\'s forwarding rules, which Sencho does not read.');
      break;
  }
  if (c.meshAttached) {
    parts.push('It is also on the Sencho Mesh network, so it may route to services on other nodes through Mesh aliases; those are not shown here.');
  }
  return parts.join(' ');
}

function quotedList(names: string[]): string {
  const quoted = names.map(n => `"${n}"`);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** Title and message for one connector, shared by Compose Doctor and the
 *  Networking findings so the two read the same. */
export function describeTunnelConnector(c: TunnelConnector): { title: string; message: string } {
  const label = TUNNEL_PROVIDER_LABEL[c.provider];
  const scope = c.scope === 'public-edge' ? 'public edge' : 'private overlay';
  const certain = c.reaches.filter(r => r.path === 'shared-namespace').map(r => r.service);
  const candidates = c.reaches.filter(r => r.path === 'shared-network').map(r => r.service);
  const sentences = [`Service "${c.service}" runs a ${label} connector (${scope}), which opens what it reaches to ${tunnelScopePhrase(c.provider)}.`];
  if (certain.length > 0) {
    sentences.push(`${quotedList(certain)} ${certain.length > 1 ? 'share' : 'shares'} its network namespace, so ${certain.length > 1 ? 'they are' : 'it is'} reachable through it.`);
  }
  if (candidates.length > 0) {
    sentences.push(`${quotedList(candidates)} ${candidates.length > 1 ? 'share' : 'shares'} a network with it and can be reached if its routing points there.`);
  }
  if (c.reaches.length === 0) sentences.push('No other service in this stack is reachable through it.');
  sentences.push(tunnelUnverifiedSentence(c));
  return { title: `${label} connector "${c.service}" (${scope})`, message: sentences.join(' ') };
}

/** One sentence naming the tunnel path to a service, for exposure findings. */
export function describeServiceTunnel(e: ServiceTunnelExposure): string {
  const label = TUNNEL_PROVIDER_LABEL[e.provider];
  return e.path === 'shared-namespace'
    ? `It shares the network namespace of the ${label} connector "${e.connector}", so ${tunnelScopePhrase(e.provider)} can reach it.`
    : `It shares a network with the ${label} connector "${e.connector}", so ${tunnelScopePhrase(e.provider)} can reach it if the tunnel routes there; that routing is unverified.`;
}

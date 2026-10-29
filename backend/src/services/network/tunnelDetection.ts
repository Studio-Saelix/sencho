/**
 * Read-only detection of tunnel and private-overlay exposure (Cloudflare Tunnel,
 * Tailscale, WireGuard) from a stack's Compose model. Tunnels publish no host
 * ports, so the port-based exposure facts alone report a tunnel-reached service
 * as internal. This module finds the tunnel connectors in a stack and the
 * services each one can reach, and says how sure that reach is.
 *
 * Signals are structural only: the image name, environment KEY names,
 * `cap_add`, `devices`, bind-mount targets, `network_mode`, network membership,
 * published-port protocols, and whether `command`/`entrypoint` name one of a
 * fixed set of cloudflared subcommands. No environment value, label value,
 * other command argument, or file content is read, so a tunnel token can never
 * reach a finding or a log.
 *
 * Which services a connector actually routes to is configured outside the
 * Compose file (Cloudflare ingress rules, Tailscale Serve and ACLs, WireGuard
 * AllowedIPs). Only a shared network namespace makes the reach certain; a
 * shared network or the host network means the connector can reach the
 * service, with routing unverified. Reach is computed within one stack: a
 * connector on an external network or the Sencho Mesh network may also reach
 * services elsewhere, which is reported as unknown rather than guessed.
 */
import { SENCHO_MESH_NETWORK } from '../MeshComposeOverride';

export type TunnelProvider = 'cloudflared' | 'tailscale' | 'wireguard';

/** Who can reach a tunnel-exposed service: anyone through a provider's public
 *  edge, or only identified peers of a private overlay. */
export type TunnelScope = 'public-edge' | 'private-overlay';

/** How a connector reaches a service. `shared-namespace`: the two share one
 *  network namespace (`network_mode: service:<x>`), so the service is reachable
 *  at the connector's own address and the reach is certain. `shared-network`:
 *  they share a Compose network. `host-network`: the connector uses the host
 *  network and the service publishes a host port. For the last two the
 *  connector can reach the service, but whether it routes to it is configured
 *  elsewhere. */
export type TunnelPath = 'shared-namespace' | 'shared-network' | 'host-network';

export interface TunnelReach {
  service: string;
  path: TunnelPath;
  /** Network keys shared with the connector (empty unless `shared-network`). */
  networks: string[];
}

/** How the connector is attached: to the stack's networks, to the host network,
 *  or to another container's namespace (`container:<x>`, `none`), whose reach
 *  Sencho cannot see. */
export type TunnelAttachment = 'networks' | 'host' | 'other';

export interface TunnelConnector {
  /** Compose service running the tunnel connector. */
  service: string;
  provider: TunnelProvider;
  scope: TunnelScope;
  attachment: TunnelAttachment;
  /** Structural evidence that identified the connector: `image`, `env:<KEY>`,
   *  `cap:NET_ADMIN`, `device:/dev/net/tun`, `udp-port`. Never a value. */
  signals: string[];
  /** Cloudflare Tunnel only: a cloudflared config directory is mounted, so the
   *  ingress rules live in a local file rather than in Cloudflare. */
  localConfig: boolean;
  /** Tailscale only: `TS_SERVE_CONFIG` is set, so Serve or Funnel may publish
   *  services, and Funnel makes them public. */
  serveConfig: boolean;
  /** The connector is on the Sencho Mesh network (declared in Compose, or added
   *  by the stack's Mesh opt-in), so it may also route to services on other
   *  nodes through Mesh aliases, which Sencho cannot see. */
  meshAttached: boolean;
  /** External networks (resolved names, Mesh excluded) the connector joins;
   *  services of other stacks on them may also be reachable. */
  externalNetworks: string[];
  reaches: TunnelReach[];
}

/** The strongest tunnel path to one service, for exposure descriptors. */
export interface ServiceTunnelExposure {
  connector: string;
  provider: TunnelProvider;
  scope: TunnelScope;
  path: TunnelPath;
}

/** The structural fields detection reads from one service. The effective model
 *  (`EffService`) and the light dependency parse both provide them. */
export interface TunnelDetectionService {
  name: string;
  image?: string;
  envKeys: string[];
  networkMode?: string;
  networks: { key: string }[];
  ports: { protocol: string }[];
  binds?: { target: string }[];
  capAdd?: string[];
  devices?: string[];
  /** Fixed cloudflared subcommands named by `command`/`entrypoint` (see `cloudflaredCommandHints`). */
  commandHints?: string[];
}

export interface TunnelDetectionModel {
  services: TunnelDetectionService[];
  networks: Record<string, { name?: string; external?: boolean }>;
}

export interface TunnelDetectionOptions {
  /** The stack is opted into Sencho Mesh, so every service without a
   *  `network_mode` joins the Mesh network at deploy. */
  meshManaged?: boolean;
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
  TUNNEL_TOKEN_FILE: 'cloudflared',
  TS_AUTHKEY: 'tailscale',
  TS_AUTH_KEY: 'tailscale',
  WG_HOST: 'wireguard',
};

/** Supporting environment key names, reported as signals once a provider is known. */
const ENV_HINTS: Record<TunnelProvider, readonly string[]> = {
  cloudflared: ['TUNNEL_TOKEN', 'TUNNEL_TOKEN_FILE'],
  tailscale: ['TS_AUTHKEY', 'TS_AUTH_KEY', 'TS_ROUTES', 'TS_SERVE_CONFIG', 'TS_DEST_IP', 'TS_EXTRA_ARGS', 'TS_STATE_DIR'],
  wireguard: ['WG_HOST', 'PEERS', 'SERVERURL', 'SERVERPORT'],
};

/** WireGuard keys that mark a server (peers dial in). Without one, a generic
 *  `wireguard` image is most often an outbound VPN client, which exposes nothing. */
const WIREGUARD_SERVER_KEYS = ['WG_HOST', 'PEERS', 'SERVERURL', 'SERVERPORT'];

/** Tailscale keys under which a node may forward to other containers (subnet
 *  routes, Serve, a destination IP, or flags passed through `TS_EXTRA_ARGS`).
 *  Without one, tailnet peers reach the Tailscale node itself. */
const TAILSCALE_FORWARD_KEYS = ['TS_ROUTES', 'TS_SERVE_CONFIG', 'TS_DEST_IP', 'TS_EXTRA_ARGS'];

/** cloudflared subcommands Sencho recognizes in `command`/`entrypoint`. */
const CLOUDFLARED_SUBCOMMANDS: ReadonlySet<string> = new Set(['tunnel', 'proxy-dns', 'access']);

/** Last path segment of an image reference, without tag or digest, lowercased. */
export function imageBaseName(image: string): string {
  const noDigest = image.toLowerCase().split('@')[0];
  const lastSegment = noDigest.slice(noDigest.lastIndexOf('/') + 1);
  const colon = lastSegment.indexOf(':');
  return colon === -1 ? lastSegment : lastSegment.slice(0, colon);
}

/**
 * The cloudflared subcommands (`tunnel`, `proxy-dns`, `access`) a service's
 * `command`/`entrypoint` name, so a DNS proxy or an access client is not taken
 * for a tunnel. Only membership in that fixed set is kept; every other token,
 * including any `--token` value, is discarded.
 */
export function cloudflaredCommandHints(command: unknown, entrypoint: unknown): string[] {
  const hints = new Set<string>();
  for (const source of [command, entrypoint]) {
    const parts = Array.isArray(source) ? source : [source];
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      for (const token of part.split(/\s+/)) if (CLOUDFLARED_SUBCOMMANDS.has(token)) hints.add(token);
    }
  }
  return [...hints];
}

function providerOf(svc: TunnelDetectionService): { provider: TunnelProvider; byImage: boolean } | null {
  const fromImage = svc.image ? IMAGE_PROVIDER[imageBaseName(svc.image)] : undefined;
  if (fromImage) return { provider: fromImage, byImage: true };
  for (const key of svc.envKeys) {
    const fromEnv = ENV_PROVIDER[key];
    if (fromEnv) return { provider: fromEnv, byImage: false };
  }
  return null;
}

function hasCloudflaredConfigMount(svc: TunnelDetectionService): boolean {
  return (svc.binds ?? []).some(b => /(^|\/)\.?cloudflared(\/|$)/.test(b.target));
}

/** Whether the matched service actually exposes something. A WireGuard client,
 *  a cloudflared DNS proxy (`proxy-dns`, or `TUNNEL_DNS_*` settings), and a
 *  cloudflared `access` client all connect outward only. */
function isExposingConnector(svc: TunnelDetectionService, provider: TunnelProvider, byImage: boolean): boolean {
  if (provider === 'wireguard') {
    if (svc.image && imageBaseName(svc.image) === 'wg-easy') return true;
    if (!byImage) return true; // identified by WG_HOST, a server-only key
    return svc.envKeys.some(k => WIREGUARD_SERVER_KEYS.includes(k)) || svc.ports.some(p => p.protocol === 'udp');
  }
  if (provider === 'cloudflared') {
    const hints = svc.commandHints ?? [];
    const tunnelSignal = hints.includes('tunnel') || hasCloudflaredConfigMount(svc)
      || svc.envKeys.some(k => k === 'TUNNEL_TOKEN' || k === 'TUNNEL_TOKEN_FILE');
    const clientOnly = hints.includes('proxy-dns') || hints.includes('access')
      || svc.envKeys.some(k => k.startsWith('TUNNEL_DNS'));
    return tunnelSignal || !clientOnly;
  }
  return true;
}

function signalsOf(svc: TunnelDetectionService, provider: TunnelProvider, byImage: boolean): string[] {
  const signals: string[] = [];
  if (byImage) signals.push('image');
  for (const key of ENV_HINTS[provider]) if (svc.envKeys.includes(key)) signals.push(`env:${key}`);
  if ((svc.capAdd ?? []).some(c => c.toUpperCase().replace(/^CAP_/, '') === 'NET_ADMIN')) signals.push('cap:NET_ADMIN');
  if ((svc.devices ?? []).includes('/dev/net/tun')) signals.push('device:/dev/net/tun');
  if (provider === 'wireguard' && svc.ports.some(p => p.protocol === 'udp')) signals.push('udp-port');
  return signals;
}

const SERVICE_MODE = /^service:(.+)$/;

/** The service whose network namespace `name` runs in (itself when it owns one). */
function namespaceRoot(name: string, byName: Map<string, TunnelDetectionService>): string {
  let current = name;
  for (let hops = 0; hops < byName.size; hops += 1) {
    const target = byName.get(current)?.networkMode?.match(SERVICE_MODE)?.[1];
    if (!target || !byName.has(target)) return current;
    current = target;
  }
  return current;
}

function attachmentOf(owner: TunnelDetectionService | undefined): TunnelAttachment {
  const mode = owner?.networkMode;
  if (mode === undefined || mode === '' || mode === 'bridge') return 'networks';
  return mode === 'host' ? 'host' : 'other';
}

/** Network keys a namespace owner joins (Compose's implicit `default` when it lists none). */
function networksOf(owner: TunnelDetectionService | undefined): string[] {
  if (!owner || attachmentOf(owner) !== 'networks') return [];
  return owner.networks.length > 0 ? owner.networks.map(n => n.key) : ['default'];
}

/** Whether the provider can carry traffic to services beyond its own namespace. */
function forwardsBeyondNamespace(connector: TunnelDetectionService, provider: TunnelProvider): boolean {
  if (provider !== 'tailscale') return true;
  return connector.envKeys.some(k => TAILSCALE_FORWARD_KEYS.includes(k));
}

/** Detect every tunnel connector in the model and the services it reaches. */
export function detectTunnels(model: TunnelDetectionModel, options: TunnelDetectionOptions = {}): TunnelConnector[] {
  const byName = new Map(model.services.map(s => [s.name, s]));
  const connectors: TunnelConnector[] = [];

  for (const svc of model.services) {
    const match = providerOf(svc);
    if (!match) continue;
    const { provider, byImage } = match;
    if (!isExposingConnector(svc, provider, byImage)) continue;

    const root = namespaceRoot(svc.name, byName);
    const owner = byName.get(root);
    const attachment = attachmentOf(owner);
    const connectorNetworks = new Set(networksOf(owner));
    const forwards = forwardsBeyondNamespace(svc, provider);
    const reaches: TunnelReach[] = [];

    for (const other of model.services) {
      if (other.name === svc.name) continue;
      const otherRoot = namespaceRoot(other.name, byName);
      if (otherRoot === root) {
        reaches.push({ service: other.name, path: 'shared-namespace', networks: [] });
        continue;
      }
      if (!forwards) continue;
      if (attachment === 'host') {
        if (other.ports.length > 0) reaches.push({ service: other.name, path: 'host-network', networks: [] });
        continue;
      }
      const shared = networksOf(byName.get(otherRoot)).filter(key => connectorNetworks.has(key));
      if (shared.length > 0) reaches.push({ service: other.name, path: 'shared-network', networks: shared });
    }

    const networkName = (key: string) => model.networks[key]?.name ?? key;
    const keys = [...connectorNetworks];
    connectors.push({
      service: svc.name,
      provider,
      scope: PROVIDER_SCOPE[provider],
      attachment,
      signals: signalsOf(svc, provider, byImage),
      localConfig: provider === 'cloudflared' && hasCloudflaredConfigMount(svc),
      serveConfig: provider === 'tailscale' && svc.envKeys.includes('TS_SERVE_CONFIG'),
      meshAttached: keys.some(key => networkName(key) === SENCHO_MESH_NETWORK)
        || (options.meshManaged === true && attachment === 'networks'),
      externalNetworks: keys
        .filter(key => model.networks[key]?.external === true && networkName(key) !== SENCHO_MESH_NETWORK)
        .map(networkName),
      reaches,
    });
  }

  return connectors;
}

/** Ranks a path by certainty first (a shared namespace), then by audience (a
 *  public edge over a private overlay). */
function strength(e: ServiceTunnelExposure): number {
  return (e.path === 'shared-namespace' ? 2 : 0) + (e.scope === 'public-edge' ? 1 : 0);
}

/** The strongest tunnel path to each reached service: a certain reach beats an
 *  unverified one, and a public edge beats a private overlay. Each connector's
 *  own finding still lists every service it reaches. */
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
    case 'cloudflared': return 'anyone on the internet through Cloudflare\'s edge, unless Cloudflare Access restricts it';
    case 'tailscale': return 'devices on the tailnet';
    case 'wireguard': return 'WireGuard peers';
  }
}

/** What Sencho cannot see about this connector's routing, in one or more sentences. */
export function tunnelUnverifiedSentence(c: Pick<TunnelConnector, 'provider' | 'localConfig' | 'serveConfig' | 'meshAttached' | 'externalNetworks'>): string {
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
        : 'Who can connect is set by tailnet ACLs, and any routes it advertises are set in values Sencho does not read.');
      break;
    case 'wireguard':
      parts.push('What peers can reach is set by their AllowedIPs and the server\'s forwarding rules, which Sencho does not read.');
      break;
  }
  if (c.externalNetworks.length > 0) {
    parts.push(`It is also on the external network${c.externalNetworks.length > 1 ? 's' : ''} ${quotedList(c.externalNetworks)}, so services of other stacks on ${c.externalNetworks.length > 1 ? 'those networks' : 'that network'} may be reachable through it; those are not shown here.`);
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

function shareVerb(names: string[]): { verb: string; they: string } {
  return names.length > 1 ? { verb: 'share', they: 'they are' } : { verb: 'shares', they: 'it is' };
}

/** Why no other service in the stack shows up as reached, in one sentence. */
function emptyReachSentence(c: TunnelConnector): string {
  if (c.attachment === 'other') return 'It runs in another container\'s network namespace, so Sencho cannot see which services it reaches.';
  if (c.attachment === 'host') return 'It uses the host network, so it can reach any port published on the host; no other service in this stack publishes one.';
  if (c.provider === 'tailscale') return 'Tailnet peers reach the Tailscale node itself; no other service in this stack shares its network namespace.';
  return 'No other service in this stack shares its network namespace or a network with it.';
}

/** Title and message for one connector, shared by Compose Doctor and the
 *  Networking findings so the two read the same. */
export function describeTunnelConnector(c: TunnelConnector): { title: string; message: string } {
  const label = TUNNEL_PROVIDER_LABEL[c.provider];
  const scope = c.scope === 'public-edge' ? 'public edge' : 'private overlay';
  const byPath = (path: TunnelPath) => c.reaches.filter(r => r.path === path).map(r => r.service);
  const certain = byPath('shared-namespace');
  const networked = byPath('shared-network');
  const hosted = byPath('host-network');
  const sentences = [`Service "${c.service}" runs a ${label} connector (${scope}), which opens what it reaches to ${tunnelScopePhrase(c.provider)}.`];
  if (certain.length > 0) {
    const { verb, they } = shareVerb(certain);
    sentences.push(`${quotedList(certain)} ${verb} its network namespace, so ${they} reachable at the connector's own address.`);
  }
  if (networked.length > 0) {
    sentences.push(`${quotedList(networked)} ${shareVerb(networked).verb} a network with it and can be reached if its routing points there.`);
  }
  if (hosted.length > 0) {
    sentences.push(`${quotedList(hosted)} ${hosted.length > 1 ? 'publish' : 'publishes'} a host port it can reach over the host network if its routing points there.`);
  }
  if (c.reaches.length === 0) sentences.push(emptyReachSentence(c));
  sentences.push(tunnelUnverifiedSentence(c));
  return { title: `${label} connector "${c.service}" (${scope})`, message: sentences.join(' ') };
}

/** One sentence naming the tunnel path to a service, for exposure findings. */
export function describeServiceTunnel(e: ServiceTunnelExposure): string {
  const label = TUNNEL_PROVIDER_LABEL[e.provider];
  switch (e.path) {
    case 'shared-namespace':
      return `It shares the network namespace of the ${label} connector "${e.connector}", so ${tunnelScopePhrase(e.provider)} can reach it.`;
    case 'shared-network':
      return `It shares a network with the ${label} connector "${e.connector}", so ${tunnelScopePhrase(e.provider)} can reach it if the tunnel routes there; that routing is unverified.`;
    case 'host-network':
      return `It publishes a host port that the ${label} connector "${e.connector}" can reach over the host network, so ${tunnelScopePhrase(e.provider)} can reach it if the tunnel routes there; that routing is unverified.`;
  }
}

/** True when the reach is certain (a shared namespace); every other path is unverified. */
export function isCertainTunnelPath(path: TunnelPath): boolean {
  return path === 'shared-namespace';
}

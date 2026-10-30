/**
 * Read-only detection of tunnel and private-overlay exposure (Cloudflare Tunnel,
 * Tailscale, WireGuard) from a stack's Compose model. Tunnels publish no host
 * ports, so the port-based exposure facts alone report a tunnel-reached service
 * as internal. This module finds the tunnel connectors in a stack and the
 * services each one can reach, and says how sure that reach is.
 *
 * Signals are structural only: the image name, environment KEY names,
 * `cap_add`, `devices`, bind-mount targets, `network_mode`, network membership,
 * whether a service publishes ports and their protocols, whether
 * `command`/`entrypoint` name one of a fixed set of cloudflared subcommands, and
 * whether `TS_EXTRA_ARGS` names one of two Tailscale forwarding flags. Command
 * tokens and that one value are scanned for those fixed names and nothing else
 * is kept. The detector is handed environment KEY names and that one value; it
 * reads no other environment value, label value, or file content. (The node
 * summary parses a service's env files and interpolates the other fields with
 * the stack's interpolation environment to supply them, and keeps none of it.)
 * A tunnel token therefore never reaches a finding or a log.
 *
 * Which services a connector actually routes to is configured outside the
 * Compose file (Cloudflare ingress rules, Tailscale Serve and ACLs, WireGuard
 * AllowedIPs). A shared network namespace makes the reach locally certain: a
 * Tailscale or WireGuard peer reaches the service at the connector's own
 * address. A cloudflared sidecar reaches the service on localhost too, but
 * Cloudflare's ingress independently chooses which origin and port an incoming
 * request reaches, and Sencho cannot read those rules, so that path stays
 * unverified like a shared network or the host network. Reach is computed
 * within one stack: a connector on an external network or the Sencho Mesh
 * network may also reach services elsewhere, which is reported as unknown
 * rather than guessed.
 */
import { SENCHO_MESH_NETWORK } from '../MeshComposeOverride';
import { ComposeEnvFileError, expandComposeEnvTemplate, type ComposeEnvLookup } from '../../utils/composeDotenv';

export type TunnelProvider = 'cloudflared' | 'tailscale' | 'wireguard';

/** Who can reach a tunnel-exposed service: anyone through a provider's public
 *  edge, or only identified peers of a private overlay. */
export type TunnelScope = 'public-edge' | 'private-overlay';

/** How a connector reaches a service. `shared-namespace`: the two share one
 *  network namespace (`network_mode: service:<x>`), so the service listens on
 *  the connector's own address: Tailscale and WireGuard peers reach it
 *  directly. A cloudflared sidecar reaches it on localhost, but Cloudflare's
 *  ingress still decides what an incoming request reaches, so that path is
 *  locally reachable and unverified. `shared-network`: they share a Compose
 *  network, or both use Docker's default bridge (`network_mode: bridge` or
 *  `default`). `host-network`: the connector uses the host network and the
 *  service (or the service whose namespace it runs in) publishes a host port or
 *  is itself on the host network. For the last two the connector can reach the
 *  service, but whether it routes to it is configured elsewhere. */
export type TunnelPath = 'shared-namespace' | 'shared-network' | 'host-network';

export interface TunnelReach {
  service: string;
  path: TunnelPath;
  /** Network keys shared with the connector (empty unless `shared-network`).
   *  Docker's default bridge appears as `DEFAULT_BRIDGE_KEY`, which no stack
   *  network key can equal. */
  networks: string[];
}

/** How the connector is attached: to the stack's networks (`network_mode:
 *  bridge` or `default` counts here but joins only Docker's default bridge, shared with
 *  other bridge-mode services and none of the stack's networks), to the host
 *  network, or to another container's namespace
 *  (`container:<x>`), whose reach Sencho cannot see. A connector with
 *  `network_mode: none` has no network and is not reported. */
export type TunnelAttachment = 'networks' | 'host' | 'other';

export interface TunnelConnector {
  /** Compose service running the tunnel connector. */
  service: string;
  provider: TunnelProvider;
  scope: TunnelScope;
  attachment: TunnelAttachment;
  /** Structural evidence that identified the connector: `image`, `env:<KEY>`,
   *  `cap:NET_ADMIN`, `device:/dev/net/tun`, `udp-port`, and for Tailscale
   *  `flag:<forwarding flag>` (see `TailscaleForwardFlag`). Never a value. */
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
  /** Tailscale forwarding flags named by `TS_EXTRA_ARGS` (see `tailscaleForwardFlags`). */
  tailscaleFlags?: TailscaleForwardFlag[];
}

export interface TunnelDetectionModel {
  services: TunnelDetectionService[];
  networks: Record<string, { name?: string; external?: boolean }>;
}

export interface TunnelDetectionOptions {
  /** The stack is opted into Sencho Mesh, so every service that declares no
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

/** Image repository base names, matched against the last path segment. A Map
 *  so an arbitrary image name can never resolve to an inherited property. */
const IMAGE_PROVIDER = new Map<string, TunnelProvider>([
  ['cloudflared', 'cloudflared'],
  ['tailscale', 'tailscale'],
  ['wg-easy', 'wireguard'],
  ['wireguard', 'wireguard'],
]);

/** Environment key names that identify a provider on their own (custom images).
 *  A Map for the same reason as `IMAGE_PROVIDER`. */
const ENV_PROVIDER = new Map<string, TunnelProvider>([
  ['TUNNEL_TOKEN', 'cloudflared'],
  ['TUNNEL_TOKEN_FILE', 'cloudflared'],
  ['TS_AUTHKEY', 'tailscale'],
  ['TS_AUTH_KEY', 'tailscale'],
  ['WG_HOST', 'wireguard'],
]);

/** Supporting environment key names, reported as signals once a provider is known. */
const ENV_HINTS: Record<TunnelProvider, readonly string[]> = {
  cloudflared: ['TUNNEL_TOKEN', 'TUNNEL_TOKEN_FILE'],
  tailscale: ['TS_AUTHKEY', 'TS_AUTH_KEY', 'TS_ROUTES', 'TS_SERVE_CONFIG', 'TS_DEST_IP', 'TS_EXTRA_ARGS', 'TS_STATE_DIR'],
  wireguard: ['WG_HOST', 'PEERS', 'SERVERURL', 'SERVERPORT'],
};

/** WireGuard keys that mark a server (peers dial in). Without one, a generic
 *  `wireguard` image is most often an outbound VPN client, which exposes nothing. */
const WIREGUARD_SERVER_KEYS = ['WG_HOST', 'PEERS', 'SERVERURL', 'SERVERPORT'];

/** Tailscale keys under which a node forwards to other containers (subnet
 *  routes, Serve, a destination IP). With none of them, and neither forwarding
 *  flag in `TS_EXTRA_ARGS`, a node on the stack's networks only exposes itself. */
const TAILSCALE_FORWARD_KEYS = ['TS_ROUTES', 'TS_SERVE_CONFIG', 'TS_DEST_IP'];

/** What `TS_EXTRA_ARGS` says about forwarding: a `tailscale up` flag that makes
 *  a node forward to other addresses, or `unresolved` when the value cannot be
 *  read, which is treated as forwarding: a key with no value or a `${VAR}` with
 *  no lookup to answer it, a value that is not a string, or a template Compose
 *  refuses (malformed, or a required `${VAR:?}` with no value). It is also added
 *  beside a named flag when a flag Sencho does not know leaves it unclear
 *  whether a later occurrence is a flag or that flag's value. */
export type TailscaleForwardFlag = '--advertise-routes' | '--advertise-exit-node' | 'unresolved';

const TAILSCALE_FORWARD_FLAGS: ReadonlySet<string> = new Set(['--advertise-routes', '--advertise-exit-node']);

function isTailscaleForwardFlag(name: string): name is Exclude<TailscaleForwardFlag, 'unresolved'> {
  return TAILSCALE_FORWARD_FLAGS.has(name);
}

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

/** Go's strconv.ParseBool spellings of false, which Tailscale's flag parser
 *  accepts for the boolean `--advertise-exit-node`. */
const GO_FALSE: ReadonlySet<string> = new Set(['0', 'f', 'F', 'false', 'FALSE', 'False']);

/** Expand a list entry the way Compose interpolates it, keeping it as written
 *  when no lookup is supplied or Compose would refuse the template. */
function interpolateTunnelEntry(value: string, lookup: ComposeEnvLookup | undefined): string {
  // Only an entry whose name is itself a template (`${ENTRY}`) is expanded here;
  // a plain `TS_EXTRA_ARGS=<value>` keeps its value for the single expansion in
  // `readableExtraArgs`, so a `$` the first pass produces is not expanded again.
  const name = value.split('=')[0];
  if (!lookup || !/\$(?:\{|\$|[A-Za-z_])/.test(name.replace(/\$\$/g, ''))) return value;
  try {
    return expandComposeEnvTemplate(value, lookup);
  } catch (error) {
    if (error instanceof ComposeEnvFileError) return value;
    throw error;
  }
}

/** `TS_EXTRA_ARGS` as text, or null when it cannot be read. A raw value that
 *  still holds `${VAR}`/`$VAR` is expanded with `lookup` the way Compose
 *  interpolates it; a key with no value takes the variable of the same name. */
function readableExtraArgs(value: unknown, lookup: ComposeEnvLookup | undefined): string | null {
  // A key with no value takes the variable of the same name, and Compose drops
  // it when the variable is unset: an answering lookup is the whole environment.
  if (value === undefined || value === null) return lookup ? lookup('TS_EXTRA_ARGS') ?? '' : null;
  if (typeof value !== 'string') return null;
  if (!/\$\{|\$[A-Za-z_]/.test(value.replace(/\$\$/g, ''))) return value;
  if (!lookup) return null;
  try {
    return expandComposeEnvTemplate(value, lookup);
  } catch (error) {
    // Compose refuses to render this template (a malformed reference or a
    // required variable with no value), so no flag can be read from it.
    if (error instanceof ComposeEnvFileError) return null;
    throw error;
  }
}

/**
 * The `tailscale up` flags that take no value argument (Go's `IsBoolFlag`), so
 * the token after one is always its own flag. `--host-routes` is hidden but
 * registered the same way.
 */
const TAILSCALE_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--accept-dns', '--accept-routes', '--advertise-connector', '--advertise-exit-node',
  '--exit-node-allow-lan-access', '--force-reauth', '--host-routes', '--json', '--qr',
  '--report-posture', '--reset', '--shields-up', '--snat-subnet-routes', '--ssh',
  '--stateful-filtering', '--unattended',
]);

/**
 * The `tailscale up` flags written without `=` that take the next token as
 * their value, even when it starts with a dash (Go's flag package). `--authkey`
 * is the pre-1.60 spelling of `--auth-key`.
 */
const TAILSCALE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--accept-risk', '--advertise-routes', '--advertise-tags', '--audience', '--auth-key',
  '--authkey', '--client-id', '--client-secret', '--exit-node', '--hostname', '--id-token',
  '--login-server', '--netfilter-mode', '--nickname', '--operator', '--qr-format', '--timeout',
]);

/**
 * The Tailscale forwarding flags (`--advertise-routes`, `--advertise-exit-node`,
 * in Go's single- or double-dash form) named in a service's `TS_EXTRA_ARGS`,
 * from list (`KEY=value`, last entry wins as in Compose) or map form. Go's flag
 * setters overwrite, so the last occurrence of a flag decides: a later empty
 * value, or `--advertise-exit-node` set to a Go spelling of false, turns an
 * earlier enabled occurrence off again. `--advertise-routes` takes a route
 * list, so such a spelling there is an invalid route that makes `tailscale up`
 * fail, which forwards nothing either.
 * A flag written without `=` takes the next token as its value unless it is a
 * boolean, so that token is not a flag. Sencho knows `tailscale up`'s flags;
 * after a flag it does not know, the next token may be either, so a forwarding
 * occurrence there that would change the result adds `unresolved` (forwarding,
 * like every value it cannot read) instead of being decided by guesswork.
 * `lookup` expands an uninterpolated value (the raw YAML) and, when given, is
 * the complete variable environment: a `TS_EXTRA_ARGS` key it does not answer
 * is unset and names no flag. Without it, or when the value still cannot be
 * read, the result is `unresolved`. Only membership in that fixed set is kept;
 * the routes and every other flag are discarded.
 */
export function tailscaleForwardFlags(environment: unknown, lookup?: ComposeEnvLookup): TailscaleForwardFlag[] {
  let present = false;
  let value: unknown;
  if (Array.isArray(environment)) {
    const entries = environment
      .filter((e): e is string => typeof e === 'string')
      .map((entry) => interpolateTunnelEntry(entry, lookup));
    const entry = entries.filter((e) => e === 'TS_EXTRA_ARGS' || e.startsWith('TS_EXTRA_ARGS=')).pop();
    present = entry !== undefined;
    value = entry?.startsWith('TS_EXTRA_ARGS=') ? entry.slice('TS_EXTRA_ARGS='.length) : undefined;
  } else if (environment && typeof environment === 'object' && 'TS_EXTRA_ARGS' in environment) {
    present = true;
    value = (environment as Record<string, unknown>).TS_EXTRA_ARGS;
  }
  if (!present) return [];
  const text = readableExtraArgs(value, lookup);
  if (text === null) return ['unresolved'];
  const flags = new Map<Exclude<TailscaleForwardFlag, 'unresolved'>, boolean>();
  let ambiguous = false;
  // What the previous token, a flag written without `=`, makes of this one.
  let previous: 'flag' | 'value' | 'unknown' = 'flag';
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    const mayBeValue = previous === 'unknown';
    if (previous === 'value') {
      previous = 'flag';
      continue;
    }
    previous = 'flag';
    if (!token.startsWith('-')) continue;
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).replace(/^-{1,2}/, '--');
    if (eq === -1 && !TAILSCALE_BOOLEAN_FLAGS.has(name)) {
      previous = TAILSCALE_VALUE_FLAGS.has(name) ? 'value' : 'unknown';
    }
    if (!isTailscaleForwardFlag(name)) continue;
    const setting = eq === -1 ? undefined : token.slice(eq + 1);
    const enabled = setting !== '' && !(setting !== undefined && GO_FALSE.has(setting));
    if (mayBeValue && enabled !== (flags.get(name) === true)) ambiguous = true;
    if (enabled || !mayBeValue) flags.set(name, enabled);
  }
  const forwarding: TailscaleForwardFlag[] = [...flags].filter(([, enabled]) => enabled).map(([name]) => name);
  return ambiguous ? [...forwarding, 'unresolved'] : forwarding;
}

function providerOf(svc: TunnelDetectionService): { provider: TunnelProvider; byImage: boolean } | null {
  const fromImage = svc.image ? IMAGE_PROVIDER.get(imageBaseName(svc.image)) : undefined;
  if (fromImage) return { provider: fromImage, byImage: true };
  for (const key of svc.envKeys) {
    const fromEnv = ENV_PROVIDER.get(key);
    if (fromEnv) return { provider: fromEnv, byImage: false };
  }
  return null;
}

/** Compose lowercases a short-form protocol but keeps a long-form one as written. */
function isUdpPort(port: { protocol: string }): boolean {
  return port.protocol.toLowerCase() === 'udp';
}

function hasCloudflaredConfigMount(svc: TunnelDetectionService): boolean {
  return (svc.binds ?? []).some(b => /(^|\/)\.?cloudflared(\/|$)/.test(b.target));
}

/** Whether the matched service actually exposes something. A WireGuard client,
 *  a cloudflared DNS proxy (`proxy-dns`, or `TUNNEL_DNS_*` settings), and a
 *  cloudflared `access` client all connect outward only. An explicit
 *  subcommand is the strongest evidence; then a token or a mounted config. */
function isExposingConnector(svc: TunnelDetectionService, provider: TunnelProvider, byImage: boolean): boolean {
  if (provider === 'wireguard') {
    if (svc.image && imageBaseName(svc.image) === 'wg-easy') return true;
    if (!byImage) return true; // identified by WG_HOST, a server-only key
    return svc.envKeys.some(k => WIREGUARD_SERVER_KEYS.includes(k)) || svc.ports.some(isUdpPort);
  }
  if (provider === 'cloudflared') {
    const hints = svc.commandHints ?? [];
    if (hints.includes('tunnel')) return true;
    if (hints.includes('proxy-dns') || hints.includes('access')) return false;
    if (hasCloudflaredConfigMount(svc) || svc.envKeys.some(k => k === 'TUNNEL_TOKEN' || k === 'TUNNEL_TOKEN_FILE')) return true;
    return !svc.envKeys.some(k => k.startsWith('TUNNEL_DNS'));
  }
  return true;
}

function signalsOf(svc: TunnelDetectionService, provider: TunnelProvider, byImage: boolean): string[] {
  const signals: string[] = [];
  if (byImage) signals.push('image');
  for (const key of ENV_HINTS[provider]) if (svc.envKeys.includes(key)) signals.push(`env:${key}`);
  if ((svc.capAdd ?? []).some(c => c.toUpperCase().replace(/^CAP_/, '') === 'NET_ADMIN')) signals.push('cap:NET_ADMIN');
  if ((svc.devices ?? []).includes('/dev/net/tun')) signals.push('device:/dev/net/tun');
  if (provider === 'wireguard' && svc.ports.some(isUdpPort)) signals.push('udp-port');
  if (provider === 'tailscale') for (const flag of svc.tailscaleFlags ?? []) signals.push(`flag:${flag}`);
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

/** No `network_mode` declared: Compose attaches the service to its networks. */
function declaresNoNetworkMode(owner: TunnelDetectionService | undefined): boolean {
  return owner?.networkMode === undefined || owner.networkMode === '';
}

/** `network_mode: bridge`, or `default`, which Compose passes through and
 *  Docker runs on the same default bridge. */
function usesDefaultBridge(owner: TunnelDetectionService | undefined): boolean {
  return owner?.networkMode === 'bridge' || owner?.networkMode === 'default';
}

function attachmentOf(owner: TunnelDetectionService | undefined): TunnelAttachment {
  if (declaresNoNetworkMode(owner) || usesDefaultBridge(owner)) return 'networks';
  return owner?.networkMode === 'host' ? 'host' : 'other';
}

/** Stands for Docker's default bridge among network keys. A Compose network
 *  key cannot contain a space, so it never matches a stack network. */
export const DEFAULT_BRIDGE_KEY = 'docker default bridge';

/** Network keys a namespace owner joins: its stack networks (Compose's implicit
 *  `default` when it lists none), or Docker's default bridge alone under
 *  `network_mode: bridge` or `default`, which it shares only with other
 *  bridge-mode services. Any other network mode (`host`, `none`, `container:`, `service:`) joins no
 *  stack network, so the list is empty. */
function networksOf(owner: TunnelDetectionService | undefined): string[] {
  if (usesDefaultBridge(owner)) return [DEFAULT_BRIDGE_KEY];
  if (!owner || !declaresNoNetworkMode(owner)) return [];
  return owner.networks.length > 0 ? owner.networks.map(n => n.key) : ['default'];
}

/** Whether a connector on the stack's networks carries traffic to services
 *  beyond its own namespace. A Tailscale node forwards only when told to.
 *  `detectTunnels` does not consult this on the host network, where every
 *  connector reaches the host's ports, Tailscale included, because the tailnet
 *  node is then the host itself. */
function forwardsBeyondNamespace(connector: TunnelDetectionService, provider: TunnelProvider): boolean {
  if (provider !== 'tailscale') return true;
  return connector.envKeys.some(k => TAILSCALE_FORWARD_KEYS.includes(k)) || (connector.tailscaleFlags ?? []).length > 0;
}

/** Tailscale signals that mean the node forwards beyond itself. */
function tailscaleForwards(c: Pick<TunnelConnector, 'signals'>): boolean {
  return c.signals.some(s => TAILSCALE_FORWARD_KEYS.some(k => s === `env:${k}`) || s.startsWith('flag:'));
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
    // With no network at all the connector cannot reach its edge or any service.
    if (owner?.networkMode === 'none') continue;
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
      const otherOwner = byName.get(otherRoot);
      if (attachment === 'host') {
        // A published host port, or a service that is itself on the host network.
        if ((otherOwner?.ports.length ?? 0) > 0 || attachmentOf(otherOwner) === 'host') {
          reaches.push({ service: other.name, path: 'host-network', networks: [] });
        }
        continue;
      }
      if (!forwards) continue;
      const shared = networksOf(otherOwner).filter(key => connectorNetworks.has(key));
      if (shared.length > 0) {
        reaches.push({ service: other.name, path: 'shared-network', networks: shared });
      }
    }

    const declaredNetwork = (key: string) => (Object.prototype.hasOwnProperty.call(model.networks, key) ? model.networks[key] : undefined);
    const networkName = (key: string) => declaredNetwork(key)?.name ?? key;
    const keys = [...connectorNetworks].filter(key => key !== DEFAULT_BRIDGE_KEY);
    connectors.push({
      service: svc.name,
      provider,
      scope: PROVIDER_SCOPE[provider],
      attachment,
      signals: signalsOf(svc, provider, byImage),
      localConfig: provider === 'cloudflared' && hasCloudflaredConfigMount(svc),
      serveConfig: provider === 'tailscale' && svc.envKeys.includes('TS_SERVE_CONFIG'),
      meshAttached: keys.some(key => networkName(key) === SENCHO_MESH_NETWORK)
        || (options.meshManaged === true && declaresNoNetworkMode(owner)),
      externalNetworks: keys
        .filter(key => declaredNetwork(key)?.external === true && networkName(key) !== SENCHO_MESH_NETWORK)
        .map(networkName),
      reaches,
    });
  }

  return connectors;
}

/** Ranks a path by certainty first (a shared namespace reachable directly by
 *  overlay peers), then by audience (a public edge over a private overlay). A
 *  cloudflared namespace is reachable locally but its ingress is unverified, so
 *  it ranks above another unverified path but below a certain one. */
function strength(e: ServiceTunnelExposure): number {
  let certainty = 0;
  if (isCertainTunnelPath(e)) certainty = 2;
  else if (e.path === 'shared-namespace') certainty = 1;
  return certainty * 2 + (e.scope === 'public-edge' ? 1 : 0);
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
    case 'cloudflared': return 'anyone on the internet through Cloudflare\'s edge';
    case 'tailscale': return 'devices on the tailnet';
    case 'wireguard': return 'WireGuard peers';
  }
}

/** A sentence qualifying that audience, with a leading space for direct
 *  concatenation, or an empty string when none applies. */
function audienceCaveat(provider: TunnelProvider): string {
  return provider === 'cloudflared' ? ' Cloudflare Access, where it is set up, can restrict who gets through.' : '';
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
  if (c.attachment === 'host') return 'It uses the host network, so it can reach any port published on the host; no other service in this stack publishes one or uses the host network.';
  if (c.provider === 'tailscale' && !tailscaleForwards(c)) return 'Tailnet peers reach the Tailscale node itself; no other service in this stack shares its network namespace.';
  return 'No other service in this stack shares its network namespace or a network with it.';
}

/** Title and message for one connector, shared by Compose Doctor and the
 *  Networking findings so the two read the same. */
export function describeTunnelConnector(c: TunnelConnector): { title: string; message: string } {
  const label = TUNNEL_PROVIDER_LABEL[c.provider];
  const scope = c.scope === 'public-edge' ? 'public edge' : 'private overlay';
  const byPath = (path: TunnelPath) => c.reaches.filter(r => r.path === path).map(r => r.service);
  const namespaced = byPath('shared-namespace');
  const networked = byPath('shared-network');
  const hosted = byPath('host-network');
  const opens = c.provider === 'cloudflared'
    ? 'can publish whatever its ingress routes to, to anyone on the internet through Cloudflare\'s edge'
    : `opens what it reaches to ${tunnelScopePhrase(c.provider)}`;
  const sentences = [`Service "${c.service}" runs a ${label} connector (${scope}), which ${opens}.${audienceCaveat(c.provider)}`];
  if (namespaced.length > 0) {
    const { verb, they } = shareVerb(namespaced);
    sentences.push(c.provider === 'cloudflared'
      ? `${quotedList(namespaced)} ${verb} the connector's network namespace, so the connector can reach ${namespaced.length > 1 ? 'them' : 'it'} on localhost; whether Cloudflare's ingress routes incoming requests there is unverified.`
      : `${quotedList(namespaced)} ${verb} the connector's network namespace, so ${they} reachable at the connector's own address.`);
  }
  if (networked.length > 0) {
    sentences.push(`${quotedList(networked)} ${shareVerb(networked).verb} a network with the connector and can be reached if the connector's routing points there.`);
  }
  if (hosted.length > 0) {
    const condition = c.provider === 'tailscale' ? 'tailnet ACLs allow it' : 'the connector\'s routing points there';
    sentences.push(`${quotedList(hosted)} can be reached over the host network (a published host port or host networking) if ${condition}.`);
  }
  if (c.reaches.length === 0) sentences.push(emptyReachSentence(c));
  sentences.push(tunnelUnverifiedSentence(c));
  return { title: `${label} connector "${c.service}" (${scope})`, message: sentences.join(' ') };
}

/** The tunnel path to a service in a sentence (plus the audience caveat, when
 *  one applies), for exposure findings. */
export function describeServiceTunnel(e: ServiceTunnelExposure): string {
  const label = TUNNEL_PROVIDER_LABEL[e.provider];
  const who = tunnelScopePhrase(e.provider);
  const caveat = audienceCaveat(e.provider);
  switch (e.path) {
    case 'shared-namespace':
      return e.provider === 'cloudflared'
        ? `It shares the network namespace of the ${label} connector "${e.connector}", so the connector can reach it on localhost; whether Cloudflare's ingress routes incoming requests there is unverified.${caveat}`
        : `It shares the network namespace of the ${label} connector "${e.connector}", so ${who} can reach it.${caveat}`;
    case 'shared-network':
      return `It shares a network with the ${label} connector "${e.connector}", so ${who} can reach it if the tunnel routes there; that routing is unverified.${caveat}`;
    case 'host-network':
      return e.provider === 'tailscale'
        ? `The ${label} connector "${e.connector}" puts the host on the tailnet, so ${who} can reach it over the host network if tailnet ACLs allow it; those ACLs are unverified.${caveat}`
        : `The ${label} connector "${e.connector}" can reach it over the host network, so ${who} can reach it if the tunnel routes there; that routing is unverified.${caveat}`;
  }
}

/** True when the reach is certain: the service listens on the connector's own
 *  address and only the provider's peer routing, not a separate ingress map,
 *  decides what reaches it. A shared namespace is certain for Tailscale and
 *  WireGuard, whose overlay peers address the connector directly, but not for
 *  Cloudflare, whose ingress independently maps each hostname to an origin. */
export function isCertainTunnelPath(e: Pick<ServiceTunnelExposure, 'provider' | 'path'>): boolean {
  return e.path === 'shared-namespace' && (e.provider === 'tailscale' || e.provider === 'wireguard');
}

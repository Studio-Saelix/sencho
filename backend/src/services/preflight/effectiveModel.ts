/**
 * Parser for the output of `docker compose config` (the fully-resolved
 * effective model). It extracts only the STRUCTURAL facts the preflight rules
 * need; it never retains an environment VALUE. Service environment is read for
 * its key NAMES (to detect PUID/PGID style directives) and, for a finite
 * whitelist of Docker socket-proxy API flags, whether the rendered value
 * enables the group (stored as enabled flag names only). `command` and
 * `entrypoint` are read for `tcp://` endpoint host names only. Render errors
 * are handled by the caller, not here.
 */

import { classifyComposeHealthcheck } from '../../helpers/healthcheckPresence';

/** A host-published port range declared by a service (start==end for one port). */
export interface EffPortSpec {
  startPort: number;
  endPort: number;
  /** '' / '0.0.0.0' / '::' means all interfaces. */
  hostIp: string;
  protocol: string;
}

export interface EffBind {
  /** Absolute source path (compose config resolves relative binds to absolute). */
  source: string;
  target: string;
}

/**
 * One mount declared by a service, classified for the storage inventory. Unlike
 * `EffBind`/`namedVolumes` (which the preflight rules consume), this captures the
 * full mount taxonomy the Storage tab needs: every type, the read-only flag, and
 * anonymous/tmpfs mounts the rule-facing fields deliberately omit.
 */
export interface EffStorageMount {
  /** bind = host path; named = top-level volume key; anonymous = unnamed volume; tmpfs = ephemeral RAM mount. */
  type: 'bind' | 'named' | 'anonymous' | 'tmpfs';
  /** Host path (bind) or volume key (named); absent for anonymous and tmpfs mounts. */
  source?: string;
  target: string;
  readOnly: boolean;
}

/** A service's membership in one top-level network, keyed by the network KEY
 *  (not the resolved docker name) so it lines up with the `networks` map and
 *  with the authored `DeclaredService.networks`. */
export interface EffServiceNetwork {
  key: string;
  aliases: string[];
}

export interface EffService {
  name: string;
  image?: string;
  ports: EffPortSpec[];
  binds: EffBind[];
  namedVolumes: string[];
  /** Full per-mount inventory (every type, read-only flag, anonymous/tmpfs). Consumed by the storage feature, not the preflight rules. */
  storageMounts: EffStorageMount[];
  privileged: boolean;
  networkMode?: string;
  restart?: string;
  /**
   * True when the rendered Compose model declares an active healthcheck.
   * False for absent, `disable: true`, and `test: NONE` / `["NONE"]`.
   */
  hasHealthcheck: boolean;
  /** Compose-layer classification used by healthcheck evidence collection. */
  composeHealthcheck: 'active' | 'disabled' | 'absent';
  /** Raw deploy block (preflight uses key presence; Drift also reads restart_policy.condition). Undefined = none. */
  deploy?: Record<string, unknown>;
  containerName?: string;
  user?: string;
  /** Environment KEY names only. Values are never extracted. */
  envKeys: string[];
  /**
   * Names of recognized Docker socket-proxy API flags whose rendered value is
   * exactly `1`. Raw values are never retained; only the enabled flag name.
   */
  enabledProxyApiFlags: string[];
  /**
   * Host names of `tcp://host[:port]` endpoints referenced by `command` or
   * `entrypoint`. Used to spot services that talk to a socket proxy through a
   * CLI flag rather than `DOCKER_HOST`. Only the host name is retained.
   */
  dockerEndpointHosts: string[];
  /** Network membership by network key, with any aliases. */
  networks: EffServiceNetwork[];
  /** `extra_hosts` entries as `host:value` strings (host names / static IPs; a value built from a `${VAR}` is resolved upstream by `docker compose config`, so it can carry an interpolated secret). */
  extraHosts: string[];
  /** Label KEY names only. Values are never extracted (a label value can carry a secret). */
  labelKeys: string[];
}

/**
 * Display-safe driver classification. Arbitrary interpolated driver strings
 * (which can carry resolved .env values) are collapsed to `custom` and never
 * retained as raw text on the model.
 */
export type EffDriverKind =
  | 'default'
  | 'bridge'
  | 'overlay'
  | 'macvlan'
  | 'ipvlan'
  | 'host'
  | 'none'
  | 'custom';

export interface EffResource {
  /** Resolved docker name (compose config fills this in). */
  name: string;
  external: boolean;
  /** Top-level `internal: true` (no outbound/host connectivity for the network). */
  internal: boolean;
  /**
   * Bounded driver kind; never a raw interpolated driver string.
   * Absent on older hand-built test fixtures; treated as `default`.
   */
  driverKind?: EffDriverKind;
  /** True when `driver_opts` is a non-empty object. */
  hasDriverOpts?: boolean;
  /** True when IPAM has a non-empty driver, config, or options (empty `{}` is safe). */
  hasCustomIpam?: boolean;
  attachable?: boolean;
  /** False only when `enable_ipv4` is explicitly false. Absent means enabled. */
  ipv4Enabled?: boolean;
  /** True only when `enable_ipv6` is explicitly true. Absent means disabled. */
  ipv6Enabled?: boolean;
  /** True when `labels` is a non-empty object (values are never retained). */
  hasLabels?: boolean;
}

export interface EffectiveModel {
  projectName: string;
  services: EffService[];
  networks: Record<string, EffResource>;
  volumes: Record<string, EffResource>;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** Parse a `start[-end]` published-port string into a clamped range, or null if invalid. */
function parsePortRange(raw: string): { startPort: number; endPort: number } | null {
  const [a, b] = raw.split('-');
  const start = parseInt(a, 10);
  if (!Number.isFinite(start) || start <= 0) return null;
  const end = b !== undefined ? parseInt(b, 10) : start;
  return { startPort: start, endPort: Number.isFinite(end) && end >= start ? end : start };
}

/** Parse one rendered `ports:` entry (long object form, with a short-string fallback). */
function parsePortSpec(entry: unknown): EffPortSpec | null {
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    const publishedRaw = str(o.published);
    if (publishedRaw === undefined || publishedRaw === '') return null; // container-only
    const range = parsePortRange(publishedRaw);
    if (!range) return null;
    return { ...range, hostIp: str(o.host_ip) ?? '', protocol: str(o.protocol) ?? 'tcp' };
  }
  const short = str(entry);
  if (short === undefined) return null;
  const [spec, proto] = short.split('/');
  const parts = spec.split(':');
  let hostIp = '';
  let hostPart: string | undefined;
  if (parts.length >= 3) { hostIp = parts[0]; hostPart = parts[1]; }
  else if (parts.length === 2) { hostPart = parts[0]; }
  else return null; // container-only EXPOSE
  const range = parsePortRange(hostPart ?? '');
  if (!range) return null;
  return { ...range, hostIp, protocol: proto || 'tcp' };
}

/** Split a service `volumes:` list into bind mounts and named-volume sources. */
function parseVolumes(volumes: unknown): { binds: EffBind[]; named: string[] } {
  const binds: EffBind[] = [];
  const named: string[] = [];
  if (!Array.isArray(volumes)) return { binds, named };
  for (const v of volumes) {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const type = str(o.type);
      const source = str(o.source);
      const target = str(o.target) ?? '';
      if (type === 'bind' && source) binds.push({ source, target });
      else if (type === 'volume' && source) named.push(source);
      continue;
    }
    const s = str(v);
    if (!s) continue;
    const parts = s.split(':');
    if (parts.length < 2) continue; // anonymous volume, nothing to check
    const source = parts[0];
    const target = parts[1];
    const isPath = source.startsWith('/') || source.startsWith('.') || source.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(source);
    if (isPath) binds.push({ source, target });
    else named.push(source);
  }
  return { binds, named };
}

/** Leading Windows drive (`C:\` or `C:/`), whose own colon must not split a short-form source. */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;

/** A short-form source is a bind when it looks like a host path, otherwise a named volume. */
function isHostPathSource(source: string): boolean {
  return source.startsWith('/') || source.startsWith('.') || source.startsWith('~') || WIN_DRIVE.test(source);
}

/**
 * Parse one short-form `volumes:` entry (`[SOURCE:]TARGET[:OPTIONS]`) into a
 * storage mount. Windows-drive aware (the drive's colon does not split the
 * source) and tolerant of comma-joined options (`ro,Z`). A single token is an
 * anonymous volume mounted at that container path. `docker compose config`
 * normalizes to long form, so this is a defensive fallback.
 */
function parseShortVolume(s: string): EffStorageMount | null {
  if (!s) return null;
  let source: string;
  let target: string;
  let optionTokens: string[];

  if (WIN_DRIVE.test(s)) {
    const parts = s.split(':');
    source = `${parts[0]}:${parts[1]}`; // rejoin the drive (e.g. C:\data)
    const rest = parts.slice(2);
    if (rest.length === 0) return null; // a drive path with no container target is not a classifiable mount
    target = rest[0];
    optionTokens = rest.slice(1);
  } else {
    const parts = s.split(':');
    if (parts.length < 2) {
      // A bare token is an anonymous volume only when it is a container path;
      // anything else is unparseable, so drop it rather than invent a mount that
      // would skew the deterministic portability verdict.
      return parts[0].startsWith('/') ? { type: 'anonymous', target: parts[0], readOnly: false } : null;
    }
    source = parts[0];
    target = parts[1];
    optionTokens = parts.slice(2);
  }

  const readOnly = optionTokens.flatMap(o => o.split(',')).includes('ro');
  return { type: isHostPathSource(source) ? 'bind' : 'named', source, target, readOnly };
}

/**
 * Build the full per-mount storage inventory for a service from its `volumes:`
 * list and the separate service-level `tmpfs:` field (a string or string[],
 * distinct from a `volumes:` tmpfs mount). Captures every mount type plus the
 * read-only flag; never reads a mount's content.
 */
function parseStorageMounts(volumes: unknown, tmpfs: unknown): EffStorageMount[] {
  const mounts: EffStorageMount[] = [];
  if (Array.isArray(volumes)) {
    for (const v of volumes) {
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const type = str(o.type);
        const source = str(o.source);
        const target = str(o.target) ?? '';
        const readOnly = o.read_only === true;
        if (type === 'bind' && source) mounts.push({ type: 'bind', source, target, readOnly });
        else if (type === 'volume' && source) mounts.push({ type: 'named', source, target, readOnly });
        else if (type === 'volume') mounts.push({ type: 'anonymous', target, readOnly });
        else if (type === 'tmpfs') mounts.push({ type: 'tmpfs', target, readOnly: false });
        continue;
      }
      const s = str(v);
      if (!s) continue;
      const m = parseShortVolume(s);
      if (m) mounts.push(m);
    }
  }
  if (typeof tmpfs === 'string') {
    mounts.push({ type: 'tmpfs', target: tmpfs, readOnly: false });
  } else if (Array.isArray(tmpfs)) {
    for (const t of tmpfs) {
      const tt = str(t);
      if (tt) mounts.push({ type: 'tmpfs', target: tt, readOnly: false });
    }
  }
  return mounts;
}

/** Environment KEY names only. Never returns a value. */
function envKeysOf(env: unknown): string[] {
  if (Array.isArray(env)) {
    return env
      .map(e => str(e))
      .filter((s): s is string => s !== undefined)
      .map(s => s.split('=')[0])
      .filter(Boolean);
  }
  if (env && typeof env === 'object') return Object.keys(env as Record<string, unknown>);
  return [];
}

/**
 * Docker socket-proxy API group / verb env keys recognized for topology and
 * mutation detection. Only names whose rendered value is truthy are kept on the
 * model (see `enabledProxyApiFlagsOf`).
 */
export const PROXY_API_FLAG_KEYS: ReadonlySet<string> = new Set([
  'CONTAINERS', 'IMAGES', 'INFO', 'EVENTS', 'NETWORKS', 'VOLUMES', 'POST', 'DELETE',
]);

/**
 * Values a socket proxy treats as "off" for an API group flag. Anything else
 * enables the group, so an unrecognized value is reported rather than hidden.
 */
const PROXY_FLAG_FALSY: ReadonlySet<string> = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Whitelisted proxy API flag names whose rendered value enables the group.
 * Inspects values only long enough to decide enablement; never returns them.
 */
function enabledProxyApiFlagsOf(env: unknown): string[] {
  const enabled = new Set<string>();
  const consider = (key: string, raw: unknown): void => {
    if (!PROXY_API_FLAG_KEYS.has(key)) return;
    const value = str(raw)?.trim().toLowerCase();
    if (value !== undefined && !PROXY_FLAG_FALSY.has(value)) enabled.add(key);
  };
  if (Array.isArray(env)) {
    for (const entry of env) {
      const s = str(entry);
      if (s === undefined) continue;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      consider(s.slice(0, eq), s.slice(eq + 1));
    }
  } else if (env && typeof env === 'object') {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      consider(key, value);
    }
  }
  return [...enabled];
}

/** Matches a `tcp://[user:pass@]host[:port]` endpoint, capturing the host only. */
const TCP_ENDPOINT_RE = /tcp:\/\/(?:[^/@\s]*@)?([A-Za-z0-9._-]+)/g;

/**
 * Host names of any `tcp://host[:port]` endpoint referenced by a service's
 * `command` or `entrypoint`, used to spot a service pointed at a socket proxy
 * by a CLI flag. Only the host name is retained; the rest of the argument
 * (which can carry a credential) is not, and any `user:pass@` prefix is
 * dropped rather than captured.
 */
function dockerEndpointHostsOf(...sources: unknown[]): string[] {
  const hosts = new Set<string>();
  for (const source of sources.flat()) {
    const s = str(source);
    if (s === undefined) continue;
    for (const match of s.matchAll(TCP_ENDPOINT_RE)) hosts.add(match[1].toLowerCase());
  }
  return [...hosts];
}

/** Label KEY names only. A label VALUE can carry a secret, so it is never read. */
function labelKeysOf(labels: unknown): string[] {
  if (Array.isArray(labels)) {
    return labels
      .map(e => str(e))
      .filter((s): s is string => s !== undefined)
      .map(s => s.split('=')[0])
      .filter(Boolean);
  }
  if (labels && typeof labels === 'object') return Object.keys(labels as Record<string, unknown>);
  return [];
}

/** Service network membership (list or map form), keyed by network key, with aliases. */
function parseServiceNetworks(networks: unknown): EffServiceNetwork[] {
  if (Array.isArray(networks)) {
    return networks
      .map(n => str(n))
      .filter((s): s is string => s !== undefined)
      .map(key => ({ key, aliases: [] as string[] }));
  }
  if (networks && typeof networks === 'object') {
    return Object.entries(networks as Record<string, unknown>).map(([key, cfg]) => {
      const aliasesRaw = (cfg && typeof cfg === 'object') ? (cfg as Record<string, unknown>).aliases : undefined;
      const aliases = Array.isArray(aliasesRaw)
        ? aliasesRaw.map(a => str(a)).filter((a): a is string => a !== undefined)
        : [];
      return { key, aliases };
    });
  }
  return [];
}

/** `extra_hosts` (list `host:ip` or map `{host: ip}`) → `host:value` strings. A value built from a `${VAR}` is resolved upstream by `docker compose config`, so it can carry an interpolated secret. */
function parseExtraHosts(extraHosts: unknown): string[] {
  if (Array.isArray(extraHosts)) {
    return extraHosts.map(e => str(e)).filter((s): s is string => s !== undefined);
  }
  if (extraHosts && typeof extraHosts === 'object') {
    return Object.entries(extraHosts as Record<string, unknown>).map(([host, ip]) => `${host}:${str(ip) ?? ''}`);
  }
  return [];
}

const KNOWN_DRIVER_KINDS: ReadonlySet<string> = new Set([
  'bridge', 'overlay', 'macvlan', 'ipvlan', 'host', 'none',
]);

function toDriverKind(raw: string | undefined): EffDriverKind {
  if (raw === undefined || raw === '') return 'default';
  const lower = raw.toLowerCase();
  if (KNOWN_DRIVER_KINDS.has(lower)) return lower as EffDriverKind;
  return 'custom';
}

function isNonEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length > 0;
}

/** Empty `ipam: {}` is a Compose-normalized default; only non-empty IPAM blocks. */
function hasCustomIpam(ipam: unknown): boolean {
  if (!ipam || typeof ipam !== 'object' || Array.isArray(ipam)) return false;
  const o = ipam as Record<string, unknown>;
  if (typeof o.driver === 'string' && o.driver.trim() !== '') return true;
  if (Array.isArray(o.config) && o.config.length > 0) return true;
  if (isNonEmptyObject(o.options)) return true;
  return false;
}

function parseResourceEntry(key: string, entry: unknown): EffResource {
  const o = (entry ?? {}) as Record<string, unknown>;
  return {
    name: str(o.name) ?? key,
    external: o.external === true,
    internal: o.internal === true,
    driverKind: toDriverKind(str(o.driver)),
    hasDriverOpts: isNonEmptyObject(o.driver_opts),
    hasCustomIpam: hasCustomIpam(o.ipam),
    attachable: o.attachable === true,
    ipv4Enabled: o.enable_ipv4 !== false,
    ipv6Enabled: o.enable_ipv6 === true,
    hasLabels: isNonEmptyObject(o.labels),
  };
}

function parseResources(value: unknown): Record<string, EffResource> {
  const out: Record<string, EffResource> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = parseResourceEntry(key, entry);
    }
  }
  return out;
}

/**
 * Build an EffectiveModel from the parsed JSON of `docker compose config
 * --format json`. Tolerant of missing fields; an empty/garbage input yields an
 * empty model rather than throwing.
 */
export function parseEffectiveModel(parsed: unknown, fallbackProjectName: string): EffectiveModel {
  const root = (parsed ?? {}) as Record<string, unknown>;
  const rawServices = (root.services && typeof root.services === 'object') ? root.services as Record<string, unknown> : {};

  const services: EffService[] = [];
  for (const [name, raw] of Object.entries(rawServices)) {
    const svc = (raw ?? {}) as Record<string, unknown>;
    const ports = Array.isArray(svc.ports)
      ? svc.ports.map(parsePortSpec).filter((p): p is EffPortSpec => p !== null)
      : [];
    const { binds, named } = parseVolumes(svc.volumes);
    const storageMounts = parseStorageMounts(svc.volumes, svc.tmpfs);
    const composeHealthcheck = classifyComposeHealthcheck(svc.healthcheck);
    services.push({
      name,
      image: str(svc.image),
      ports,
      binds,
      namedVolumes: named,
      storageMounts,
      privileged: svc.privileged === true,
      networkMode: str(svc.network_mode),
      restart: str(svc.restart),
      hasHealthcheck: composeHealthcheck === 'active',
      composeHealthcheck,
      deploy: (svc.deploy && typeof svc.deploy === 'object') ? svc.deploy as Record<string, unknown> : undefined,
      containerName: str(svc.container_name),
      user: str(svc.user),
      envKeys: envKeysOf(svc.environment),
      enabledProxyApiFlags: enabledProxyApiFlagsOf(svc.environment),
      dockerEndpointHosts: dockerEndpointHostsOf(svc.command, svc.entrypoint),
      networks: parseServiceNetworks(svc.networks),
      extraHosts: parseExtraHosts(svc.extra_hosts),
      labelKeys: labelKeysOf(svc.labels),
    });
  }

  return {
    projectName: str(root.name) ?? fallbackProjectName,
    services,
    networks: parseResources(root.networks),
    volumes: parseResources(root.volumes),
  };
}

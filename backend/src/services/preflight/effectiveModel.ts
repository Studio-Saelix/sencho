/**
 * Parser for the output of `docker compose config` (the fully-resolved
 * effective model). It extracts only the STRUCTURAL facts the preflight rules
 * need; it never retains an environment VALUE. Service environment is read for
 * its key NAMES only (to detect PUID/PGID style directives), and render errors
 * are handled by the caller, not here.
 */

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

export interface EffService {
  name: string;
  image?: string;
  ports: EffPortSpec[];
  binds: EffBind[];
  namedVolumes: string[];
  privileged: boolean;
  networkMode?: string;
  restart?: string;
  hasHealthcheck: boolean;
  /** Raw deploy block (read for key presence only, never values; undefined = none). */
  deploy?: Record<string, unknown>;
  containerName?: string;
  user?: string;
  /** Environment KEY names only. Values are never extracted. */
  envKeys: string[];
}

export interface EffResource {
  /** Resolved docker name (compose config fills this in). */
  name: string;
  external: boolean;
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

function parseResources(value: unknown): Record<string, EffResource> {
  const out: Record<string, EffResource> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const o = (entry ?? {}) as Record<string, unknown>;
      out[key] = { name: str(o.name) ?? key, external: o.external === true };
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
    const healthcheck = svc.healthcheck;
    const hasHealthcheck = !!healthcheck
      && typeof healthcheck === 'object'
      && (healthcheck as Record<string, unknown>).disable !== true;
    services.push({
      name,
      image: str(svc.image),
      ports,
      binds,
      namedVolumes: named,
      privileged: svc.privileged === true,
      networkMode: str(svc.network_mode),
      restart: str(svc.restart),
      hasHealthcheck,
      deploy: (svc.deploy && typeof svc.deploy === 'object') ? svc.deploy as Record<string, unknown> : undefined,
      containerName: str(svc.container_name),
      user: str(svc.user),
      envKeys: envKeysOf(svc.environment),
    });
  }

  return {
    projectName: str(root.name) ?? fallbackProjectName,
    services,
    networks: parseResources(root.networks),
    volumes: parseResources(root.volumes),
  };
}

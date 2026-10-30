import YAML from 'yaml';
import { cloudflaredCommandHints, tailscaleForwardFlags, type TailscaleForwardFlag } from '../services/network/tunnelDetection';
import { expandComposeEnvTemplate, type ComposeEnvLookup } from '../utils/composeDotenv';

// Refuse to parse anything beyond this bound so a malformed (or adversarial)
// compose file cannot exhaust heap while building the dependency map. Mirrors
// the cap in composePreview.ts.
const MAX_COMPOSE_PARSE_BYTES = 1_048_576; // 1 MiB

/** A host-published port declared in a compose service. */
export interface DeclaredPort {
  /** Host interface ('' means all interfaces). */
  hostIp: string;
  publishedPort: number;
  protocol: string;
}

/** A service `env_file:` entry. `required: false` tolerates a missing file. */
export interface DeclaredEnvFile {
  path: string;
  required: boolean;
}

export interface DeclaredService {
  name: string;
  /** depends_on targets (list or map form, normalized to names). */
  dependsOn: string[];
  /** Service-level network keys (list or map form). */
  networks: string[];
  /** Named-volume source keys only (bind mounts and anonymous volumes excluded). */
  volumes: string[];
  ports: DeclaredPort[];
  /** Service `image:` reference as declared, or undefined for build-only services. */
  image?: string;
  /** Service `network_mode:` as declared (e.g. `host`), or undefined. */
  networkMode?: string;
  /** Environment KEY names (never values), for tunnel detection. Absent on hand-built fixtures. */
  envKeys?: string[];
  /** Service `env_file:` entries, whose KEY names join `envKeys`. */
  envFiles?: DeclaredEnvFile[];
  /** cloudflared subcommands named by `command`/`entrypoint`, for tunnel detection. Absent on hand-built fixtures. */
  commandHints?: string[];
  /** `command` or `entrypoint` was declared in this file. */
  commandDeclared?: boolean;
  /** `TS_EXTRA_ARGS` was declared in this file. */
  tailscaleArgsDeclared?: boolean;
  /** Tailscale forwarding flags named by `TS_EXTRA_ARGS`, for tunnel detection. Absent on hand-built fixtures. */
  tailscaleFlags?: TailscaleForwardFlag[];
  /** Bind and named-volume targets, for a mounted cloudflared config. */
  binds?: string[];
  /** `cap_add` entries, for tunnel detection. */
  capAdd?: string[];
  /** Host device paths from `devices`, for tunnel detection. */
  devices?: string[];
  /** A detection-relevant field holds a Compose `${VAR}`/`$VAR` to interpolate. */
  needsInterpolation?: boolean;
  /** Service `restart` from raw YAML parse. The effective-model path may set this via normalizeComposeRestartIntent (including deploy.restart_policy). Null when unset. */
  restart?: string | null;
}

/** A top-level networks:/volumes: entry. */
export interface DeclaredResource {
  /** Explicit `name:` override, when set. */
  name?: string;
  external: boolean;
}

export interface DeclaredCompose {
  services: DeclaredService[];
  networks: Record<string, DeclaredResource>;
  volumes: Record<string, DeclaredResource>;
  /** Top-level `name:` (the Compose project name), when set; it determines the
   *  `<project>_<resource>` runtime names, overriding the stack directory name. */
  projectName?: string;
  /** The file declares `include:`, whose services this light parser does not follow. */
  hasInclude?: boolean;
  /** A service declares `extends:`, which this light parser does not follow. */
  hasExtends?: boolean;
  /** Set when the file could not be parsed; the other fields are then empty. */
  parseError?: string;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Environment KEY names from list (`KEY=value`) or map form. Values are never kept. */
function envKeyNames(env: unknown, lookup?: ComposeEnvLookup): string[] {
  if (Array.isArray(env)) {
    return env
      .map(asString)
      .filter((v): v is string => v !== undefined)
      .map(v => interpolateString(v, lookup) ?? v)
      .map(v => v.split('=')[0])
      .filter(Boolean);
  }
  return env && typeof env === 'object' ? Object.keys(env as Record<string, unknown>) : [];
}

/** A detection-relevant string, expanded the way Compose interpolates it. On a
 *  template Compose refuses the raw value is kept, so a caller that needs a
 *  complete answer can see the unresolved `$`. */
function interpolateString(value: string | undefined, lookup?: ComposeEnvLookup): string | undefined {
  if (value === undefined || !lookup || !/\$(?:\{|\$|[A-Za-z_])/.test(value)) return value;
  try {
    return expandComposeEnvTemplate(value, lookup);
  } catch {
    return value;
  }
}

function interpolateKeys(keys: string[], lookup?: ComposeEnvLookup): string[] {
  return keys.map(key => interpolateString(key, lookup) ?? key);
}

/** A `command`/`entrypoint` in string or list form, interpolated for hints. */
function interpolateCommand(value: unknown, lookup?: ComposeEnvLookup): unknown {
  if (Array.isArray(value)) return value.map(part => interpolateString(asString(part), lookup) ?? part);
  const text = asString(value);
  return text === undefined ? value : interpolateString(text, lookup);
}

/** Whether a raw value still holds a template Compose would interpolate. */
function holdsTemplate(value: string | undefined): boolean {
  return value !== undefined && /\$(?:\{|\$|[A-Za-z_])/.test(value.replace(/\$\$/g, ''));
}

/** `KEY` or `KEY=value` in list form, or a map key. Values are never read. */
function declaresEnvKey(env: unknown, key: string, lookup?: ComposeEnvLookup): boolean {
  if (Array.isArray(env)) {
    return env.some((entry) => {
      if (typeof entry !== 'string') return false;
      const expanded = interpolateString(entry, lookup) ?? entry;
      return expanded === key || expanded.startsWith(`${key}=`);
    });
  }
  return !!env && typeof env === 'object' && key in (env as Record<string, unknown>);
}

/** Service `env_file:` entries in string, list, or `{ path, required }` form. */
function envFileEntries(value: unknown): DeclaredEnvFile[] {
  const readEntry = (entry: unknown): DeclaredEnvFile | null => {
    const short = asString(entry);
    if (short !== undefined) return { path: short, required: true };
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const filePath = asString(obj.path);
      if (filePath !== undefined) return { path: filePath, required: obj.required !== false };
    }
    return null;
  };
  if (Array.isArray(value)) return value.map(readEntry).filter((e): e is DeclaredEnvFile => e !== null);
  const single = readEntry(value);
  if (single) return [single];
  // Map form: { "path": { required: true } }.
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([filePath, cfg]) => ({
      path: filePath,
      required: !(cfg && typeof cfg === 'object' && (cfg as Record<string, unknown>).required === false),
    }));
  }
  return [];
}

/** Volume targets (bind or named) a service mounts, for structural checks. */
function volumeTargets(volumes: unknown): string[] {
  if (!Array.isArray(volumes)) return [];
  const out: string[] = [];
  for (const v of volumes) {
    const short = asString(v);
    if (short !== undefined) {
      const parts = short.split(':');
      if (parts.length >= 2) out.push(parts[1]);
      continue;
    }
    if (v && typeof v === 'object') {
      const target = asString((v as Record<string, unknown>).target);
      if (target !== undefined) out.push(target);
    }
  }
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((s): s is string => s !== undefined) : [];
}

/** Host-side device paths from `devices` (short `host[:container[:perms]]` or long `{ source }` form). */
function deviceHostPaths(devices: unknown): string[] {
  if (!Array.isArray(devices)) return [];
  const out: string[] = [];
  for (const d of devices) {
    const source = d && typeof d === 'object'
      ? asString((d as Record<string, unknown>).source)
      : asString(d)?.split(':')[0];
    if (source) out.push(source);
  }
  return out;
}

/** Extracts keys from a depends_on / networks block in list or map form. */
function collectKeys(value: unknown, lookup?: ComposeEnvLookup): string[] {
  if (Array.isArray(value)) {
    return interpolateKeys(value.map(asString).filter((v): v is string => v !== undefined), lookup);
  }
  if (value && typeof value === 'object') {
    return interpolateKeys(Object.keys(value as Record<string, unknown>), lookup);
  }
  return [];
}

/** True when a volume source is a named volume (not a bind mount or anonymous). */
function isNamedVolumeSource(source: string): boolean {
  if (!source) return false;
  // A named-volume key is [a-zA-Z0-9._-]+, so any '$' marks an env-var bind path
  // (or the '$$' literal-dollar escape) whose value is unresolvable at parse time.
  if (source.includes('$')) return false;
  if (source.includes('/')) return false; // bind mount path
  if (source.startsWith('.') || source.startsWith('~')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(source)) return false; // Windows drive path
  return true;
}

/** Pulls the named-volume source from a service volume entry, or null. */
function namedVolumeSource(entry: unknown): string | null {
  const short = asString(entry);
  if (short !== undefined) {
    const source = short.split(':')[0];
    return isNamedVolumeSource(source) ? source : null;
  }
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    if (obj.type === 'volume') {
      const source = asString(obj.source);
      return source ? source : null;
    }
  }
  return null;
}

/** Parses a service `ports:` entry into a host-published port, or null. */
function declaredPort(entry: unknown, lookup?: ComposeEnvLookup): DeclaredPort | null {
  const raw = asString(entry);
  const short = raw === undefined ? undefined : interpolateString(raw, lookup);
  if (short !== undefined) {
    const [spec, proto] = short.split('/');
    const parts = spec.split(':');
    let hostIp = '';
    let hostPart: string | undefined;
    if (parts.length >= 3) {
      hostIp = parts[0];
      hostPart = parts[1];
    } else if (parts.length === 2) {
      hostPart = parts[0];
    } else {
      return null; // container-only EXPOSE, not host-published
    }
    const published = parseInt((hostPart ?? '').split('-')[0], 10);
    if (!Number.isFinite(published) || published <= 0) return null;
    return { hostIp, publishedPort: published, protocol: proto || 'tcp' };
  }
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const publishedRaw = interpolateString(asString(obj.published), lookup);
    if (publishedRaw === undefined) return null; // not host-published
    const published = parseInt(publishedRaw.split('-')[0], 10);
    if (!Number.isFinite(published) || published <= 0) return null;
    return {
      hostIp: interpolateString(asString(obj.host_ip), lookup) ?? '',
      publishedPort: published,
      protocol: asString(obj.protocol) ?? 'tcp',
    };
  }
  return null;
}

/** Normalizes a top-level networks:/volumes: entry to { name?, external }. */
function declaredResource(entry: unknown): DeclaredResource {
  if (!entry || typeof entry !== 'object') return { external: false };
  const obj = entry as Record<string, unknown>;
  const name = asString(obj.name);
  // `external` may be a boolean or the legacy `{ name: ... }` object form.
  let external = false;
  let externalName: string | undefined;
  if (obj.external === true) {
    external = true;
  } else if (obj.external && typeof obj.external === 'object') {
    external = true;
    externalName = asString((obj.external as Record<string, unknown>).name);
  }
  const resolved = name ?? externalName;
  return resolved ? { name: resolved, external } : { external };
}

function collectResources(value: unknown): Record<string, DeclaredResource> {
  const out: Record<string, DeclaredResource> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = declaredResource(entry);
    }
  }
  return out;
}

/**
 * Parse a compose file's declared dependency metadata: per-service depends_on,
 * networks, named volumes, and host-published ports, plus the top-level
 * networks:/volumes: declarations with their name: overrides and external
 * flags. Never throws: parse failures are reported through `parseError`.
 *
 * Runtime edges in the dependency map come from the live container snapshot;
 * this declared view is used only to flag missing dependencies and to gather
 * declared port claimants for conflict detection.
 *
 * Values are read uninterpolated, except that `options.lookup`, when given,
 * expands the detection-relevant fields (`image`, `network_mode`, environment
 * KEY names, networks, ports, `command`/`entrypoint`, volumes, `cap_add`,
 * `devices`, `env_file` paths, and `TS_EXTRA_ARGS`) the way Compose would.
 */
export function parseComposeDependencies(content: string, options: { lookup?: ComposeEnvLookup } = {}): DeclaredCompose {
  if (content.length > MAX_COMPOSE_PARSE_BYTES) {
    return { services: [], networks: {}, volumes: {}, parseError: 'Compose file is too large to parse.' };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    return { services: [], networks: {}, volumes: {}, parseError: `Could not parse compose file: ${(error as Error).message}` };
  }

  const root = (parsed ?? {}) as Record<string, unknown>;
  const rawServices = root.services;
  if (!rawServices || typeof rawServices !== 'object') {
    return { services: [], networks: {}, volumes: {}, parseError: 'No services found in this file.' };
  }

  const lookup = options.lookup;
  const services: DeclaredService[] = [];
  let hasExtends = false;
  for (const [name, raw] of Object.entries(rawServices as Record<string, unknown>)) {
    const svc = (raw ?? {}) as Record<string, unknown>;
    if (svc.extends !== undefined) hasExtends = true;
    const volumes = Array.isArray(svc.volumes)
      ? svc.volumes.map(namedVolumeSource).filter((v): v is string => v !== null)
      : [];
    const ports = Array.isArray(svc.ports)
      ? svc.ports.map(port => declaredPort(port, lookup)).filter((p): p is DeclaredPort => p !== null)
      : [];
    const rawEnvKeys = envKeyNames(svc.environment);
    const commandDeclared = svc.command !== undefined || svc.entrypoint !== undefined;
    const envFiles = envFileEntries(svc.env_file).map(entry => ({
      ...entry,
      path: interpolateString(entry.path, lookup) ?? entry.path,
    }));
    const rawCommandParts = [svc.command, svc.entrypoint]
      .flatMap(value => (Array.isArray(value) ? value : [value]))
      .map(asString)
      .filter((v): v is string => v !== undefined);
    const needsInterpolation = [
      asString(svc.image),
      asString(svc.network_mode),
      ...collectKeys(svc.networks),
      ...rawEnvKeys,
      ...rawCommandParts,
      ...envFileEntries(svc.env_file).map(entry => entry.path),
      ...stringList(svc.cap_add),
      ...deviceHostPaths(svc.devices),
      ...volumeTargets(svc.volumes),
      ...(Array.isArray(svc.ports) ? svc.ports.map(asString).filter((v): v is string => v !== undefined) : []),
    ].some(holdsTemplate);
    services.push({
      name,
      dependsOn: collectKeys(svc.depends_on),
      networks: collectKeys(svc.networks, lookup),
      volumes,
      ports,
      image: interpolateString(asString(svc.image), lookup),
      networkMode: interpolateString(asString(svc.network_mode), lookup),
      envKeys: envKeyNames(svc.environment, lookup),
      envFiles,
      commandHints: cloudflaredCommandHints(interpolateCommand(svc.command, lookup), interpolateCommand(svc.entrypoint, lookup)),
      commandDeclared,
      tailscaleArgsDeclared: declaresEnvKey(svc.environment, 'TS_EXTRA_ARGS', lookup),
      tailscaleFlags: tailscaleForwardFlags(svc.environment, lookup),
      binds: interpolateKeys(volumeTargets(svc.volumes), lookup),
      capAdd: interpolateKeys(stringList(svc.cap_add), lookup),
      devices: interpolateKeys(deviceHostPaths(svc.devices), lookup),
      needsInterpolation,
      restart: asString(svc.restart) ?? null,
    });
  }

  return {
    services,
    networks: collectResources(root.networks),
    volumes: collectResources(root.volumes),
    projectName: asString(root.name),
    hasInclude: root.include !== undefined,
    hasExtends,
  };
}

function unionKeys(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * Merge the parsed layers of a multi-file Compose run in load order, applying
 * the parts of Compose's merge rules that tunnel detection reads: maps merge by
 * key, lists append, and a later scalar replaces an earlier one. `environment`
 * is represented by its KEY names, so later layers add keys; `command` and
 * `TS_EXTRA_ARGS` replace when the later layer declares them.
 */
export function mergeDeclaredCompose(layers: DeclaredCompose[]): DeclaredCompose {
  const failed = layers.find(layer => layer.parseError);
  if (failed) return { services: [], networks: {}, volumes: {}, parseError: failed.parseError };

  const byName = new Map<string, DeclaredService>();
  const networks: Record<string, DeclaredResource> = {};
  const volumes: Record<string, DeclaredResource> = {};
  let projectName: string | undefined;
  let hasInclude = false;
  let hasExtends = false;

  for (const layer of layers) {
    Object.assign(networks, layer.networks);
    Object.assign(volumes, layer.volumes);
    projectName = layer.projectName ?? projectName;
    hasInclude = hasInclude || layer.hasInclude === true;
    hasExtends = hasExtends || layer.hasExtends === true;
    for (const svc of layer.services) {
      const prior = byName.get(svc.name);
      if (!prior) {
        byName.set(svc.name, {
          ...svc,
          dependsOn: [...svc.dependsOn],
          networks: [...svc.networks],
          volumes: [...svc.volumes],
          ports: [...svc.ports],
          envKeys: [...(svc.envKeys ?? [])],
          envFiles: [...(svc.envFiles ?? [])],
          commandHints: [...(svc.commandHints ?? [])],
          tailscaleFlags: [...(svc.tailscaleFlags ?? [])],
          binds: [...(svc.binds ?? [])],
          capAdd: [...(svc.capAdd ?? [])],
          devices: [...(svc.devices ?? [])],
        });
        continue;
      }
      byName.set(svc.name, {
        ...prior,
        dependsOn: unionKeys(prior.dependsOn, svc.dependsOn),
        networks: unionKeys(prior.networks, svc.networks),
        volumes: unionKeys(prior.volumes, svc.volumes),
        ports: [...prior.ports, ...svc.ports],
        image: svc.image ?? prior.image,
        networkMode: svc.networkMode ?? prior.networkMode,
        envKeys: unionKeys(prior.envKeys, svc.envKeys),
        envFiles: [...(prior.envFiles ?? []), ...(svc.envFiles ?? [])],
        commandHints: svc.commandDeclared === true ? svc.commandHints ?? [] : prior.commandHints,
        commandDeclared: prior.commandDeclared === true || svc.commandDeclared === true,
        tailscaleFlags: svc.tailscaleArgsDeclared === true ? svc.tailscaleFlags ?? [] : prior.tailscaleFlags,
        tailscaleArgsDeclared: prior.tailscaleArgsDeclared === true || svc.tailscaleArgsDeclared === true,
        binds: unionKeys(prior.binds, svc.binds),
        capAdd: unionKeys(prior.capAdd, svc.capAdd),
        devices: unionKeys(prior.devices, svc.devices),
        needsInterpolation: prior.needsInterpolation === true || svc.needsInterpolation === true,
        restart: svc.restart ?? prior.restart,
      });
    }
  }

  return {
    services: [...byName.values()],
    networks,
    volumes,
    ...(projectName !== undefined ? { projectName } : {}),
    hasInclude,
    hasExtends,
  };
}

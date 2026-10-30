import YAML from 'yaml';
import { cloudflaredCommandHints, tailscaleForwardFlags, type TailscaleForwardFlag } from '../services/network/tunnelDetection';
import { ComposeEnvFileError, expandComposeEnvTemplate, type ComposeEnvLookup } from '../utils/composeDotenv';
import { isContainerPort, isDynamicHostPort, isFixedHostPort, splitShortPortSpec } from './composePortSpec';

// Refuse to parse anything beyond this bound so a malformed (or adversarial)
// compose file cannot exhaust heap while building the dependency map. Mirrors
// the cap in composePreview.ts.
const MAX_COMPOSE_PARSE_BYTES = 1_048_576; // 1 MiB

/** A host-published port declared in a compose service. */
export interface DeclaredPort {
  /** Host interface ('' means all interfaces). */
  hostIp: string;
  /** The host port, or 0 when `dynamic`. */
  publishedPort: number;
  protocol: string;
  /** Docker assigns the host port at start, so no number is known. The entry
   *  still publishes the container; port-conflict and drift consumers skip it
   *  (see `fixedPorts` in composePortSpec). Drift compares
   *  only the fixed ports, and the ledger hash records it as `auto`.. */
  dynamic?: true;
}

/** A service `env_file:` entry. `required: false` tolerates a missing file. */
export interface DeclaredEnvFile {
  path: string;
  required: boolean;
  /** `format: raw` keeps values literal: no quotes, escapes, or interpolation. */
  raw?: boolean;
  /** Any other `format:`, which Compose refuses or this reader cannot resolve. */
  unsupportedFormat?: boolean;
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
  /** Environment KEY names (never values) the service's `environment` sets, for
   *  tunnel detection. Absent on hand-built fixtures. */
  envKeys?: string[];
  /** `environment` keys written with no value (`KEY` or `KEY:`) that the
   *  interpolation environment does not answer. Compose leaves them out of the
   *  container's environment, which also overrides an `env_file` assignment. */
  unsetEnvKeys?: string[];
  /** Service `env_file:` entries, whose assigned KEY names join `envKeys`. */
  envFiles?: DeclaredEnvFile[];
  /** `command` hints alone. Kept separate from `entrypointHints` so an
   *  override that replaces only one of the two keeps the other. */
  commandHints?: string[];
  /** `entrypoint` hints alone. */
  entrypointHints?: string[];
  /** `command` was declared in this file. */
  commandDeclared?: boolean;
  /** `entrypoint` was declared in this file. */
  entrypointDeclared?: boolean;
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
  /** A detection-relevant field holds a Compose `${VAR}`/`$VAR` to interpolate,
   *  or an `environment` key has no value, so only the interpolation
   *  environment can say whether it is set. */
  needsInterpolation?: boolean;
  /** A detection field still holds a template after interpolation, so the
   *  stack's exact exposure cannot be established. */
  unresolvedDetection?: boolean;
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
  /** The file uses a custom YAML tag such as Compose's `!reset` or `!override`,
   *  which change how layers merge and which this light parser does not apply. */
  hasLayerTags?: boolean;
  /** Set when the file could not be parsed; the other fields are then empty. */
  parseError?: string;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** What a service's `environment` (list `KEY=value` or map form) sets. */
interface EnvironmentKeys {
  /** Keys with a value, or without one that the lookup answers. */
  set: string[];
  /** Keys without a value that the lookup does not answer. */
  unset: string[];
  /** Some key has no value, so a caller with no lookup cannot tell the two apart. */
  needsLookup: boolean;
}

/** Environment KEY names from list (`KEY=value`) or map form, split by whether
 *  Compose sets them. A key with no value (`KEY`, `KEY:`, `KEY: ~`) takes the
 *  variable of the same name and is left out when that is unset. Values are
 *  never kept. With no lookup, such a key counts as set. */
function environmentKeys(env: unknown, lookup?: ComposeEnvLookup): EnvironmentKeys {
  const keys: EnvironmentKeys = { set: [], unset: [], needsLookup: false };
  // A key listed twice resolves to its last entry, as in Compose, so a name is
  // in exactly one of the two arrays.
  const place = (key: string, isSet: boolean): void => {
    const [into, from] = isSet ? [keys.set, keys.unset] : [keys.unset, keys.set];
    const at = from.indexOf(key);
    if (at !== -1) from.splice(at, 1);
    if (!into.includes(key)) into.push(key);
  };
  const add = (key: string, valued: boolean): void => {
    if (!key) return;
    if (!valued) keys.needsLookup = true;
    place(key, valued || !lookup || lookup(key) !== undefined);
  };
  if (Array.isArray(env)) {
    for (const entry of env) {
      const text = asString(entry);
      if (text === undefined) continue;
      const expanded = interpolateString(text, lookup) ?? text;
      const eq = expanded.indexOf('=');
      add(eq === -1 ? expanded : expanded.slice(0, eq), eq !== -1);
    }
  } else if (env && typeof env === 'object') {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) add(key, value !== null && value !== undefined);
  }
  return keys;
}

/** A detection-relevant string, expanded the way Compose interpolates it. On a
 *  template Compose refuses the raw value is kept, so a caller that needs a
 *  complete answer can see the unresolved `$`. Any other failure is a defect
 *  and propagates. */
function interpolateString(value: string | undefined, lookup?: ComposeEnvLookup): string | undefined {
  if (value === undefined || !lookup || !/\$(?:\{|\$|[A-Za-z_])/.test(value)) return value;
  try {
    return expandComposeEnvTemplate(value, lookup);
  } catch (error) {
    if (error instanceof ComposeEnvFileError) return value;
    throw error;
  }
}

/** Whether Compose would expand `value` completely: it holds no template, or
 *  the lookup answers it without Compose refusing the template. Judged on the
 *  raw value, so a `$$` escape that expands to a literal `$` is not mistaken
 *  for a template that stayed unresolved. */
function expandsFully(value: string | undefined, lookup?: ComposeEnvLookup): boolean {
  if (!holdsTemplate(value)) return true;
  if (!lookup || value === undefined) return false;
  try {
    expandComposeEnvTemplate(value, lookup);
    return true;
  } catch (error) {
    if (error instanceof ComposeEnvFileError) return false;
    throw error;
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
export function holdsTemplate(value: string | undefined): boolean {
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
      if (filePath !== undefined) {
        // Compose reads `raw` and refuses any other format; a templated format
        // is not resolved here, so it is no more readable than an unknown one.
        const declared: DeclaredEnvFile = { path: filePath, required: obj.required !== false };
        if (obj.format === 'raw') declared.raw = true;
        else if (obj.format !== undefined) declared.unsupportedFormat = true;
        return declared;
      }
    }
    return null;
  };
  if (Array.isArray(value)) return value.map(readEntry).filter((e): e is DeclaredEnvFile => e !== null);
  const single = readEntry(value);
  if (single) return [single];
  // Map form: { "path": { required: true } }. Compose's spec does not define
  // it; it is read leniently so an unusual file is still scanned, not skipped.
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([filePath, cfg]) => ({
      path: filePath,
      required: !(cfg && typeof cfg === 'object' && (cfg as Record<string, unknown>).required === false),
    }));
  }
  return [];
}

/** Volume entries as written, for interpolation detection: a short-form string
 *  whole, since its source can hold the `:` of a `${VAR:-default}`, or a
 *  long-form target. */
function volumeStrings(volumes: unknown): string[] {
  if (!Array.isArray(volumes)) return [];
  const out: string[] = [];
  for (const v of volumes) {
    const short = asString(v);
    if (short !== undefined) out.push(short);
    else if (v && typeof v === 'object') {
      const target = asString((v as Record<string, unknown>).target);
      if (target !== undefined) out.push(target);
    }
  }
  return out;
}

/** Volume targets (bind or named) a service mounts, for structural checks. A
 *  short-form entry is expanded before it is split, so a `${VAR:-default}`
 *  source does not shift the target. */
function volumeTargets(volumes: unknown, lookup?: ComposeEnvLookup): string[] {
  if (!Array.isArray(volumes)) return [];
  const out: string[] = [];
  for (const v of volumes) {
    const short = asString(v);
    if (short !== undefined) {
      const parts = (interpolateString(short, lookup) ?? short).split(':');
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

/** Raw strings from short- or long-form `ports:` entries, for interpolation detection. */
function portStrings(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  const out: string[] = [];
  for (const entry of ports) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      for (const key of ['published', 'host_ip', 'target', 'protocol']) {
        const value = asString(obj[key]);
        if (value !== undefined) out.push(value);
      }
    }
  }
  return out;
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

/**
 * Parses a service `ports:` entry into a host-published port, or null. An entry
 * whose host port Docker assigns (container port only, an empty or `0` host
 * port, a long form with no `published`) is returned as `dynamic`.
 */
function declaredPort(entry: unknown, lookup?: ComposeEnvLookup): DeclaredPort | null {
  const raw = asString(entry);
  const short = raw === undefined ? undefined : interpolateString(raw, lookup);
  if (short !== undefined) {
    const spec = splitShortPortSpec(short);
    if (!spec) return null;
    if (isDynamicHostPort(spec.hostPart)) {
      return isContainerPort(spec.container)
        ? { hostIp: spec.hostIp, publishedPort: 0, protocol: spec.protocol, dynamic: true }
        : null;
    }
    if (!isFixedHostPort(spec.hostPart)) return null;
    return { hostIp: spec.hostIp, publishedPort: parseInt(spec.hostPart.split('-')[0], 10), protocol: spec.protocol };
  }
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const publishedRaw = interpolateString(asString(obj.published), lookup);
    const hostIp = interpolateString(asString(obj.host_ip), lookup) ?? '';
    const protocol = interpolateString(asString(obj.protocol), lookup) || 'tcp';
    if (isDynamicHostPort(publishedRaw)) {
      return isContainerPort(interpolateString(asString(obj.target), lookup))
        ? { hostIp, publishedPort: 0, protocol, dynamic: true }
        : null;
    }
    if (!isFixedHostPort(publishedRaw as string)) return null;
    return { hostIp, publishedPort: parseInt((publishedRaw as string).split('-')[0], 10), protocol };
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
  const out = Object.create(null) as Record<string, DeclaredResource>;
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
 * `options.allowEmptyServices` accepts a layer with no `services:` key when it
 * holds only top-level sections, for a caller that merges layers.
 * `options.mergeKeys` resolves YAML merge keys (`<<: *anchor`) as Compose does.
 * It is off by default so callers that hash or graph the declared view keep
 * reading a file the way they always have; the networking summary turns it on.
 */
export function parseComposeDependencies(
  content: string,
  options: { lookup?: ComposeEnvLookup; allowEmptyServices?: boolean; mergeKeys?: boolean } = {},
): DeclaredCompose {
  if (content.length > MAX_COMPOSE_PARSE_BYTES) {
    return { services: [], networks: {}, volumes: {}, parseError: 'Compose file is too large to parse.' };
  }

  // Compose resolves YAML merge keys, so a caller that must read a service as it
  // renders (the tunnel summary) opts in.
  let parsed: unknown;
  let hasLayerTags: boolean;
  try {
    const document = YAML.parseDocument(content, { merge: options.mergeKeys === true });
    if (document.errors.length > 0) throw document.errors[0];
    hasLayerTags = document.warnings.some(warning => warning.code === 'TAG_RESOLVE_FAILED');
    parsed = document.toJS();
  } catch (error) {
    return { services: [], networks: {}, volumes: {}, parseError: `Could not parse compose file: ${(error as Error).message}` };
  }

  const root = (parsed ?? {}) as Record<string, unknown>;
  const rawServices = root.services;
  if (rawServices === undefined) {
    // With `allowEmptyServices`, a layer that declares only top-level sections
    // (`name`, `networks`, `volumes`, `configs`, `secrets`, `include`,
    // `version`, or `x-` anchors) is valid Compose; the summary merges it with
    // the layers that do declare services. An empty file, or one with a top-level key outside
    // that list (such as a newer Compose section), is a parse error so the
    // stack is reported unreadable instead of unexposed.
    const topLevel = Object.keys(root);
    const knownTopLevel = topLevel.every(key => ['name', 'networks', 'volumes', 'configs', 'secrets', 'include', 'version'].includes(key) || key.startsWith('x-'));
    if (options.allowEmptyServices && topLevel.length > 0 && knownTopLevel) {
      return {
        services: [],
        networks: collectResources(root.networks),
        volumes: collectResources(root.volumes),
        projectName: asString(root.name),
        hasInclude: root.include !== undefined,
        hasExtends: false,
        hasLayerTags,
      };
    }
    return { services: [], networks: {}, volumes: {}, parseError: 'No services found in this file.' };
  }
  if (!rawServices || typeof rawServices !== 'object' || Array.isArray(rawServices)) {
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
    const rawEnvironment = environmentKeys(svc.environment);
    const environment = environmentKeys(svc.environment, lookup);
    const commandDeclared = svc.command !== undefined;
    const entrypointDeclared = svc.entrypoint !== undefined;
    const rawEnvFiles = envFileEntries(svc.env_file);
    const envFiles = rawEnvFiles.map(entry => ({
      ...entry,
      path: interpolateString(entry.path, lookup) ?? entry.path,
    }));
    const rawCommandParts = [svc.command, svc.entrypoint]
      .flatMap(value => (Array.isArray(value) ? value : [value]))
      .map(asString)
      .filter((v): v is string => v !== undefined);
    // Every field detection reads, as written. Whether one needs interpolation,
    // and whether the lookup answers it, is judged on the raw text.
    const detectionInputs: Array<string | undefined> = [
      asString(svc.image),
      asString(svc.network_mode),
      ...collectKeys(svc.networks),
      ...rawEnvironment.set,
      ...rawCommandParts,
      ...rawEnvFiles.map(entry => entry.path),
      ...stringList(svc.cap_add),
      ...deviceHostPaths(svc.devices),
      ...volumeStrings(svc.volumes),
      ...portStrings(svc.ports),
    ];
    const needsInterpolation = detectionInputs.some(holdsTemplate) || rawEnvironment.needsLookup;
    const unresolvedDetection = needsInterpolation && detectionInputs.some(value => !expandsFully(value, lookup));
    services.push({
      name,
      dependsOn: collectKeys(svc.depends_on),
      networks: collectKeys(svc.networks, lookup),
      volumes,
      ports,
      image: interpolateString(asString(svc.image), lookup),
      networkMode: interpolateString(asString(svc.network_mode), lookup),
      envKeys: environment.set,
      unsetEnvKeys: environment.unset,
      envFiles,
      commandHints: cloudflaredCommandHints(interpolateCommand(svc.command, lookup), undefined),
      entrypointHints: cloudflaredCommandHints(undefined, interpolateCommand(svc.entrypoint, lookup)),
      commandDeclared,
      entrypointDeclared,
      tailscaleArgsDeclared: declaresEnvKey(svc.environment, 'TS_EXTRA_ARGS', lookup),
      tailscaleFlags: tailscaleForwardFlags(svc.environment, lookup),
      binds: interpolateKeys(volumeTargets(svc.volumes, lookup), lookup),
      capAdd: interpolateKeys(stringList(svc.cap_add), lookup),
      devices: interpolateKeys(deviceHostPaths(svc.devices), lookup),
      needsInterpolation,
      unresolvedDetection,
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
    hasLayerTags,
  };
}

/** A later layer's top-level resource over an earlier one, field by field, as
 *  Compose merges mappings: an override that sets only `name:` keeps the base
 *  layer's `external: true`. `external` stays set once any layer sets it. */
function mergeResource(prior: DeclaredResource | undefined, next: DeclaredResource): DeclaredResource {
  if (!prior) return next;
  return { ...prior, ...(next.name !== undefined ? { name: next.name } : {}), external: prior.external || next.external };
}

function unionKeys(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * Merge the parsed layers of a multi-file Compose run in load order, applying
 * the parts of Compose's merge rules that tunnel detection reads: maps merge by
 * key (top-level networks and volumes merge field by field), a later scalar
 * replaces an earlier one, `ports` and `env_file` entries append, and the other
 * lists (`depends_on`, networks, volumes, `cap_add`, `devices`) union.
 * `environment` is represented by its KEY names, so later layers add keys and
 * a later value-less entry the environment does not answer removes an earlier one;
 * `command`, `entrypoint`, and `TS_EXTRA_ARGS` replace when the later layer
 * declares them.
 */
export function mergeDeclaredCompose(layers: DeclaredCompose[]): DeclaredCompose {
  const failed = layers.find(layer => layer.parseError);
  if (failed) return { services: [], networks: {}, volumes: {}, parseError: failed.parseError };

  const byName = new Map<string, DeclaredService>();
  const networks = Object.create(null) as Record<string, DeclaredResource>;
  const volumes = Object.create(null) as Record<string, DeclaredResource>;
  let projectName: string | undefined;
  let hasInclude = false;
  let hasExtends = false;
  let hasLayerTags = false;

  for (const layer of layers) {
    for (const [key, resource] of Object.entries(layer.networks)) networks[key] = mergeResource(networks[key], resource);
    for (const [key, resource] of Object.entries(layer.volumes)) volumes[key] = mergeResource(volumes[key], resource);
    projectName = layer.projectName ?? projectName;
    hasInclude = hasInclude || layer.hasInclude === true;
    hasExtends = hasExtends || layer.hasExtends === true;
    hasLayerTags = hasLayerTags || layer.hasLayerTags === true;
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
          unsetEnvKeys: [...(svc.unsetEnvKeys ?? [])],
          envFiles: [...(svc.envFiles ?? [])],
          commandHints: [...(svc.commandHints ?? [])],
          entrypointHints: [...(svc.entrypointHints ?? [])],
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
        // A later layer's entry for a key replaces an earlier one, even a value-less one.
        envKeys: unionKeys((prior.envKeys ?? []).filter(key => !(svc.unsetEnvKeys ?? []).includes(key)), svc.envKeys),
        unsetEnvKeys: unionKeys((prior.unsetEnvKeys ?? []).filter(key => !(svc.envKeys ?? []).includes(key)), svc.unsetEnvKeys),
        envFiles: [...(prior.envFiles ?? []), ...(svc.envFiles ?? [])],
        commandHints: svc.commandDeclared === true ? svc.commandHints ?? [] : prior.commandHints,
        entrypointHints: svc.entrypointDeclared === true ? svc.entrypointHints ?? [] : prior.entrypointHints,
        commandDeclared: prior.commandDeclared === true || svc.commandDeclared === true,
        entrypointDeclared: prior.entrypointDeclared === true || svc.entrypointDeclared === true,
        tailscaleFlags: svc.tailscaleArgsDeclared === true ? svc.tailscaleFlags ?? [] : prior.tailscaleFlags,
        tailscaleArgsDeclared: prior.tailscaleArgsDeclared === true || svc.tailscaleArgsDeclared === true,
        binds: unionKeys(prior.binds, svc.binds),
        capAdd: unionKeys(prior.capAdd, svc.capAdd),
        devices: unionKeys(prior.devices, svc.devices),
        needsInterpolation: prior.needsInterpolation === true || svc.needsInterpolation === true,
        unresolvedDetection: prior.unresolvedDetection === true || svc.unresolvedDetection === true,
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
    hasLayerTags,
  };
}

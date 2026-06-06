import YAML from 'yaml';

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

export interface DeclaredService {
  name: string;
  /** depends_on targets (list or map form, normalized to names). */
  dependsOn: string[];
  /** Service-level network keys (list or map form). */
  networks: string[];
  /** Named-volume source keys only (bind mounts and anonymous volumes excluded). */
  volumes: string[];
  ports: DeclaredPort[];
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
  /** Set when the file could not be parsed; the other fields are then empty. */
  parseError?: string;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Extracts keys from a depends_on / networks block in list or map form. */
function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((v): v is string => v !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/** True when a volume source is a named volume (not a bind mount or anonymous). */
function isNamedVolumeSource(source: string): boolean {
  if (!source) return false;
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
function declaredPort(entry: unknown): DeclaredPort | null {
  const short = asString(entry);
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
    const publishedRaw = asString(obj.published);
    if (publishedRaw === undefined) return null; // not host-published
    const published = parseInt(publishedRaw.split('-')[0], 10);
    if (!Number.isFinite(published) || published <= 0) return null;
    return {
      hostIp: asString(obj.host_ip) ?? '',
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
 */
export function parseComposeDependencies(content: string): DeclaredCompose {
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

  const services: DeclaredService[] = [];
  for (const [name, raw] of Object.entries(rawServices as Record<string, unknown>)) {
    const svc = (raw ?? {}) as Record<string, unknown>;
    const volumes = Array.isArray(svc.volumes)
      ? svc.volumes.map(namedVolumeSource).filter((v): v is string => v !== null)
      : [];
    const ports = Array.isArray(svc.ports)
      ? svc.ports.map(declaredPort).filter((p): p is DeclaredPort => p !== null)
      : [];
    services.push({
      name,
      dependsOn: collectKeys(svc.depends_on),
      networks: collectKeys(svc.networks),
      volumes,
      ports,
    });
  }

  return {
    services,
    networks: collectResources(root.networks),
    volumes: collectResources(root.volumes),
  };
}

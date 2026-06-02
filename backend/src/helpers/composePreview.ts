import YAML from 'yaml';

// Refuse to parse anything beyond this bound so a malformed (or adversarial)
// compose file cannot exhaust heap while building an import preview. Mirrors the
// cap the stacks router applies for env_file resolution.
const MAX_COMPOSE_PARSE_BYTES = 1_048_576; // 1 MiB

export interface ServicePreview {
  name: string;
  image?: string;
  /** Port mappings normalized to "host->container" (container-only when unpublished). */
  ports: string[];
  /** Bind/named volumes normalized to "source:target" (target-only when anonymous). */
  volumes: string[];
  /** env_file paths exactly as declared in the compose file. */
  envFiles: string[];
}

export interface ComposePreview {
  services: ServicePreview[];
  warnings: string[];
  /** Set when the file could not be turned into a usable preview; services is then empty. */
  parseError?: string;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function normalizePort(entry: unknown): string | null {
  // Short syntax: "8080:80", "8080:80/tcp", "127.0.0.1:8080:80", "80", or a bare number.
  const short = asString(entry);
  if (short !== undefined) {
    const [hostPort, containerPort] = splitShortPort(short);
    if (hostPort && containerPort) return `${hostPort}->${containerPort}`;
    if (containerPort) return containerPort; // container-only
    return hostPort ?? short;
  }
  // Long syntax: { target, published?, protocol? }.
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const target = asString(obj.target);
    const published = asString(obj.published);
    if (target) return published ? `${published}->${target}` : target;
  }
  return null;
}

function splitShortPort(value: string): [string | null, string | null] {
  const spec = value.split('/')[0]; // drop "/tcp" | "/udp"
  const parts = spec.split(':');
  if (parts.length >= 3) return [parts[1], parts[2]]; // ip:host:container
  if (parts.length === 2) return [parts[0], parts[1]]; // host:container
  return [null, parts[0]]; // container-only
}

function isRelativeSource(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

function normalizeVolume(entry: unknown, relativeFlag: { hit: boolean }): string | null {
  // Short syntax: "source:target", "source:target:ro", or "/anon-target".
  const short = asString(entry);
  if (short !== undefined) {
    const parts = short.split(':');
    if (parts.length >= 2) {
      const source = parts[0];
      if (isRelativeSource(source)) relativeFlag.hit = true;
      return `${source}:${parts[1]}`;
    }
    return short; // anonymous volume (target only)
  }
  // Long syntax: { type, source?, target }.
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const source = asString(obj.source);
    const target = asString(obj.target);
    if (target) {
      if (source && isRelativeSource(source)) relativeFlag.hit = true;
      return source ? `${source}:${target}` : target;
    }
  }
  return null;
}

function collectEnvFiles(envFile: unknown): string[] {
  if (typeof envFile === 'string') return [envFile];
  if (Array.isArray(envFile)) {
    const out: string[] = [];
    for (const entry of envFile) {
      const p = typeof entry === 'string' ? entry : asString((entry as Record<string, unknown>)?.path);
      if (p) out.push(p);
    }
    return out;
  }
  return [];
}

/**
 * Parse a compose file's text into a dry preview of its services, ports,
 * volumes, and env files. Never throws: parse failures and non-compose files
 * are reported through `parseError`. Used by the guided import scan to show
 * the user what a detected file contains before they bring it in.
 */
export function parseComposePreview(content: string): ComposePreview {
  if (content.length > MAX_COMPOSE_PARSE_BYTES) {
    return { services: [], warnings: [], parseError: 'Compose file is too large to preview.' };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    return { services: [], warnings: [], parseError: `Could not parse compose file: ${(error as Error).message}` };
  }

  const services = (parsed as { services?: unknown })?.services;
  if (!services || typeof services !== 'object') {
    return { services: [], warnings: [], parseError: 'No services found in this file.' };
  }

  const relativeFlag = { hit: false };
  const previews: ServicePreview[] = [];

  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const svc = (raw ?? {}) as Record<string, unknown>;
    const ports = Array.isArray(svc.ports)
      ? svc.ports.map((p) => normalizePort(p)).filter((p): p is string => p !== null)
      : [];
    const volumes = Array.isArray(svc.volumes)
      ? svc.volumes.map((v) => normalizeVolume(v, relativeFlag)).filter((v): v is string => v !== null)
      : [];
    previews.push({
      name,
      image: asString(svc.image),
      ports,
      volumes,
      envFiles: collectEnvFiles(svc.env_file),
    });
  }

  const warnings: string[] = [];
  if (relativeFlag.hit) {
    warnings.push(
      'Uses relative volume paths. For these to resolve, your host mount path must match the container compose directory (the 1:1 path rule).',
    );
  }

  return { services: previews, warnings };
}

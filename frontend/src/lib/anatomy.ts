/**
 * Shared, pure Compose-anatomy parsing.
 *
 * The Stack Anatomy panel and the Fleet Dossier export must derive the exact
 * same facts from a stack's compose.yaml + env file, so the parsing lives here
 * as one source of truth rather than being duplicated. Every function is pure
 * and side-effect free, and only ever surfaces env variable names and counts,
 * never `.env` values, so no secret can leak downstream.
 */

import { parse as parseYaml } from 'yaml';
import type { AnatomyMarkdownInput, PortRow, VolumeRow } from './anatomyMarkdown';

export interface GitSourceInfo {
  repo_url: string;
  branch: string;
  compose_path?: string;
}

export interface Anatomy {
  services: string[];
  ports: Record<string, PortRow[]>;
  volumes: Record<string, VolumeRow[]>;
  restart: string | null;
  envFiles: string[];
  networks: string[];
  referencedVars: string[];
}

// Matches ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}, ${VAR?err}.
// The leading (?<!\$) skips Compose's `$${VAR}` escape (a literal, not a ref).
// Capture group 1 is the variable name, group 2 (optional) is the modifier form.
const INTERPOLATION_REGEX = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])[^}]*)?\}/g;

function parsePortMapping(raw: unknown): PortRow | null {
  if (typeof raw === 'string') {
    const s = raw.replace(/^"|"$/g, '');
    const protoMatch = s.match(/\/(tcp|udp)$/i);
    const proto = protoMatch ? protoMatch[1].toLowerCase() : 'tcp';
    const body = proto ? s.replace(/\/(tcp|udp)$/i, '') : s;
    const parts = body.split(':');
    if (parts.length === 2) return { host: parts[0], container: parts[1], proto, published: true };
    if (parts.length === 3) return { host: parts[1], container: parts[2], proto, published: true };
    return { host: body, container: body, proto, published: false };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const host = obj.published !== undefined ? String(obj.published) : '';
    const container = obj.target !== undefined ? String(obj.target) : '';
    const proto = obj.protocol ? String(obj.protocol) : 'tcp';
    if (host && container) return { host, container, proto, published: true };
  }
  return null;
}

function parseVolumeMapping(raw: unknown): VolumeRow | null {
  if (typeof raw === 'string') {
    const parts = raw.split(':');
    if (parts.length >= 2) return { host: parts[0], container: parts[1] };
    return null;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj.source && obj.target) return { host: String(obj.source), container: String(obj.target) };
  }
  return null;
}

interface ServiceAnatomy {
  ports: PortRow[];
  volumes: VolumeRow[];
  restart: string | null;
  envFiles: string[];
  networks: string[];
}

function parseServiceBlock(svc: Record<string, unknown>): ServiceAnatomy {
  const ports: PortRow[] = Array.isArray(svc.ports)
    ? svc.ports.map(parsePortMapping).filter((r): r is PortRow => r !== null)
    : [];
  const volumes: VolumeRow[] = Array.isArray(svc.volumes)
    ? svc.volumes.map(parseVolumeMapping).filter((r): r is VolumeRow => r !== null)
    : [];
  const restart = typeof svc.restart === 'string' ? svc.restart : null;
  const envFiles: string[] = typeof svc.env_file === 'string'
    ? [svc.env_file]
    : Array.isArray(svc.env_file)
      ? svc.env_file.filter((e): e is string => typeof e === 'string')
      : [];
  let networks: string[] = [];
  if (Array.isArray(svc.networks)) {
    networks = svc.networks.filter((n): n is string => typeof n === 'string');
  } else if (svc.networks && typeof svc.networks === 'object') {
    networks = Object.keys(svc.networks as Record<string, unknown>);
  }
  return { ports, volumes, restart, envFiles, networks };
}

// `:-` and `-` forms supply a default value (no env entry required);
// `:?` and `?` forms signal a required variable (the user still needs to define it).
function extractInterpolations(yamlText: string): string[] {
  const referenced = new Set<string>();
  const defaulted = new Set<string>();
  for (const m of yamlText.matchAll(INTERPOLATION_REGEX)) {
    referenced.add(m[1]);
    if (m[2] === ':-' || m[2] === '-') defaulted.add(m[1]);
  }
  return Array.from(referenced).filter(v => !defaulted.has(v));
}

export function parseAnatomy(yamlText: string): Anatomy | null {
  if (!yamlText.trim()) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const servicesObj = (root.services && typeof root.services === 'object')
    ? root.services as Record<string, unknown>
    : {};
  const serviceNames = Object.keys(servicesObj);

  const ports: Record<string, PortRow[]> = {};
  const volumes: Record<string, VolumeRow[]> = {};
  let restart: string | null = null;
  const envFilesSet = new Set<string>();
  const networksSet = new Set<string>();

  for (const name of serviceNames) {
    const svc = servicesObj[name];
    if (!svc || typeof svc !== 'object') continue;
    const a = parseServiceBlock(svc as Record<string, unknown>);
    if (a.ports.length > 0) ports[name] = a.ports;
    if (a.volumes.length > 0) volumes[name] = a.volumes;
    if (restart === null && a.restart !== null) restart = a.restart;
    for (const f of a.envFiles) envFilesSet.add(f);
    for (const n of a.networks) networksSet.add(n);
  }

  if (root.networks && typeof root.networks === 'object' && !Array.isArray(root.networks)) {
    for (const n of Object.keys(root.networks)) networksSet.add(n);
  }

  return {
    services: serviceNames,
    ports,
    volumes,
    restart,
    envFiles: Array.from(envFilesSet),
    networks: Array.from(networksSet),
    referencedVars: extractInterpolations(yamlText),
  };
}

/**
 * The first genuinely host-published TCP port across all services, as a number,
 * or null when none qualifies. Used to turn the anatomy footer into a real link.
 * Skips container-only short syntax, UDP, ranges, `${VAR}`, and out-of-range
 * values: none of those yield a browser-openable host:port.
 */
export function primaryPublishedHostPort(ports: Record<string, PortRow[]>): number | null {
  for (const rows of Object.values(ports)) {
    for (const r of rows) {
      if (!r.published || r.proto !== 'tcp') continue;
      if (!/^\d+$/.test(r.host)) continue;
      const port = Number(r.host);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    }
  }
  return null;
}

export function parseEnvKeys(envText: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

export function formatGitSource(src: GitSourceInfo): string {
  try {
    const url = new URL(src.repo_url);
    const host = url.host;
    const repo = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return `${host}/${repo}#${src.branch}`;
  } catch {
    return `${src.repo_url}#${src.branch}`;
  }
}

/**
 * Assemble the {@link AnatomyMarkdownInput} the Markdown builders consume from a
 * stack's raw compose + env content. Returns null when compose.yaml cannot be
 * parsed, mirroring the Stack Anatomy panel's behaviour so the panel and the
 * Fleet Dossier export agree on every fact.
 */
export function assembleAnatomyInput(args: {
  stackName: string;
  content: string;
  envContent: string;
  selectedEnvFile: string | null;
  gitSource: GitSourceInfo | null;
}): AnatomyMarkdownInput | null {
  const anatomy = parseAnatomy(args.content);
  if (!anatomy) return null;

  const envKeys = parseEnvKeys(args.envContent);
  const missingVars = anatomy.referencedVars.filter(v => !envKeys.has(v));
  const firstEnvFile = anatomy.envFiles[0] ?? args.selectedEnvFile ?? null;
  const networkName = anatomy.networks.length > 0
    ? anatomy.networks[0]
    : `${args.stackName}_default`;

  return {
    stackName: args.stackName,
    services: anatomy.services,
    ports: anatomy.ports,
    volumes: anatomy.volumes,
    restart: anatomy.restart,
    envFile: firstEnvFile,
    envVarCount: envKeys.size,
    missingVars,
    networkName,
    gitSource: args.gitSource ? formatGitSource(args.gitSource) : null,
  };
}

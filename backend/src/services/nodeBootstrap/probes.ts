import net from 'net';
import { RESERVED_PATH_PREFIXES, shellQuote } from './pathPolicy';
import type {
  AgentDirObservation,
  AgentInstallObservation,
  BootstrapFacts,
  ComposeDirObservation,
  DockerPackage,
  DockerPackageName,
  HostKeyObservation,
  PathObservation,
} from './types';
import type { SshCommand, SshCommandResult } from './sshProbeClient';

/**
 * Fixed read-only probe catalog.
 *
 * Every command is a constant template. The only interpolated values are the
 * validated Compose and Agent directories and the hub URL, each passed through
 * `shellQuote`. Nothing in this file writes, installs, restarts, creates a
 * directory, changes a permission, or opens a port.
 */

export interface ProbeCatalogInput {
  composeDir: string;
  agentDir: string;
  hubUrl: string;
}

const COMPOSE_FILE_NAMES = `\\( -name 'compose.yaml' -o -name 'compose.yml' -o -name 'docker-compose.yaml' -o -name 'docker-compose.yml' \\)`;

/**
 * Inventory scripts resolve the path first and refuse a denied real path before
 * reading anything. Without this, a lexically allowed path whose ancestor is a
 * symlink into a denied root would be enumerated (through sudo when available)
 * before the evidence layer saw the resolved path.
 */
const RESERVED_CASE_PATTERNS = RESERVED_PATH_PREFIXES.map((prefix) => `${prefix}|${prefix}/*`).join('|');

function guardedInventoryScript(findCommand: string): string {
  return [
    'p="$1"',
    "real=$(realpath -m -- \"$p\" 2>/dev/null) || exit 1",
    `case "$real" in ${RESERVED_CASE_PATTERNS}) exit 1;; esac`,
    findCommand,
  ].join('\n');
}

/**
 * One fixed script per path. The path arrives as `$1` (already shell-quoted),
 * so the script itself is a constant and the value is never spliced into code.
 */
export const PATH_FACTS_SCRIPT = [
  'p="$1"',
  `printf 'P_INPUT=%s\\n' "$p"`,
  `if [ -e "$p" ] || [ -L "$p" ]; then printf 'P_EXISTS=1\\n'; else printf 'P_EXISTS=0\\n'; fi`,
  `if [ -d "$p" ]; then printf 'P_ISDIR=1\\n'; else printf 'P_ISDIR=0\\n'; fi`,
  `if [ -L "$p" ]; then printf 'P_FINAL_LINK=1\\n'; else printf 'P_FINAL_LINK=0\\n'; fi`,
  `real=$(realpath -m -- "$p" 2>/dev/null) && printf 'P_REAL=%s\\n' "$real" || printf 'P_ERROR=realpath\\n'`,
  `if [ -n "$real" ] && [ "$real" != "$p" ] && [ ! -L "$p" ]; then printf 'P_ANCESTOR_LINK=1\\n'; else printf 'P_ANCESTOR_LINK=0\\n'; fi`,
  `if [ -e "$p" ]; then`,
  `  printf 'P_OWNER=%s\\n' "$(stat -c '%U' -- "$p" 2>/dev/null)"`,
  `  printf 'P_GROUP=%s\\n' "$(stat -c '%G' -- "$p" 2>/dev/null)"`,
  `  printf 'P_MODE=%s\\n' "$(stat -c '%a' -- "$p" 2>/dev/null)"`,
  `fi`,
  `if [ -e "$p" ] && [ -r "$p" ] && [ -x "$p" ]; then printf 'P_USER_R=1\\n'; else printf 'P_USER_R=0\\n'; fi`,
  `if [ -e "$p" ] && [ -w "$p" ]; then printf 'P_USER_W=1\\n'; else printf 'P_USER_W=0\\n'; fi`,
  `d="$p"`,
  `while [ ! -e "$d" ] && [ "$d" != "/" ]; do d=$(dirname -- "$d"); done`,
  `printf 'P_NEAREST=%s\\n' "$d"`,
  `if [ -w "$d" ]; then printf 'P_PARENT_W=1\\n'; else printf 'P_PARENT_W=0\\n'; fi`,
  `if sudo -n true 2>/dev/null; then`,
  `  if [ -e "$p" ] && sudo -n test -r "$p" 2>/dev/null && sudo -n test -x "$p" 2>/dev/null; then printf 'P_SUDO_R=1\\n'; else printf 'P_SUDO_R=0\\n'; fi`,
  `  if [ -e "$p" ] && sudo -n test -w "$p" 2>/dev/null; then printf 'P_SUDO_W=1\\n'; else printf 'P_SUDO_W=0\\n'; fi`,
  `fi`,
  `printf 'P_FSTYPE=%s\\n' "$(findmnt -n -o FSTYPE --target "$p" 2>/dev/null)"`,
  `printf 'P_FSSOURCE=%s\\n' "$(findmnt -n -o SOURCE --target "$p" 2>/dev/null)"`,
  `printf 'P_FSTARGET=%s\\n' "$(findmnt -n -o TARGET --target "$p" 2>/dev/null)"`,
  `q="$p"; [ -e "$q" ] || q="$d"`,
  `printf 'P_DF=%s\\n' "$(df -Pk -- "$q" 2>/dev/null | tail -n 1)"`,
].join('\n');

export const DOCKER_ROOT_DISK_SCRIPT = [
  'root=$(docker info --format "{{.DockerRootDir}}" 2>/dev/null)',
  '[ -n "$root" ] || root=$(sudo -n docker info --format "{{.DockerRootDir}}" 2>/dev/null)',
  '[ -n "$root" ] || root=/var/lib/docker',
  'd="$root"',
  'while [ ! -e "$d" ] && [ "$d" != "/" ]; do d=$(dirname -- "$d"); done',
  'df -Pk -- "$d" 2>/dev/null | tail -n 1',
].join('\n');

export interface ProbeDefinition extends SshCommand {
  /** Sent only when the direct probe failed and non-interactive sudo works. */
  requiresSudo?: boolean;
  /** Sent only when the direct probe succeeded. Never sent on its own. */
  directOnly?: boolean;
}

export function buildProbeCatalog(input: ProbeCatalogInput): ProbeDefinition[] {
  const compose = shellQuote(input.composeDir);
  const agent = shellQuote(input.agentDir);
  const hub = shellQuote(input.hubUrl);
  return [
    { id: 'os_release', command: `cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null` },
    { id: 'uname', command: `uname -m; uname -r` },
    { id: 'user', command: `id -un; id -u; id -gn` },
    { id: 'sudo', command: `sudo -n true` },
    { id: 'docker_cli', command: `command -v docker` },
    { id: 'docker_info', command: `docker info --format '{{.ServerVersion}}|{{.DockerRootDir}}' 2>/dev/null`, directOnly: true },
    { id: 'docker_info_sudo', command: `sudo -n docker info --format '{{.ServerVersion}}|{{.DockerRootDir}}' 2>/dev/null`, requiresSudo: true },
    { id: 'compose_version', command: `docker compose version --short 2>/dev/null`, directOnly: true },
    { id: 'compose_version_sudo', command: `sudo -n docker compose version --short 2>/dev/null`, requiresSudo: true },
    { id: 'docker_service_active', command: `systemctl is-active docker 2>/dev/null` },
    { id: 'docker_service_enabled', command: `systemctl is-enabled docker 2>/dev/null` },
    {
      id: 'docker_repo',
      command: `for f in /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources; do [ -f "$f" ] && echo list; done; for f in /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg /usr/share/keyrings/docker-archive-keyring.gpg; do [ -f "$f" ] && echo keyring; done; true`,
    },
    {
      id: 'apt_policy',
      command: `apt-cache policy docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null`,
    },
    {
      id: 'containers',
      command: `docker ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.compose.project.working_dir"}}\\t{{.Status}}' 2>/dev/null`,
      directOnly: true,
    },
    {
      id: 'containers_sudo',
      command: `sudo -n docker ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.compose.project.working_dir"}}\\t{{.Status}}' 2>/dev/null`,
      requiresSudo: true,
    },
    { id: 'agent_volume', command: `docker volume inspect sencho-agent-data --format '{{.Name}}' 2>/dev/null`, directOnly: true },
    { id: 'agent_volume_sudo', command: `sudo -n docker volume inspect sencho-agent-data --format '{{.Name}}' 2>/dev/null`, requiresSudo: true },
    { id: 'clock', command: `date +%s` },
    {
      id: 'hub_health',
      command: `curl -sS --max-time 10 -o /dev/null -w '%{http_code}' ${hub}/api/health 2>/dev/null`,
    },
    { id: 'path_compose', command: `sh -c ${shellQuote(PATH_FACTS_SCRIPT)} sencho-probe ${compose}` },
    { id: 'path_agent', command: `sh -c ${shellQuote(PATH_FACTS_SCRIPT)} sencho-probe ${agent}` },
    {
      id: 'compose_inventory',
      command: `sh -c ${shellQuote(guardedInventoryScript(`find "$p" -mindepth 1 -maxdepth 2 -type f ${COMPOSE_FILE_NAMES} -print0 2>/dev/null`))} sencho-inventory ${compose}`,
      directOnly: true,
    },
    {
      id: 'compose_inventory_sudo',
      command: `sh -c ${shellQuote(guardedInventoryScript(`sudo -n find "$p" -mindepth 1 -maxdepth 2 -type f ${COMPOSE_FILE_NAMES} -print0 2>/dev/null`))} sencho-inventory ${compose}`,
      requiresSudo: true,
    },
    {
      id: 'agent_inventory',
      command: `sh -c ${shellQuote(guardedInventoryScript(`find "$p" -mindepth 1 -maxdepth 1 -printf '%f\\0' 2>/dev/null`))} sencho-inventory ${agent}`,
      directOnly: true,
    },
    {
      id: 'agent_inventory_sudo',
      command: `sh -c ${shellQuote(guardedInventoryScript(`sudo -n find "$p" -mindepth 1 -maxdepth 1 -printf '%f\\0' 2>/dev/null`))} sencho-inventory ${agent}`,
      requiresSudo: true,
    },
    {
      id: 'agent_marker',
      command: `sh -c ${shellQuote(guardedInventoryScript(`cat "$p/sencho-bootstrap.json" 2>/dev/null`))} sencho-inventory ${agent}`,
      directOnly: true,
    },
    {
      id: 'agent_marker_sudo',
      command: `sh -c ${shellQuote(guardedInventoryScript(`sudo -n cat "$p/sencho-bootstrap.json" 2>/dev/null`))} sencho-inventory ${agent}`,
      requiresSudo: true,
    },
    { id: 'default_agent_path', command: `test -f /opt/sencho-agent/compose.yaml && echo yes || echo no` },
    { id: 'docker_root_disk', command: `sh -c ${shellQuote(DOCKER_ROOT_DISK_SCRIPT)}` },
    { id: 'fstab', command: `cat /etc/fstab 2>/dev/null` },
  ];
}

const MUTATING_COMMAND = /(?:^|[;&|(\s])(mkdir|install|chmod|chown|chgrp|rm|rmdir|mv|cp|ln|tee|dd|truncate|touch|sed\s+-i|apt(?:-get)?\s+(?:install|update|upgrade|remove|purge|autoremove|clean)|dpkg|systemctl\s+(?:start|stop|restart|enable|disable|mask|unmask)|service\s+\w+\s+(?:start|stop|restart)|docker\s+(?:run|create|start|stop|restart|kill|rm|rmi|pull|build|push|login|volume\s+(?:create|rm)|compose\s+(?:up|down|start|stop|restart|rm|pull|build)))(?:\s|$)/;
const SAFE_REDIRECTS = /2>\/dev\/null|-o \/dev\/null/g;

/** True when a command is provably read-only by the catalog's own rules. */
export function isReadOnlyProbeCommand(command: string): boolean {
  if (MUTATING_COMMAND.test(command)) return false;
  const withoutSafeRedirects = command.replace(SAFE_REDIRECTS, '');
  return !/[<>]/.test(withoutSafeRedirects);
}

// --- Parsers -------------------------------------------------------------

export function parseOsRelease(text: string): BootstrapFacts['os'] {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    fields.set(match[1], match[2].replace(/^"|"$/g, ''));
  }
  const id = fields.get('ID');
  const versionId = fields.get('VERSION_ID');
  if (!id || !versionId) return null;
  return {
    id,
    versionId,
    codename: fields.get('VERSION_CODENAME') ?? '',
    prettyName: fields.get('PRETTY_NAME') ?? '',
    arch: '',
    kernel: '',
  };
}

export function parseUname(text: string): { arch: string; kernel: string } {
  const [arch = '', kernel = ''] = text.trim().split('\n');
  return { arch: arch.trim(), kernel: kernel.trim() };
}

export function parseUser(text: string): BootstrapFacts['user'] {
  const [name = '', uid = '', group = ''] = text.trim().split('\n');
  if (!name || !/^\d+$/.test(uid.trim())) return null;
  return {
    name: name.trim(),
    uid: Number(uid.trim()),
    group: group.trim(),
    isRoot: uid.trim() === '0',
    sudoNonInteractive: false,
  };
}

export function parseDockerInfo(text: string): { serverVersion: string | null; rootDir: string | null } | null {
  const line = text.trim().split('\n')[0] ?? '';
  if (!line.includes('|')) return null;
  const [version, rootDir] = line.split('|');
  return {
    serverVersion: version.trim() || null,
    rootDir: rootDir.trim() || null,
  };
}

export function parseComposeVersion(text: string): string | null {
  const line = text.trim().split('\n')[0]?.trim();
  return line ? line : null;
}

export function parseDockerRepo(text: string): { dockerSourceConfigured: boolean; keyringPresent: boolean } {
  const lines = text.split('\n').map((line) => line.trim());
  return {
    dockerSourceConfigured: lines.includes('list'),
    keyringPresent: lines.includes('keyring'),
  };
}

const DOCKER_PACKAGES: DockerPackageName[] = [
  'docker-ce',
  'docker-ce-cli',
  'containerd.io',
  'docker-buildx-plugin',
  'docker-compose-plugin',
];

export function parseAptPolicy(text: string): DockerPackage[] {
  const packages = new Map<string, DockerPackage>();
  let current: DockerPackage | null = null;
  for (const line of text.split('\n')) {
    const nameMatch = /^([a-z0-9.-]+):\s*$/.exec(line);
    if (nameMatch) {
      const name = nameMatch[1] as DockerPackageName;
      if (!DOCKER_PACKAGES.includes(name)) {
        current = null;
        continue;
      }
      current = { name, installedVersion: null, candidateVersion: null };
      packages.set(name, current);
      continue;
    }
    if (!current) continue;
    const installed = /^\s+Installed:\s*(\S+)/.exec(line);
    if (installed) {
      current.installedVersion = installed[1] === '(none)' ? null : installed[1];
      continue;
    }
    const candidate = /^\s+Candidate:\s*(\S+)/.exec(line);
    if (candidate) {
      current.candidateVersion = candidate[1] === '(none)' ? null : candidate[1];
    }
  }
  return DOCKER_PACKAGES.map((name) => packages.get(name) ?? {
    name,
    installedVersion: null,
    candidateVersion: null,
  });
}

export interface ContainerRow {
  name: string;
  image: string;
  project: string | null;
  workingDir: string | null;
  status: string;
}

export function parseContainers(text: string, cap = 200): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [name = '', image = '', project = '', workingDir = '', status = ''] = line.split('\t');
    if (!name.trim()) continue;
    rows.push({
      name: name.trim(),
      image: image.trim(),
      project: project.trim() || null,
      workingDir: workingDir.trim() || null,
      status: status.trim(),
    });
    if (rows.length >= cap) break;
  }
  return rows;
}

export function parseVolumeName(text: string): string | null {
  const line = text.trim().split('\n')[0]?.trim();
  return line ? line : null;
}

export function parseEpochSeconds(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

export interface HubHealthObservation {
  reachable: boolean | null;
  statusCode: number | null;
  tlsTrusted: boolean | null;
}

export function parseHubHealth(result: SshCommandResult): HubHealthObservation {
  if (result.timedOut || result.truncated) return { reachable: null, statusCode: null, tlsTrusted: null };
  const code = Number(result.stdout.trim());
  if (result.exitCode === 0 && Number.isInteger(code) && code > 0) {
    return { reachable: true, statusCode: code, tlsTrusted: true };
  }
  if (/server certificate|certificate verify|SSL certificate/i.test(result.stderr)) {
    return { reachable: true, statusCode: null, tlsTrusted: false };
  }
  if (/command not found|curl: not found/i.test(result.stderr)) {
    return { reachable: null, statusCode: null, tlsTrusted: null };
  }
  return { reachable: false, statusCode: null, tlsTrusted: null };
}

export function parseFstabMountPoints(text: string): string[] {
  const points: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[1].startsWith('/')) points.push(parts[1]);
  }
  return points;
}

export interface ParsedPathFacts extends PathObservation {
  raw: Map<string, string>;
}

export function parsePathFacts(text: string, input: string, kindLabel = 'path'): ParsedPathFacts {
  const raw = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^P_([A-Z_]+)=(.*)$/.exec(line);
    if (match) raw.set(match[1], match[2]);
  }
  const exists = raw.size > 0 && !raw.has('ERROR') && raw.get('EXISTS') !== '0';
  const isDirectory = raw.get('ISDIR') === '1';
  const realPath = raw.get('REAL') ?? null;
  const dfFields = (raw.get('DF') ?? '').trim().split(/\s+/);
  const freeBytes = dfFields.length >= 4 && /^\d+$/.test(dfFields[3])
    ? Number(dfFields[3]) * 1024
    : null;
  const fstype = raw.get('FSTYPE')?.trim() || '';
  const fsSource = raw.get('FSSOURCE')?.trim() || '';
  const fsTarget = raw.get('FSTARGET')?.trim() || '';
  const error = raw.get('ERROR') ?? (raw.size === 0 ? `${kindLabel} probe returned no facts` : null);
  const nearest = raw.get('NEAREST') ?? null;
  return {
    input,
    normalized: input,
    realPath,
    exists,
    isDirectory,
    isFinalSymlink: raw.get('FINAL_LINK') === '1',
    hasSymlinkAncestor: raw.get('ANCESTOR_LINK') === '1',
    owner: raw.get('OWNER')?.trim() || null,
    group: raw.get('GROUP')?.trim() || null,
    mode: raw.get('MODE')?.trim() || null,
    readableByUser: raw.get('USER_R') === '1',
    writableByUser: raw.get('USER_W') === '1',
    readableBySudo: raw.get('SUDO_R') === '1',
    writableBySudo: raw.get('SUDO_W') === '1',
    parentWritableByUser: raw.has('PARENT_W') ? raw.get('PARENT_W') === '1' : null,
    nearestExistingAncestor: exists ? null : nearest,
    filesystem: fstype ? { type: fstype, source: fsSource, mountPoint: fsTarget } : null,
    freeBytes,
    mountInFstab: null,
    probeError: error,
    raw,
  };
}

export interface InventorySummary {
  stackCount: number;
  stackNames: string[];
  truncated: boolean;
  rootComposeFile: boolean;
}

export function parseComposeInventory(text: string, composeDir: string, cap = 500, outputTruncated = false): InventorySummary {
  const normalizedDir = composeDir.endsWith('/') ? composeDir.slice(0, -1) : composeDir;
  const entries = text.split('\0').filter((entry) => entry.length > 0);
  const names = new Set<string>();
  let rootComposeFile = false;
  let truncated = false;
  for (const entry of entries.slice(0, cap)) {
    if (!entry.startsWith(`${normalizedDir}/`)) continue;
    const relative = entry.slice(normalizedDir.length + 1);
    const parts = relative.split('/').filter(Boolean);
    if (parts.length === 1) {
      rootComposeFile = true;
      continue;
    }
    if (parts.length >= 2) names.add(parts[0]);
  }
  if (entries.length > cap || outputTruncated) truncated = true;
  const stackNames = [...names].sort();
  return {
    stackCount: stackNames.length,
    stackNames: stackNames.slice(0, 50),
    truncated: truncated || stackNames.length > 50,
    rootComposeFile,
  };
}

export interface AgentInventorySummary {
  entries: string[];
  entriesTruncated: boolean;
  hasComposeFile: boolean;
  hasCaFile: boolean;
}

export function parseAgentInventory(text: string, outputTruncated = false): AgentInventorySummary {
  const entries = text.split('\0').filter((entry) => entry.length > 0);
  return {
    entries: entries.slice(0, 50),
    entriesTruncated: entries.length > 50 || outputTruncated,
    hasComposeFile: entries.includes('compose.yaml'),
    hasCaFile: entries.some((entry) => entry === 'sencho-hub-ca.pem'),
  };
}

export interface MarkerSummary {
  hasMarker: boolean;
  markerProject: string | null;
  markerComposeDir: string | null;
  markerAgentDir: string | null;
}

export function parseBootstrapMarker(text: string): MarkerSummary {
  const trimmed = text.trim();
  if (!trimmed) return { hasMarker: false, markerProject: null, markerComposeDir: null, markerAgentDir: null };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      hasMarker: true,
      markerProject: typeof parsed.project === 'string' ? parsed.project : null,
      markerComposeDir: typeof parsed.composeDir === 'string' ? parsed.composeDir : null,
      markerAgentDir: typeof parsed.agentDir === 'string' ? parsed.agentDir : null,
    };
  } catch {
    // A malformed marker is not our marker; the directory then blocks as unrelated content.
    return { hasMarker: false, markerProject: null, markerComposeDir: null, markerAgentDir: null };
  }
}

export function parseDfFreeBytes(text: string): number | null {
  const fields = text.trim().split(/\s+/);
  if (fields.length < 4 || !/^\d+$/.test(fields[3])) return null;
  return Number(fields[3]) * 1024;
}

// --- Fact assembly -------------------------------------------------------

export interface AssembleFactsInput {
  target: BootstrapFacts['target'];
  hostKey: HostKeyObservation;
  hubUrl: string;
  composeDir: string;
  agentDir: string;
  results: SshCommandResult[];
  fstabMountPoints: string[];
  now: number;
}

function resultMap(results: SshCommandResult[]): Map<string, SshCommandResult> {
  const map = new Map<string, SshCommandResult>();
  for (const result of results) map.set(result.id, result);
  return map;
}

function stdoutOf(map: Map<string, SshCommandResult>, id: string): string {
  const result = map.get(id);
  if (!result || result.timedOut) return '';
  return result.stdout;
}

function succeeded(map: Map<string, SshCommandResult>, id: string): boolean {
  const result = map.get(id);
  return Boolean(result && !result.timedOut && result.exitCode === 0);
}

function isProbeUnknown(map: Map<string, SshCommandResult>, id: string): boolean {
  const result = map.get(id);
  return !result || result.timedOut || result.truncated;
}

function pickInventoryResult(
  map: Map<string, SshCommandResult>,
  directId: string,
  sudoId: string,
): SshCommandResult | undefined {
  const direct = map.get(directId);
  if (direct && direct.exitCode === 0) return direct;
  return map.get(sudoId) ?? direct;
}

function isUnderAnyMount(path: string, mountPoints: string[]): boolean {
  return mountPoints.some((mount) => mount === path || (mount !== '/' && path.startsWith(`${mount}/`)));
}

export function assembleFacts(input: AssembleFactsInput): BootstrapFacts {
  const map = resultMap(input.results);
  const osBase = parseOsRelease(stdoutOf(map, 'os_release'));
  const uname = parseUname(stdoutOf(map, 'uname'));
  const userBase = parseUser(stdoutOf(map, 'user'));
  const sudoAvailable = succeeded(map, 'sudo');

  const directDocker = parseDockerInfo(stdoutOf(map, 'docker_info'));
  const sudoDocker = parseDockerInfo(stdoutOf(map, 'docker_info_sudo'));
  const dockerInfo = directDocker ?? sudoDocker;
  const socketAccess: BootstrapFacts['docker']['socketAccess'] = directDocker
    ? 'user'
    : sudoDocker
      ? 'sudo'
      : 'none';

  const composeVersion = parseComposeVersion(stdoutOf(map, 'compose_version'))
    ?? parseComposeVersion(stdoutOf(map, 'compose_version_sudo'));
  const repo = parseDockerRepo(stdoutOf(map, 'docker_repo'));
  const packages = parseAptPolicy(stdoutOf(map, 'apt_policy'));
  const containers = parseContainers(
    stdoutOf(map, 'containers') || stdoutOf(map, 'containers_sudo'),
  );
  const volumeName = parseVolumeName(stdoutOf(map, 'agent_volume') || stdoutOf(map, 'agent_volume_sudo'));
  const clockMs = parseEpochSeconds(stdoutOf(map, 'clock'));
  const hubHealth = map.get('hub_health')
    ? parseHubHealth(map.get('hub_health') as SshCommandResult)
    : { reachable: null, statusCode: null, tlsTrusted: null };

  const composeFacts = parsePathFacts(stdoutOf(map, 'path_compose'), input.composeDir, 'Compose directory');
  const agentFacts = parsePathFacts(stdoutOf(map, 'path_agent'), input.agentDir, 'Agent directory');
  const { raw: _composeRaw, ...composeBase } = composeFacts;
  const { raw: _agentRaw, ...agentBase } = agentFacts;

  const composeInventoryResult = pickInventoryResult(map, 'compose_inventory', 'compose_inventory_sudo');
  const composeInventory = parseComposeInventory(
    composeInventoryResult?.stdout ?? '',
    input.composeDir,
    500,
    composeInventoryResult?.truncated === true,
  );
  const agentInventoryResult = pickInventoryResult(map, 'agent_inventory', 'agent_inventory_sudo');
  const agentInventory = parseAgentInventory(
    agentInventoryResult?.stdout ?? '',
    agentInventoryResult?.truncated === true,
  );
  const marker = parseBootstrapMarker(stdoutOf(map, 'agent_marker') || stdoutOf(map, 'agent_marker_sudo'));

  const composeDir: ComposeDirObservation = {
    ...composeBase,
    mountInFstab: composeBase.filesystem ? isUnderAnyMount(composeBase.filesystem.mountPoint, input.fstabMountPoints) : null,
    stackCount: composeBase.exists ? composeInventory.stackCount : null,
    stackNames: composeBase.exists ? composeInventory.stackNames : [],
    inventoryTruncated: composeInventory.truncated,
    rootComposeFile: composeInventory.rootComposeFile,
  };
  const agentDir: AgentDirObservation = {
    ...agentBase,
    mountInFstab: agentBase.filesystem ? isUnderAnyMount(agentBase.filesystem.mountPoint, input.fstabMountPoints) : null,
    ...agentInventory,
    ...marker,
  };

  const agentContainers = containers.filter((row) => row.project === 'sencho-agent');
  const agentInstall: AgentInstallObservation = {
    projectContainers: agentContainers.map((row) => ({
      name: row.name,
      workingDir: row.workingDir,
      configFiles: null,
      image: row.image,
      status: row.status,
    })),
    dataVolumeExists: dockerInfo ? volumeName === 'sencho-agent-data' : null,
    defaultDirHasComposeFile: stdoutOf(map, 'default_agent_path').trim() === 'yes',
  };

  const dockerRootFreeBytes = parseDfFreeBytes(stdoutOf(map, 'docker_root_disk'));

  return {
    target: input.target,
    hostKey: input.hostKey,
    os: osBase ? { ...osBase, arch: uname.arch, kernel: uname.kernel } : null,
    user: userBase ? { ...userBase, sudoNonInteractive: sudoAvailable } : null,
    docker: {
      cliInstalled: succeeded(map, 'docker_cli'),
      serverVersion: dockerInfo?.serverVersion ?? null,
      composeVersion,
      serviceActive: stdoutOf(map, 'docker_service_active').trim() === 'active'
        ? true
        : isProbeUnknown(map, 'docker_service_active') ? null : false,
      serviceEnabled: ['enabled', 'enabled-runtime'].includes(stdoutOf(map, 'docker_service_enabled').trim())
        ? true
        : isProbeUnknown(map, 'docker_service_enabled') ? null : false,
      socketAccess,
      rootDir: dockerInfo?.rootDir ?? null,
    },
    repo,
    packages,
    paths: { composeDir, agentDir },
    agent: agentInstall,
    dockerRoot: {
      path: dockerInfo?.rootDir ?? null,
      freeBytes: dockerRootFreeBytes,
      // Only claim a type when the Docker root is the Compose path itself; the
      // df probe does not report the Docker root's own filesystem type.
      filesystemType: dockerInfo?.rootDir && dockerInfo.rootDir === composeFacts.input
        ? (composeFacts.filesystem?.type ?? null)
        : null,
    },
    containers: {
      total: containers.length,
      sample: containers.slice(0, 10).map((row) => ({ name: row.name, image: row.image, project: row.project })),
      agentContainer: agentContainers[0]?.name ?? null,
    },
    clockSkewMs: clockMs === null ? null : Math.abs(input.now - clockMs),
    hub: {
      url: input.hubUrl,
      reachable: hubHealth.reachable,
      statusCode: hubHealth.statusCode,
      tlsTrusted: hubHealth.tlsTrusted,
    },
  };
}

/** Reject anything that is not a valid absolute http(s) URL with a non-loopback host. */
export function validateHubUrl(raw: string): { ok: boolean; reason: string | null; loopback: boolean } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Hub URL must be a valid absolute URL.', loopback: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Hub URL must use http or https.', loopback: false };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Hub URL must not contain credentials.', loopback: false };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
  return { ok: true, reason: null, loopback };
}

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
 * Every Docker command runs against the host's own unix socket. The operator's
 * shell environment and ~/.docker/config.json can select a different, remote
 * context; an explicit default context plus DOCKER_HOST makes the inspected
 * daemon and the planned start command the same local daemon.
 */
export const DOCKER_LOCAL_ENDPOINT = 'unix:///var/run/docker.sock';
export const DOCKER_LOCAL_UNSET_ARGS = '-u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG';
export const DOCKER_LOCAL_ASSIGNMENTS = `DOCKER_CONTEXT=default DOCKER_HOST=${DOCKER_LOCAL_ENDPOINT}`;
export const DOCKER_LOCAL_ENV_ARGS = `${DOCKER_LOCAL_UNSET_ARGS} ${DOCKER_LOCAL_ASSIGNMENTS}`;
export const DOCKER_LOCAL_ENV = `env ${DOCKER_LOCAL_ENV_ARGS}`;
export const DOCKER_LOCAL_COMMAND = `${DOCKER_LOCAL_ENV} docker`;

/** Canonical Compose volume name: <project>_<volume key>. */
export const PILOT_DATA_VOLUME_CANONICAL = 'sencho-agent_sencho-agent-data';
export const PILOT_DATA_VOLUME_NAMES = ['sencho-agent-data', PILOT_DATA_VOLUME_CANONICAL] as const;

function volumeProbeScript(dockerPrefix: string): string {
  return [
    'ok=0',
    `for v in ${PILOT_DATA_VOLUME_NAMES.join(' ')}; do`,
    `  if out=$(${dockerPrefix} volume inspect "$v" --format '{{.Name}}' 2>/dev/null); then`,
    '    ok=1',
    '    [ -n "$out" ] && printf \'%s\\n\' "$out"',
    '  fi',
    'done',
    `if out=$(${dockerPrefix} volume ls --filter label=com.docker.compose.project=sencho-agent --format '{{.Name}}' 2>/dev/null); then`,
    '  ok=1',
    '  [ -n "$out" ] && printf \'%s\\n\' "$out"',
    'fi',
    '[ "$ok" = 1 ]',
  ].join('\n');
}
const DOCKER_VOLUME_PROBE = volumeProbeScript(DOCKER_LOCAL_COMMAND);
const DOCKER_VOLUME_PROBE_SUDO = volumeProbeScript(`sudo -n ${DOCKER_LOCAL_ENV} docker`);

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
  `if [ -e "$p" ] || [ -L "$p" ]; then printf 'P_EXISTS=1\\n'; else`,
  `  err=$(stat -L -- "$p" 2>&1 >/dev/null)`,
  `  case "$err" in`,
  `    ""|*"No such file or directory"*) ;;`,
  `    *) printf 'P_ERROR=stat:%s\\n' "$err" ;;`,
  `  esac`,
  `  printf 'P_EXISTS=0\\n'`,
  `fi`,
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
  // A missing path cannot be a findmnt target; the filesystem that will hold it
  // is the nearest existing ancestor. This is what makes persistence provable
  // before the directory exists.
  `printf 'P_FSTYPE=%s\\n' "$(findmnt -n -o FSTYPE --target "$d" 2>/dev/null)"`,
  `printf 'P_FSSOURCE=%s\\n' "$(findmnt -n -o SOURCE --target "$d" 2>/dev/null)"`,
  `printf 'P_FSTARGET=%s\\n' "$(findmnt -n -o TARGET --target "$d" 2>/dev/null)"`,
  `printf 'P_DF=%s\\n' "$(df -Pk -- "$d" 2>/dev/null | tail -n 1)"`,
].join('\n');

export const DOCKER_ROOT_DISK_SCRIPT = [
  `root=$(${DOCKER_LOCAL_COMMAND} info --format "{{.DockerRootDir}}" 2>/dev/null)`,
  `[ -n "$root" ] || root=$(sudo -n ${DOCKER_LOCAL_ENV} docker info --format "{{.DockerRootDir}}" 2>/dev/null)`,
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
    { id: 'docker_info', command: `${DOCKER_LOCAL_COMMAND} info --format '{{.ServerVersion}}|{{.DockerRootDir}}' 2>/dev/null`, directOnly: true },
    { id: 'docker_info_sudo', command: `sudo -n ${DOCKER_LOCAL_ENV} docker info --format '{{.ServerVersion}}|{{.DockerRootDir}}' 2>/dev/null`, requiresSudo: true },
    { id: 'compose_version', command: `${DOCKER_LOCAL_COMMAND} compose version --short 2>/dev/null`, directOnly: true },
    { id: 'compose_version_sudo', command: `sudo -n ${DOCKER_LOCAL_ENV} docker compose version --short 2>/dev/null`, requiresSudo: true },
    { id: 'docker_service_active', command: `systemctl is-active docker 2>/dev/null` },
    { id: 'docker_service_enabled', command: `systemctl is-enabled docker 2>/dev/null` },
    {
      id: 'docker_repo',
      command: [
        'for f in /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources; do',
        '  if [ -f "$f" ]; then',
        `    printf 'SOURCE_BEGIN=%s\\n' "$f"`,
        '    cat "$f" 2>/dev/null || printf \'SOURCE_UNREADABLE=1\\n\'',
        `    printf '\\nSOURCE_END=%s\\n' "$f"`,
        '  fi',
        'done',
        'for f in /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg /usr/share/keyrings/docker-archive-keyring.gpg; do',
        '  if [ -f "$f" ]; then',
        `    printf 'KEY_BEGIN=%s\\n' "$f"`,
        '    head -c 128 "$f" 2>/dev/null | base64 -w0 2>/dev/null || printf \'KEY_UNREADABLE=1\'',
        `    printf '\\nKEY_END=%s\\n' "$f"`,
        '  fi',
        'done',
        'true',
      ].join('\n'),
    },
    {
      id: 'apt_policy',
      command: `apt-cache policy docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null`,
    },
    {
      id: 'containers',
      command: `${DOCKER_LOCAL_COMMAND} ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.compose.project.working_dir"}}\\t{{.Status}}' 2>/dev/null`,
      directOnly: true,
    },
    {
      id: 'containers_sudo',
      command: `sudo -n ${DOCKER_LOCAL_ENV} docker ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.compose.project.working_dir"}}\\t{{.Status}}' 2>/dev/null`,
      requiresSudo: true,
    },
    { id: 'agent_volume', command: `sh -c ${shellQuote(DOCKER_VOLUME_PROBE)}`, directOnly: true },
    { id: 'agent_volume_sudo', command: `sh -c ${shellQuote(DOCKER_VOLUME_PROBE_SUDO)}`, requiresSudo: true },
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
const SAFE_REDIRECTS = /2>\/dev\/null|1>\/dev\/null|>\/dev\/null|2>&1|-o \/dev\/null/g;

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

export interface RepoFileObservation {
  path: string;
  content: string;
  readable: boolean;
}

export interface RepoProbeOutput {
  sources: RepoFileObservation[];
  keys: Array<{ path: string; bytes: Buffer | null }>;
}

function parseDelimitedBlocks(text: string, begin: string, end: string, unreadable: string): RepoFileObservation[] {
  const files: RepoFileObservation[] = [];
  let current: { path: string; lines: string[]; unreadable: boolean } | null = null;
  for (const line of text.split('\n')) {
    const beginMatch = new RegExp(`^${begin}=(.+)$`).exec(line);
    if (beginMatch) {
      current = { path: beginMatch[1], lines: [], unreadable: false };
      continue;
    }
    const endMatch = new RegExp(`^${end}=(.+)$`).exec(line);
    if (endMatch && current) {
      files.push({ path: current.path, content: current.lines.join('\n'), readable: !current.unreadable });
      current = null;
      continue;
    }
    if (!current) continue;
    if (line === unreadable) {
      current.unreadable = true;
      continue;
    }
    current.lines.push(line);
  }
  return files;
}

/** Parse the structured `docker_repo` probe output, never the file names alone. */
export function parseRepoProbeOutput(text: string): RepoProbeOutput {
  const sources = parseDelimitedBlocks(text, 'SOURCE_BEGIN', 'SOURCE_END', 'SOURCE_UNREADABLE=1');
  const keyFiles = parseDelimitedBlocks(text, 'KEY_BEGIN', 'KEY_END', 'KEY_UNREADABLE=1');
  const keys = keyFiles.map((file) => {
    const raw = file.content.trim();
    if (!file.readable || !raw) return { path: file.path, bytes: null };
    if (raw === 'KEY_UNREADABLE=1') return { path: file.path, bytes: null };
    try {
      return { path: file.path, bytes: Buffer.from(raw, 'base64') };
    } catch {
      return { path: file.path, bytes: null };
    }
  });
  return { sources, keys };
}

const OFFICIAL_DOCKER_URI = 'https://download.docker.com/linux/ubuntu';

function sourceOptions(optionText: string | undefined): Map<string, string> {
  const options = new Map<string, string>();
  if (!optionText) return options;
  for (const part of optionText.trim().replace(/^\[|\]$/g, '').split(/\s+/)) {
    const [key, value] = part.split('=');
    if (key && value) options.set(key.toLowerCase(), value);
  }
  return options;
}

function verifyListSource(content: string, codename: string, keyPaths: Set<string>): { ok: boolean; reason: string | null } {
  const active = content.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (active.length === 0) return { ok: false, reason: 'the Docker source file is empty' };
  for (const line of active) {
    const match = /^deb\s+(\[[^\]]*\]\s+)?(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) return { ok: false, reason: 'the Docker source line is not a valid apt entry' };
    const options = sourceOptions(match[1]);
    const uri = match[2];
    const suite = match[3];
    const components = match[4].split(/\s+/);
    if (uri !== OFFICIAL_DOCKER_URI) return { ok: false, reason: `the source points at ${uri}, not ${OFFICIAL_DOCKER_URI}` };
    if (!suite.split(/[,\s]+/).includes(codename)) return { ok: false, reason: `the suite is ${suite}, not ${codename}` };
    if (!components.includes('stable')) return { ok: false, reason: 'the source does not enable the stable component' };
    const signedBy = options.get('signed-by');
    if (!signedBy || !keyPaths.has(signedBy)) {
      return { ok: false, reason: 'the source does not name an installed Docker keyring through signed-by' };
    }
    const arch = options.get('arch');
    if (arch && !['amd64', 'arm64'].includes(arch)) return { ok: false, reason: `the source architecture ${arch} is not supported` };
  }
  return { ok: true, reason: null };
}

function parseDeb822(content: string): Array<Record<string, string>> {
  const paragraphs: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let lastKey: string | null = null;
  for (const rawLine of content.split('\n')) {
    if (!rawLine.trim()) {
      if (current && Object.keys(current).length > 0) paragraphs.push(current);
      current = null;
      lastKey = null;
      continue;
    }
    if (rawLine.startsWith('#') || rawLine.startsWith('!')) continue;
    if (/^\s/.test(rawLine) && current && lastKey) {
      current[lastKey] = `${current[lastKey]} ${rawLine.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    current ??= {};
    lastKey = match[1].toLowerCase();
    current[lastKey] = match[2];
  }
  if (current && Object.keys(current).length > 0) paragraphs.push(current);
  return paragraphs;
}

function verifyDeb822Source(content: string, codename: string, keyPaths: Set<string>): { ok: boolean; reason: string | null } {
  const paragraphs = parseDeb822(content);
  if (paragraphs.length === 0) return { ok: false, reason: 'the Docker deb822 source is empty' };
  for (const paragraph of paragraphs) {
    const uris = (paragraph.uris ?? '').split(/\s+/).filter(Boolean);
    const suites = (paragraph.suites ?? '').split(/[,\s]+/).filter(Boolean);
    const components = (paragraph.components ?? '').split(/[,\s]+/).filter(Boolean);
    if (uris.length !== 1 || uris[0] !== OFFICIAL_DOCKER_URI) {
      return { ok: false, reason: `the source points at ${paragraph.uris ?? 'no URI'}, not ${OFFICIAL_DOCKER_URI}` };
    }
    if (!suites.includes(codename)) return { ok: false, reason: `the suite is ${paragraph.suites ?? 'missing'}, not ${codename}` };
    if (!components.includes('stable')) return { ok: false, reason: 'the source does not enable the stable component' };
    const signedBy = (paragraph['signed-by'] ?? '').trim();
    if (!signedBy || !keyPaths.has(signedBy)) {
      return { ok: false, reason: 'the source does not name an installed Docker keyring through Signed-By' };
    }
  }
  return { ok: true, reason: null };
}

function keyLooksValid(path: string, bytes: Buffer | null): boolean {
  if (!bytes || bytes.length === 0) return false;
  const text = bytes.toString('utf8');
  if (text.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) return true;
  // Binary OpenPGP public-key packet (old-format tag 6).
  if (bytes[0] === 0x99 || bytes[0] === 0xc6) return true;
  return /\.gpg$/i.test(path) && bytes[0] === 0x98;
}

/**
 * Verify what the Docker apt source and keyring actually say. A file named
 * docker.list with an arbitrary URL is not the official repository, and an
 * unreadable file is unknown, never a pass.
 */
export function parseDockerRepo(text: string, codename = ''): import('./types').RepositoryObservation {
  const parsed = parseRepoProbeOutput(text);
  const verifiedKeys = parsed.keys.filter((key) => keyLooksValid(key.path, key.bytes));
  const keyPaths = new Set(verifiedKeys.map((key) => key.path));
  const keyringVerified = verifiedKeys.length > 0
    ? true
    : parsed.keys.length > 0
      ? parsed.keys.every((key) => key.bytes === null) ? null : false
      : false;

  let unreadableSource = false;
  let allReadableVerified = true;
  let problem: string | null = null;
  for (const source of parsed.sources) {
    if (!source.readable) {
      unreadableSource = true;
      problem ??= `${source.path} could not be read`;
      continue;
    }
    const verification = /\.sources$/i.test(source.path)
      ? verifyDeb822Source(source.content, codename, keyPaths)
      : verifyListSource(source.content, codename, keyPaths);
    if (!verification.ok) {
      allReadableVerified = false;
      problem ??= `${source.path}: ${verification.reason ?? 'not the official Docker repository'}`;
    }
  }
  const sourceVerified: boolean | null = unreadableSource
    ? null
    : parsed.sources.length === 0
      ? false
      : allReadableVerified;

  return {
    probeComplete: true,
    dockerSourceConfigured: parsed.sources.length > 0,
    keyringPresent: parsed.keys.length > 0,
    sourceVerified,
    keyringVerified,
    candidateSourceVerified: null,
    problem,
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
      current = { name, installedVersion: null, candidateVersion: null, candidateSource: null };
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
      continue;
    }
    // The version table lists the archive that serves each candidate.
    const source = /^\s+[\d*\s]+\s+(https?:\/\/\S+)/.exec(line);
    if (source && current.candidateVersion) current.candidateSource ??= source[1];
  }
  return DOCKER_PACKAGES.map((name) => packages.get(name) ?? {
    name,
    installedVersion: null,
    candidateVersion: null,
    candidateSource: null,
  });
}

export interface ContainerRow {
  name: string;
  image: string;
  project: string | null;
  workingDir: string | null;
  status: string;
}

export interface ContainerInventory {
  rows: ContainerRow[];
  truncated: boolean;
}

/**
 * Parse every container row. Collision and pilot detection must see the whole
 * list; display truncation happens later and never decides whether an existing
 * Pilot is absent.
 */
export function parseContainers(text: string, outputTruncated = false): ContainerInventory {
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
  }
  return { rows, truncated: outputTruncated };
}

/** Volume names from inspect and Compose-label output; only the Pilot data volume counts. */
export function parseVolumeNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const name = line.trim();
    if (!name) continue;
    if (name === 'sencho-agent-data' || name.endsWith('_sencho-agent-data')) names.add(name);
  }
  return [...names].sort();
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

function isOfficialDockerArchive(source: string | null | undefined): boolean {
  if (!source) return false;
  try {
    const url = new URL(source);
    return url.origin === 'https://download.docker.com' && url.pathname === '/linux/ubuntu';
  } catch {
    return false;
  }
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
  if (!result || result.timedOut || result.truncated || result.error) return '';
  return result.stdout;
}

function succeeded(map: Map<string, SshCommandResult>, id: string): boolean {
  const result = map.get(id);
  return Boolean(result && !result.timedOut && !result.truncated && !result.error && result.exitCode === 0);
}

function isProbeUnknown(map: Map<string, SshCommandResult>, id: string): boolean {
  const result = map.get(id);
  return !result || result.timedOut || result.truncated || Boolean(result.error);
}

interface InventoryOutcome {
  text: string;
  complete: boolean;
  error: string | null;
  truncated: boolean;
}

function isCompleteResult(result: SshCommandResult | undefined): result is SshCommandResult {
  return Boolean(result && !result.timedOut && !result.truncated && !result.error && result.exitCode === 0);
}

/**
 * A successful direct or sudo inventory. Anything else keeps its partial text
 * for positive findings but is reported as incomplete, so an unreadable
 * directory is never mistaken for an empty one.
 */
function inventoryOutcome(
  map: Map<string, SshCommandResult>,
  directId: string,
  sudoId: string,
): InventoryOutcome {
  const candidates = [map.get(directId), map.get(sudoId)].filter((entry): entry is SshCommandResult => Boolean(entry));
  const complete = candidates.find(isCompleteResult);
  if (complete) return { text: complete.stdout, complete: true, error: null, truncated: false };
  const partial = candidates.find((result) => !result.timedOut || result.truncated);
  const reasons = candidates.map((result) => (
    result.timedOut ? 'timed out' : result.truncated ? 'output truncated' : result.error ? result.error : `exited ${result.exitCode ?? 'without a status'}`
  ));
  if (reasons.length === 0) reasons.push('not run');
  return {
    text: partial?.stdout ?? '',
    complete: false,
    error: reasons.join('; '),
    truncated: partial?.truncated === true,
  };
}

function firstComplete(
  map: Map<string, SshCommandResult>,
  directId: string,
  sudoId: string,
): { result: SshCommandResult | null; error: string | null } {
  const candidates = [map.get(directId), map.get(sudoId)].filter((entry): entry is SshCommandResult => Boolean(entry));
  const complete = candidates.find(isCompleteResult);
  if (complete) return { result: complete, error: null };
  const reasons = candidates.map((result) => (
    result.timedOut ? 'timed out' : result.truncated ? 'output truncated' : result.error ? result.error : `exited ${result.exitCode ?? 'without a status'}`
  ));
  if (reasons.length === 0) reasons.push('not run');
  return { result: null, error: reasons.join('; ') };
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
  const cliInstalled = succeeded(map, 'docker_cli');
  const cliProbeUnknown = isProbeUnknown(map, 'docker_cli');

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
  const repoProbe = map.get('docker_repo');
  const repoBase = repoProbe && !repoProbe.timedOut && !repoProbe.truncated
    && !repoProbe.error && repoProbe.exitCode === 0
    ? parseDockerRepo(repoProbe.stdout, osBase?.codename ?? '')
    : {
      probeComplete: false,
      dockerSourceConfigured: false,
      keyringPresent: false,
      sourceVerified: null,
      keyringVerified: null,
      candidateSourceVerified: null,
      problem: 'the repository probe did not complete',
    };
  const packages = parseAptPolicy(stdoutOf(map, 'apt_policy'));
  const candidatesWithSource = packages.filter((pkg) => pkg.candidateVersion !== null);
  const candidateSourceVerified = candidatesWithSource.length === 0
    || candidatesWithSource.every((pkg) => !pkg.candidateSource)
    ? null
    : candidatesWithSource.every((pkg) => isOfficialDockerArchive(pkg.candidateSource)) ? true : false;
  const repo: BootstrapFacts['repo'] = { ...repoBase, candidateSourceVerified };

  const containerOutcome = inventoryOutcome(map, 'containers', 'containers_sudo');
  const containerInventory = parseContainers(containerOutcome.text, containerOutcome.truncated);
  const containersComplete = containerOutcome.complete;
  const volumeOutcome = firstComplete(map, 'agent_volume', 'agent_volume_sudo');
  const volumeNames = volumeOutcome.result ? parseVolumeNames(volumeOutcome.result.stdout) : [];
  const clockMs = parseEpochSeconds(stdoutOf(map, 'clock'));
  const hubHealth = map.get('hub_health')
    ? parseHubHealth(map.get('hub_health') as SshCommandResult)
    : { reachable: null, statusCode: null, tlsTrusted: null };

  const composeFacts = parsePathFacts(stdoutOf(map, 'path_compose'), input.composeDir, 'Compose directory');
  const agentFacts = parsePathFacts(stdoutOf(map, 'path_agent'), input.agentDir, 'Agent directory');
  const { raw: _composeRaw, ...composeBase } = composeFacts;
  const { raw: _agentRaw, ...agentBase } = agentFacts;

  const composeOutcome = inventoryOutcome(map, 'compose_inventory', 'compose_inventory_sudo');
  const composeInventory = composeBase.exists
    ? parseComposeInventory(composeOutcome.text, input.composeDir, 500, composeOutcome.truncated)
    : { stackCount: 0, stackNames: [], truncated: false, rootComposeFile: false };
  const agentOutcome = inventoryOutcome(map, 'agent_inventory', 'agent_inventory_sudo');
  const agentInventory = parseAgentInventory(agentOutcome.text, agentOutcome.truncated);
  const marker = parseBootstrapMarker(stdoutOf(map, 'agent_marker') || stdoutOf(map, 'agent_marker_sudo'));

  const composeDir: ComposeDirObservation = {
    ...composeBase,
    mountInFstab: composeBase.filesystem ? isUnderAnyMount(composeBase.filesystem.mountPoint, input.fstabMountPoints) : null,
    stackCount: composeBase.exists && composeOutcome.complete ? composeInventory.stackCount : null,
    stackNames: composeBase.exists ? composeInventory.stackNames : [],
    inventoryTruncated: composeInventory.truncated,
    inventoryError: composeBase.exists ? composeOutcome.error : null,
    rootComposeFile: composeInventory.rootComposeFile,
  };
  const agentDir: AgentDirObservation = {
    ...agentBase,
    mountInFstab: agentBase.filesystem ? isUnderAnyMount(agentBase.filesystem.mountPoint, input.fstabMountPoints) : null,
    ...agentInventory,
    inventoryError: agentBase.exists ? agentOutcome.error : null,
    ...marker,
  };

  const agentContainers = containerInventory.rows.filter((row) => row.project === 'sencho-agent');
  const agentInstall: AgentInstallObservation = {
    projectContainers: agentContainers.map((row) => ({
      name: row.name,
      workingDir: row.workingDir,
      configFiles: null,
      image: row.image,
      status: row.status,
    })),
    dataVolumeExists: dockerInfo
      ? volumeOutcome.result ? volumeNames.length > 0 : null
      : cliProbeUnknown || cliInstalled ? null : false,
    dataVolumeNames: volumeNames,
    defaultDirHasComposeFile: stdoutOf(map, 'default_agent_path').trim() === 'yes',
  };

  const dockerRootFreeBytes = parseDfFreeBytes(stdoutOf(map, 'docker_root_disk'));

  return {
    target: input.target,
    hostKey: input.hostKey,
    os: osBase ? { ...osBase, arch: uname.arch, kernel: uname.kernel } : null,
    user: userBase ? { ...userBase, sudoNonInteractive: sudoAvailable } : null,
    docker: {
      cliInstalled,
      cliProbeUnknown,
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
      endpoint: DOCKER_LOCAL_ENDPOINT,
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
      total: containerInventory.rows.length,
      sample: containerInventory.rows.slice(0, 10).map((row) => ({ name: row.name, image: row.image, project: row.project })),
      agentContainer: agentContainers[0]?.name ?? null,
      complete: containersComplete,
      error: containerOutcome.error,
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

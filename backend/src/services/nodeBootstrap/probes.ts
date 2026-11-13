import net from 'net';
import { DEFAULT_AGENT_DIR, RESERVED_PATH_PREFIXES, SEALED_DIRECTORY_SHELL, shellQuote } from './pathPolicy';
import type {
  AgentDirObservation,
  AgentInstallObservation,
  BootstrapFacts,
  CandidateSource,
  ComposeDirObservation,
  DockerPackage,
  DockerPackageName,
  HostKeyObservation,
  PathObservation,
  RepositoryObservation,
  TrustChain,
} from './types';
import { isDockerReleaseKeyFile } from './openpgpKey';
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

/** Where a first Docker install puts its root, used only when no Docker CLI exists. */
export const DEFAULT_DOCKER_ROOT = '/var/lib/docker';

/** Docker's release key is under 4 KiB; a keyring past this cap is not read as one. */
const KEY_READ_BYTES = 12_288;

const COMPOSE_FILE_NAMES = `\\( -name 'compose.yaml' -o -name 'compose.yml' -o -name 'docker-compose.yaml' -o -name 'docker-compose.yml' \\)`;

/** The candidate query for every Docker package, shared by the preflight and the run's pre-install check. */
export const APT_POLICY_COMMAND = 'apt-cache policy docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null';

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
const DOCKER_LOCAL_SUDO_COMMAND = `sudo -n ${DOCKER_LOCAL_COMMAND}`;
const DOCKER_INFO_ARGS = `info --format '{{.ServerVersion}}|{{.DockerRootDir}}' 2>/dev/null`;
const DOCKER_PS_ARGS = `ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.compose.project.working_dir"}}\\t{{.Status}}' 2>/dev/null`;

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
const DOCKER_VOLUME_PROBE_SUDO = volumeProbeScript(DOCKER_LOCAL_SUDO_COMMAND);

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
  // The identity of the directory a path resolves to (device, inode, owner and birth time, as the execution scripts take it, with the time zone pinned so it reads the same in any session): execution writes only into this very directory.
  `if [ -d "$p" ]; then printf 'P_IDENT=%s\\n' "$(TZ=UTC0 stat -L -c '%d:%i:%u:%w' -- "$p" 2>/dev/null | tr -d ' ')"; fi`,
  `if [ -d "$d" ]; then printf 'P_NEAREST_IDENT=%s\\n' "$(TZ=UTC0 stat -L -c '%d:%i:%u:%w' -- "$d" 2>/dev/null | tr -d ' ')"; fi`,
  `if [ -w "$d" ]; then printf 'P_PARENT_W=1\\n'; else printf 'P_PARENT_W=0\\n'; fi`,
  // Who could change the directories the start step relies on (see SEALED_DIRECTORY_SHELL): the chain from the path itself (its files), and the chain above it (the place it is mounted from).
  SEALED_DIRECTORY_SHELL,
  `trust_line() { n=$1; shift; sealed "$@" && r=0 || r=$?; case $r in 0) printf 'P_%s=ok\\n' "$n" ;; 1) printf 'P_%s=open:%s\\n' "$n" "$bad" ;; *) printf 'P_%s=unreadable:%s\\n' "$n" "$bad" ;; esac; }`,
  `if [ -d "$real" ]; then trust_line TRUST_SELF "$real"; trust_line TRUST_ABOVE "$real" above; elif [ -d "$d" ]; then trust_line TRUST_SELF "$d"; trust_line TRUST_ABOVE "$d"; fi`,
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

/**
 * Measures the filesystem that holds the Docker root the daemon reports. It
 * never substitutes a guess for a root it could not read: the default path is
 * measured only when no Docker CLI exists at all (a fresh install lands there),
 * and a CLI whose daemon will not answer reports no measurement.
 */
export const DOCKER_ROOT_DISK_SCRIPT = [
  `root=$(${DOCKER_LOCAL_COMMAND} info --format "{{.DockerRootDir}}" 2>/dev/null)`,
  `[ -n "$root" ] || root=$(${DOCKER_LOCAL_SUDO_COMMAND} info --format "{{.DockerRootDir}}" 2>/dev/null)`,
  'if [ -n "$root" ]; then src=daemon',
  'elif ! command -v docker >/dev/null 2>&1; then root=' + DEFAULT_DOCKER_ROOT + '; src=default',
  'else src=unavailable',
  'fi',
  `printf 'D_SOURCE=%s\n' "$src"`,
  '[ "$src" != unavailable ] || exit 0',
  `printf 'D_ROOT=%s\n' "$root"`,
  'd="$root"',
  // Walk up only past a path that is missing. A path that cannot be inspected
  // (a closed parent directory) stops the walk, and the failed df then reads as
  // an unmeasured root, not as the capacity of some ancestor.
  'while [ "$d" != "/" ]; do',
  '  err=$(LC_ALL=C stat -L -- "$d" 2>&1 >/dev/null)',
  '  case "$err" in',
  '    *"No such file or directory"*|*"Not a directory"*) d=$(dirname -- "$d");;',
  '    *) break;;',
  '  esac',
  'done',
  `printf 'D_DF=%s\n' "$(df -Pk -- "$d" 2>/dev/null | tail -n 1)"`,
].join('\n');

export const DEFAULT_AGENT_COMPOSE = `${DEFAULT_AGENT_DIR}/compose.yaml`;

/**
 * Looks for the default installation's Compose file and tells absence apart
 * from an inspection that could not be made: a denied ancestor makes a plain
 * `test -f` read as absent, so the failure text of `stat` decides. `LC_ALL=C`
 * is set inside the script because `sudo` may reset the caller's environment.
 * A found file is followed by the real path of the directory it was looked for
 * in, so a chosen directory that is the same place under another name is
 * recognized.
 */
export const DEFAULT_AGENT_PATH_SCRIPT = [
  'p="$1"',
  'if [ -f "$p" ]; then',
  '  printf \'yes\\n\'',
  '  r=$(readlink -f -- "${p%/*}" 2>/dev/null)',
  '  printf \'real=%s\\n\' "$r"',
  'else',
  '  err=$(LC_ALL=C stat -L -- "$p" 2>&1 >/dev/null)',
  '  case "$err" in',
  '    ""|*"No such file or directory"*|*"Not a directory"*) printf \'no\\n\';;',
  '    *) printf \'error\\n\';;',
  '  esac',
  'fi',
].join('\n');

/** The files and directories apt reads its sources from by default. */
const DEFAULT_SOURCE_LIST = '/etc/apt/sources.list';
const DEFAULT_SOURCE_PARTS = '/etc/apt/sources.list.d';
const REPO_KEY_PATHS = ['/etc/apt/keyrings/docker.asc', '/etc/apt/keyrings/docker.gpg', '/usr/share/keyrings/docker-archive-keyring.gpg'];

/** The file names the preflight always reads and checks whatever they say: the plan's own docker.list, and docker.sources, the deb822 name Docker documents. Keep in step with the case pattern in the probe script. */
const CONVENTIONAL_SOURCE_FILE = /(?:^|\/)docker\.(?:list|sources)$/;

/**
 * A file `[ -f ]` does not see is absent only when `stat` says so. Behind a
 * closed directory the same test also reads false, so that case reports the
 * file as unreadable rather than letting a wrong or insecure entry go unseen.
 */
function repoUnreadableWhenInaccessible(marker: string, indent = '  '): string[] {
  return [
    `${indent}else`,
    `${indent}  err=$(LC_ALL=C stat -L -- "$f" 2>&1 >/dev/null)`,
    `${indent}  case "$err" in`,
    `${indent}    ""|*"No such file or directory"*|*"Not a directory"*) ;;`,
    `${indent}    *) printf '${marker}_BEGIN=%s\\n${marker}_UNREADABLE=1\\n${marker}_END=%s\\n' "$f" "$f";;`,
    `${indent}  esac`,
  ];
}

/**
 * Asks apt where it reads its sources from (`Dir::Etc::sourcelist` and
 * `Dir::Etc::sourceparts`, resolved against the rest of its configuration),
 * reports both answers as read, then points the scan at them. An answer apt
 * could not give leaves the scan on the defaults, and the parser reads the
 * empty report as unknown.
 */
const APT_SOURCE_LOCATIONS_PRELUDE = [
  // stderr is kept: apt-config exits 0 beside "W: Unable to read ..." when a
  // configuration file is closed to this user, and its answer is then not the
  // one apt gives root.
  'cfg=$(apt-config shell m Dir::Etc::sourcelist/f p Dir::Etc::sourceparts/d 2>&1)',
  String.raw`apt_main=$(printf '%s\n' "$cfg" | sed -n "s/^m='\(.*\)'\$/\1/p")`,
  String.raw`apt_parts=$(printf '%s\n' "$cfg" | sed -n "s/^p='\(.*\)'\$/\1/p")`,
  // Anything but the two plain assignments (a warning, an error, a value that
  // holds a quote or backslash apt-config escapes) leaves the locations unestablished.
  String.raw`[ -z "$(printf '%s\n' "$cfg" | grep -v -e "^[mp]='[^'\\]*'\$")" ] || { apt_main=; apt_parts=; }`,
  'apt_parts=${apt_parts%/}',
  `printf 'SOURCE_LOCATIONS_MAIN=%s\\nSOURCE_LOCATIONS_PARTS=%s\\n' "$apt_main" "$apt_parts"`,
  `[ -n "$apt_main" ] || apt_main=${DEFAULT_SOURCE_LIST}`,
  `[ -n "$apt_parts" ] || apt_parts=${DEFAULT_SOURCE_PARTS}`,
];

/**
 * Reads the apt source files in the given locations: the main source list
 * and each `.list` and `.sources` file in the source directories, named as apt
 * accepts them. The locations are shell words spliced in as written (the
 * production call passes the variables the prelude sets), not paths to quote.
 * Only a file that mentions Docker's host (or is docker.list or docker.sources) is
 * printed, which keeps unrelated sources out of the capped output. A double
 * quote or a `%XX` escape counts as a mention too, because apt reads both inside
 * a word of a one-line entry and either can hide the host's name; a file or a
 * directory that cannot be read is reported as unreadable, never as absent. The
 * keyrings are read in full (up to the key cap).
 */
export function buildDockerRepoScript(
  sourceFiles: string[],
  sourceDirs: string[],
  keyPaths: string[],
  prelude: string[] = [],
): string {
  return [
    ...prelude,
    'emit_source() {',
    '  f="$1"',
    '  if [ -f "$f" ]; then',
    '    want=0',
    '    case "$f" in */docker.list|*/docker.sources) want=1;; esac',
    '    if [ "$want" = 0 ]; then',
    '      grep -qiE -e \'download\\.docker\\.com|%[0-9a-f][0-9a-f]|"\' -- "$f" 2>/dev/null',
    '      case $? in',
    '        0) want=1;;',
    '        1) ;;',
    `        *) printf 'SOURCE_BEGIN=%s\\nSOURCE_UNREADABLE=1\\nSOURCE_END=%s\\n' "$f" "$f";;`,
    '      esac',
    '    fi',
    '    if [ "$want" = 1 ]; then',
    `      printf 'SOURCE_BEGIN=%s\\n' "$f"`,
    '      cat "$f" 2>/dev/null || printf \'\\nSOURCE_UNREADABLE=1\\n\'',
    `      printf '\\nSOURCE_END=%s\\n' "$f"`,
    '    fi',
    ...repoUnreadableWhenInaccessible('SOURCE'),
    '  fi',
    '}',
    `for f in ${sourceFiles.join(' ')}; do`,
    '  emit_source "$f"',
    'done',
    `for d in ${sourceDirs.join(' ')}; do`,
    '  f="$d"',
    '  if [ -d "$d" ]; then',
    '    if [ -r "$d" ] && [ -x "$d" ]; then',
    '      for f in "$d"/*.list "$d"/*.sources; do',
    '        [ -e "$f" ] || [ -L "$f" ] || continue',
    '        name=${f##*/}',
    '        case "$name" in *[!A-Za-z0-9_.-]*) continue;; esac',
    '        emit_source "$f"',
    '      done',
    '    else',
    `      printf 'SOURCE_BEGIN=%s\\nSOURCE_UNREADABLE=1\\nSOURCE_END=%s\\n' "$d" "$d"`,
    '    fi',
    ...repoUnreadableWhenInaccessible('SOURCE'),
    '  fi',
    'done',
    `for f in ${keyPaths.join(' ')}; do`,
    '  if [ -f "$f" ]; then',
    `    printf 'KEY_BEGIN=%s\\n' "$f"`,
    // The whole file is read (up to the cap) so the key's identity can be
    // computed; the size line lets the parser tell a cut-off read from a file.
    // -L: the size must be the target's, as head reads through a symlink.
    `    printf 'KEY_SIZE=%s\\n' "$(stat -L -c %s -- "$f" 2>/dev/null)"`,
    `    head -c ${KEY_READ_BYTES} "$f" 2>/dev/null | base64 -w0 2>/dev/null || printf 'KEY_UNREADABLE=1'`,
    `    printf '\\nKEY_END=%s\\n' "$f"`,
    ...repoUnreadableWhenInaccessible('KEY'),
    '  fi',
    'done',
    'true',
  ].join('\n');
}

const DOCKER_REPO_SCRIPT = buildDockerRepoScript(['"$apt_main"'], ['"$apt_parts"'], REPO_KEY_PATHS, APT_SOURCE_LOCATIONS_PRELUDE);

/**
 * The whole catalog runs in one session. Sudo variants are always sent: `sudo -n`
 * refuses at once when a password would be needed, so a direct-access host pays
 * only for a fast failure.
 */
export type ProbeDefinition = SshCommand;

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
    { id: 'docker_info', command: `${DOCKER_LOCAL_COMMAND} ${DOCKER_INFO_ARGS}` },
    { id: 'docker_info_sudo', command: `${DOCKER_LOCAL_SUDO_COMMAND} ${DOCKER_INFO_ARGS}` },
    { id: 'compose_version', command: `${DOCKER_LOCAL_COMMAND} compose version --short 2>/dev/null` },
    { id: 'compose_version_sudo', command: `${DOCKER_LOCAL_SUDO_COMMAND} compose version --short 2>/dev/null` },
    { id: 'docker_service_active', command: `systemctl is-active docker 2>/dev/null` },
    { id: 'docker_service_enabled', command: `systemctl is-enabled docker 2>/dev/null` },
    { id: 'docker_repo', command: `sh -c ${shellQuote(DOCKER_REPO_SCRIPT)}` },
    {
      id: 'apt_policy',
      command: APT_POLICY_COMMAND,
    },
    { id: 'containers', command: `${DOCKER_LOCAL_COMMAND} ${DOCKER_PS_ARGS}` },
    { id: 'containers_sudo', command: `${DOCKER_LOCAL_SUDO_COMMAND} ${DOCKER_PS_ARGS}` },
    { id: 'agent_volume', command: `sh -c ${shellQuote(DOCKER_VOLUME_PROBE)}` },
    { id: 'agent_volume_sudo', command: `sh -c ${shellQuote(DOCKER_VOLUME_PROBE_SUDO)}` },
    { id: 'clock', command: `date +%s` },
    {
      id: 'hub_health',
      command: `curl -sS --max-time 6 -o /dev/null -w '%{http_code}' ${hub}/api/health`,
    },
    { id: 'path_compose', command: `sh -c ${shellQuote(PATH_FACTS_SCRIPT)} sencho-probe ${compose}` },
    { id: 'path_agent', command: `sh -c ${shellQuote(PATH_FACTS_SCRIPT)} sencho-probe ${agent}` },
    {
      id: 'compose_inventory',
      command: `sh -c ${shellQuote(guardedInventoryScript(`find "$p" -mindepth 1 -maxdepth 2 -type f ${COMPOSE_FILE_NAMES} -print0 2>/dev/null`))} sencho-inventory ${compose}`,
    },
    {
      id: 'compose_inventory_sudo',
      command: `sh -c ${shellQuote(guardedInventoryScript(`sudo -n find "$p" -mindepth 1 -maxdepth 2 -type f ${COMPOSE_FILE_NAMES} -print0 2>/dev/null`))} sencho-inventory ${compose}`,
    },
    {
      id: 'agent_inventory',
      command: `sh -c ${shellQuote(guardedInventoryScript(`find "$p" -mindepth 1 -maxdepth 1 -printf '%f\\0' 2>/dev/null`))} sencho-inventory ${agent}`,
    },
    {
      id: 'agent_inventory_sudo',
      command: `sh -c ${shellQuote(guardedInventoryScript(`sudo -n find "$p" -mindepth 1 -maxdepth 1 -printf '%f\\0' 2>/dev/null`))} sencho-inventory ${agent}`,
    },
    {
      id: 'agent_marker',
      command: `sh -c ${shellQuote(guardedInventoryScript(`cat "$p/sencho-bootstrap.json" 2>/dev/null`))} sencho-inventory ${agent}`,
    },
    {
      id: 'agent_marker_sudo',
      command: `sh -c ${shellQuote(guardedInventoryScript(`sudo -n cat "$p/sencho-bootstrap.json" 2>/dev/null`))} sencho-inventory ${agent}`,
    },
    { id: 'default_agent_path', command: `sh -c ${shellQuote(DEFAULT_AGENT_PATH_SCRIPT)} sencho-probe ${shellQuote(DEFAULT_AGENT_COMPOSE)}` },
    { id: 'default_agent_path_sudo', command: `sudo -n sh -c ${shellQuote(DEFAULT_AGENT_PATH_SCRIPT)} sencho-probe ${shellQuote(DEFAULT_AGENT_COMPOSE)}` },
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
  // A daemon that cannot be reached still prints the empty template ("|"), so
  // an answer without a server version is no answer.
  if (!version.trim()) return null;
  return {
    serverVersion: version.trim(),
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

export interface RepoKeyObservation {
  path: string;
  /** Null when the file could not be read in full. */
  bytes: Buffer | null;
}

export interface RepoProbeOutput {
  sources: RepoFileObservation[];
  keys: RepoKeyObservation[];
}

function parseDelimitedBlocks(text: string, begin: string, end: string, unreadable: string): RepoFileObservation[] {
  const files: RepoFileObservation[] = [];
  let current: { path: string; lines: string[]; unreadable: boolean } | null = null;
  for (const line of text.split('\n')) {
    const beginMatch = new RegExp(`^${begin}=(.+)$`).exec(line);
    if (beginMatch) {
      // A new block while one is open: the open one never ended.
      if (current) files.push({ path: current.path, content: '', readable: false });
      current = { path: beginMatch[1], lines: [], unreadable: false };
      continue;
    }
    const endMatch = new RegExp(`^${end}=(.+)$`).exec(line);
    if (endMatch && current && endMatch[1] === current.path) {
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
  // A block with no end marker means the output stopped mid-file: that file is
  // unreadable, never absent.
  if (current) files.push({ path: current.path, content: '', readable: false });
  return files;
}

/** Parse the structured `docker_repo` probe output, never the file names alone. */
export function parseRepoProbeOutput(text: string): RepoProbeOutput {
  const sources = parseDelimitedBlocks(text, 'SOURCE_BEGIN', 'SOURCE_END', 'SOURCE_UNREADABLE=1');
  const keyFiles = parseDelimitedBlocks(text, 'KEY_BEGIN', 'KEY_END', 'KEY_UNREADABLE=1');
  const keys = keyFiles.map((file) => {
    const lines = file.content.split('\n').map((line) => line.trim());
    const sizeLine = lines.find((line) => /^KEY_SIZE=/.test(line));
    const size = sizeLine && /^KEY_SIZE=\d+$/.test(sizeLine) ? Number(sizeLine.slice('KEY_SIZE='.length)) : null;
    const raw = lines.filter((line) => line && !line.startsWith('KEY_SIZE=')).join('');
    if (!file.readable || raw === 'KEY_UNREADABLE=1' || size === null) return { path: file.path, bytes: null };
    const bytes = Buffer.from(raw, 'base64');
    // A read cut off by the cap is no basis for a verdict on the whole keyring.
    return { path: file.path, bytes: bytes.length === size ? bytes : null };
  });
  return { sources, keys };
}

/**
 * The locations the script reported, read only from the lines before the first
 * file block so that file content can never stand in for them.
 */
export function parseSourceLocations(text: string): RepositoryObservation['sourceLocations'] {
  const head = text.split(/^(?:SOURCE|KEY)_BEGIN=/m)[0];
  // Compared exactly: a path that differs from the default only in
  // whitespace is another path to apt.
  const main = /^SOURCE_LOCATIONS_MAIN=(.*?)\r?$/m.exec(head)?.[1] ?? '';
  const parts = /^SOURCE_LOCATIONS_PARTS=(.*?)\r?$/m.exec(head)?.[1] ?? '';
  if (!main || !parts) return 'unknown';
  return main === DEFAULT_SOURCE_LIST && parts === DEFAULT_SOURCE_PARTS ? 'default' : 'custom';
}

export const OFFICIAL_DOCKER_URI = 'https://download.docker.com/linux/ubuntu';
const DOCKER_HOST = 'download.docker.com';

/** apt options that switch off or weaken signature checking for a source. */
const INSECURE_SOURCE_OPTIONS = ['trusted', 'allow-insecure', 'allow-weak', 'allow-downgrade-to-insecure'];
/** Options apt requires every entry for one source (URI and suite) to agree on, an unset one counting as a different value. */
const SOURCE_AGREEMENT_OPTIONS = ['trusted', 'check-valid-until', 'valid-until-min', 'valid-until-max', 'check-date', 'date-max-future', 'inrelease-path'];
const FALSE_OPTION_VALUES = new Set(['no', 'false', 'without', 'off', 'disable', '0']);

/** Maps the two machine types `uname -m` reports on hosts the verifier handles to apt's names, and returns any other value unchanged. */
export function debianArchitecture(machine: string): string {
  if (machine === 'x86_64') return 'amd64';
  if (machine === 'aarch64') return 'arm64';
  return machine;
}

/**
 * The whitespace apt splits and trims on (C's `isspace`). A no-break space or a
 * byte order mark is not whitespace to apt, and JavaScript's `\s` and `trim`
 * treat both as such, so every split or trim of apt-read text uses these.
 */
const APT_SPACE_RUN = /[ \t\n\v\f\r]+/;
const aptTrim = (text: string) => text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');
const aptWords = (text: string) => text.split(APT_SPACE_RUN).filter(Boolean);

/**
 * Whether apt reads an `Enabled` value as false: one of its words, or a number
 * that is all zeros in any base `strtol` takes (`0`, `00`, `-0`, `0x0`).
 */
function disablesStanza(value: string): boolean {
  const text = aptTrim(value).toLowerCase();
  return FALSE_OPTION_VALUES.has(text) || /^[+-]?(?:0x0+|0+)$/.test(text);
}

function weakensSignatures(value: string | undefined): boolean {
  return value !== undefined && !FALSE_OPTION_VALUES.has(aptTrim(value).toLowerCase());
}

type KeyringState = { verified: Set<string>; unreadable: Set<string> };

/**
 * Every key a source names must be an installed keyring that holds Docker's
 * key. A named keyring that could not be read in full leaves the source
 * unverifiable, which is not the same as naming a wrong one.
 */
function signedByState(signedBy: string | undefined, keys: KeyringState): 'verified' | 'wrong' | 'unreadable' {
  const named = (signedBy ?? '').split(/[, \t\n\v\f\r]+/).filter(Boolean);
  if (named.length === 0) return 'wrong';
  if (named.some((path) => !keys.verified.has(path) && !keys.unreadable.has(path))) return 'wrong';
  return named.every((path) => keys.verified.has(path)) ? 'verified' : 'unreadable';
}

/**
 * One apt source as both file formats describe it. Option names are the
 * deb822 field names in lower case; the one-line `arch`, `arch+` and `arch-`
 * options are mapped onto `architectures` and its `-add` and `-remove` forms.
 */
interface AptSourceEntry {
  type: 'deb' | 'deb-src';
  uris: string[];
  suites: string[];
  components: string[];
  options: Map<string, string>;
}

interface ParsedSourceFile {
  entries: AptSourceEntry[];
  /**
   * What makes the file unusable: content apt rejects (a line or stanza it
   * cannot parse, in a disabled stanza too for a Types it does not know) and a
   * Docker-host URI that is not the official repository's host. Each reason
   * names a line or stanza by position and never repeats what the file says,
   * because a source line can carry a repository credential.
   */
  invalid: string[];
  /** Content this check does not read, so what apt does with it is not established. */
  unknown: string[];
  /** True when the file holds no active line or stanza at all. */
  empty: boolean;
}

const LIST_OPTION_NAMES: Record<string, string> = {
  arch: 'architectures',
  'arch+': 'architectures-add',
  'arch-': 'architectures-remove',
};

/**
 * The name an option has in the deb822 vocabulary. apt reads the one-line
 * `arch`, `arch+`, `arch-` and `signed-by` options only in these exact
 * spellings (another spelling is ignored, so `Signed-By=` names no keyring).
 * The signing and conflict options count in any letter case, because a
 * spelling one apt version ignores another may read; counting it fails closed.
 */
function oneLineOptionName(rawKey: string): string {
  if (Object.hasOwn(LIST_OPTION_NAMES, rawKey)) return LIST_OPTION_NAMES[rawKey];
  // A one-line entry has no option with a deb822 architecture field's name, and apt ignores one; it must not land on the slot `arch` maps to.
  if (Object.values(LIST_OPTION_NAMES).includes(rawKey)) return `one-line ${rawKey}`;
  const lower = rawKey.toLowerCase();
  return INSECURE_SOURCE_OPTIONS.includes(lower) || SOURCE_AGREEMENT_OPTIONS.includes(lower) ? lower : rawKey;
}

/**
 * What apt rejects about the suites and components of one entry: a suite that is
 * an exact path (ends in a slash) takes no components, any other suite needs
 * at least one. Null when the pair is acceptable.
 */
function suiteComponentProblem(suites: string[], components: string[]): string | null {
  const exactPaths = suites.filter((suite) => suite.endsWith('/')).length;
  if (components.length > 0 && exactPaths > 0) return 'an exact-path suite (one that ends in a slash) with components';
  if (components.length === 0 && exactPaths < suites.length) return 'no Components';
  return null;
}

/** A URI apt can use starts with a lower-case scheme (`https:`, `file:`, `cdrom:`); apt finds the method for it by that exact name. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/;

/** URI schemes apt ships a method for; anything else in front of a colon may be part of a credential. */
const APT_URI_SCHEME = /^(?:https?|ftp|file|cdrom|copy|rsh|ssh|tor\+https?|mirror(?:\+[a-z]+)?)$/i;

/**
 * A URI as a diagnostic or a stored fact may show it. A source URI can carry a
 * credential in its userinfo, query or path, and a `#`, `/` or `?` inside the
 * userinfo makes a URL parser read part of the credential as the host, so only
 * what cannot hold one is shown: the official repository's own URI, or the
 * scheme and host of a URI with no `@` in it, or just the scheme when it has one.
 */
export function redactUri(uri: string): string {
  if (normalizeUri(uri) === OFFICIAL_DOCKER_URI) return OFFICIAL_DOCKER_URI;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri)?.[1];
  if (!scheme || !APT_URI_SCHEME.test(scheme)) return '(unrecognized URI)';
  if (uri.includes('@')) return `${scheme.toLowerCase()}: (host withheld)`;
  try {
    const url = new URL(uri);
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return '(unparsable URI)';
  }
}

/** Docker's host as a URI host (after a scheme, an option bracket or whitespace), not a path segment on another host. */
const DOCKER_HOST_MENTION = /(?:^|[\s[@]|:\/\/)download\.docker\.com(?![a-z0-9-])/i;

function mentionsDockerHost(text: string): boolean {
  return DOCKER_HOST_MENTION.test(text);
}

/** What C's `isspace` counts, which is how apt splits a source line into words. */
const isAptSpace = (char: string | undefined) => char !== undefined && ' \t\n\v\f\r'.includes(char);

interface AptWord {
  /** The word apt hands on: quotes removed and `%XX` escapes decoded. */
  word: string;
  /** Where the next word is looked for: after the whitespace that follows this one. */
  next: number;
}

/**
 * One word of a one-line entry, read as apt's `ParseQuoteWord` does. A double
 * quote anywhere in a word opens a run that ends at the next one (spaces
 * included), a `[` runs on to the next `]`, the quotes are dropped, and `%` and
 * two hex digits stand for the character they encode. A byte apt would store
 * that is not plain ASCII (or a NUL) reads as U+FFFD, which matches nothing the
 * checks look for. Null when a quote or bracket is not closed, or no word is left
 * (apt gives the same answer for both).
 */
function readAptWord(text: string, from: number): AptWord | null {
  let start = from;
  while (text[start] === ' ') start += 1;
  if (start >= text.length) return null;
  let end = start;
  for (; end < text.length && !isAptSpace(text[end]); end += 1) {
    if (text[end] === '"') {
      end = text.indexOf('"', end + 1);
      if (end < 0) return null;
    }
    if (text[end] === '[') {
      end = text.indexOf(']', end + 1);
      if (end < 0) return null;
    }
  }
  let word = '';
  for (let at = start; at < end;) {
    const escape = text[at] === '%' && at + 2 < end ? /^[0-9a-fA-F]{2}$/.exec(text.slice(at + 1, at + 3)) : null;
    if (escape) {
      const code = parseInt(escape[0], 16);
      word += code > 0 && code < 0x80 ? String.fromCharCode(code) : '\uFFFD';
      at += 3;
      continue;
    }
    if (text[at] !== '"') word += text[at];
    at += 1;
  }
  let next = end;
  while (isAptSpace(text[next])) next += 1;
  return { word, next };
}

interface ListLine {
  options: Map<string, string>;
  uri: string;
  suite: string;
  components: string[];
}

/**
 * What follows the type word of a one-line entry, read as apt's
 * `Type::ParseLine` does: an optional `[option=value ...]` group, the URI, the
 * suite, then every component. A word that cannot be read after the components
 * (an unclosed quote) ends the line, as it does for apt. Null when apt cannot
 * read the line, and 'unsupported' for the one shape this check does not read
 * (an option whose closing bracket is written as an escape, so that the walk
 * back finds no bracket).
 */
function readListLine(rest: string): ListLine | 'unsupported' | null {
  let at = 0;
  while (isAptSpace(rest[at])) at += 1;
  const options = new Map<string, string>();
  if (rest[at] === '[') {
    at += 1;
    while (isAptSpace(rest[at])) at += 1;
    while (rest[at] !== ']') {
      const read = readAptWord(rest, at);
      if (!read || read.word.length < 3) return null;
      let option = read.word;
      at = read.next;
      // apt accepts a last option with no space before the closing bracket: it
      // steps back from the next word to the nearest `]` and goes on from there.
      if (option.endsWith(']')) {
        let back = at;
        while (back >= 0 && rest[back] !== ']') back -= 1;
        if (back < 0) return 'unsupported';
        at = back;
        option = option.slice(0, -1);
      }
      const equals = option.indexOf('=');
      if (equals < 1 || equals === option.length - 1) return null;
      setListOption(options, option.slice(0, equals), option.slice(equals + 1));
    }
    at += 1;
    while (isAptSpace(rest[at])) at += 1;
  }
  const uri = readAptWord(rest, at);
  const suite = uri && readAptWord(rest, uri.next);
  if (!uri || !suite || !uri.word.includes(':')) return null;
  const components: string[] = [];
  for (let read = readAptWord(rest, suite.next); read; read = readAptWord(rest, read.next)) components.push(read.word);
  return { options, uri: uri.word, suite: suite.word, components };
}

/**
 * Record one option under the name the deb822 vocabulary gives it. apt reads
 * only the exact spelling of a weakening option and ignores another letter
 * case, but a later apt may read it, so a value that does not weaken never
 * overrides one that does, whichever spelling comes first.
 */
function setListOption(options: Map<string, string>, rawKey: string, value: string): void {
  const name = oneLineOptionName(rawKey);
  if (INSECURE_SOURCE_OPTIONS.includes(name) && weakensSignatures(options.get(name)) && !weakensSignatures(value)) return;
  options.set(name, value);
}

/** The text apt reads of a line: a `#` outside an open option group starts a comment, and a tab, space or carriage return at either end is dropped. */
function aptLineText(raw: string): string {
  let text = raw;
  for (let at = text.indexOf('#'); at >= 0; at = text.indexOf('#', at + 1)) {
    const before = text.slice(0, at);
    if (before.split('[').length <= before.split(']').length) {
      text = before;
      break;
    }
  }
  return text.replace(/^[ \t\r]+|[ \t\r]+$/g, '');
}

function parseListSource(content: string): ParsedSourceFile {
  const active = content.split('\n')
    .map((text, index) => ({ number: index + 1, text: aptLineText(text) }))
    .filter((line) => line.text);
  const entries: AptSourceEntry[] = [];
  const invalid: string[] = [];
  const unknown: string[] = [];
  for (const { number, text: line } of active) {
    // apt rejects the whole source list at a line it cannot parse, so one
    // beside a valid Docker entry is as fatal as one in a file of its own. The
    // type is the text up to the first space, tab or vertical tab, and only
    // `deb` and `deb-src` are types.
    const split = line.search(/[ \t\v]/);
    const type = split < 0 ? '' : line.slice(0, split);
    const read = type === 'deb' || type === 'deb-src' ? readListLine(line.slice(split)) : null;
    if (read === 'unsupported') {
      unknown.push(`line ${number} closes its option group with an escape, which this check does not read`);
      continue;
    }
    // The suite and components must fit, the scheme must be a lower-case one
    // (apt looks its method up by that exact name), and the suite cannot be
    // empty (apt aborts on `""`).
    if (!read || !read.suite || !URI_SCHEME.test(read.uri) || suiteComponentProblem([read.suite], read.components)) {
      invalid.push(`line ${number} is not a valid apt entry, which apt rejects`);
      continue;
    }
    // A line that names Docker's host but whose URI is not read as that host
    // (a trailing dot, a host inside another URI) is not one apt will use as
    // written. The URI is checked as apt decodes it too, because a quote or an
    // escape can hide the name from the raw line.
    if ((mentionsDockerHost(line) || mentionsDockerHost(read.uri)) && !isDockerHostUri(read.uri)) {
      invalid.push(`line ${number} names Docker's host in a URI that is not the official repository's host`);
      continue;
    }
    entries.push({ type: type as 'deb' | 'deb-src', uris: [read.uri], suites: [read.suite], components: read.components, options: read.options });
  }
  return { entries, invalid, unknown, empty: active.length === 0 };
}

interface Deb822Stanza {
  /** The line the stanza starts on, which is how a reason names it. */
  line: number;
  fields: Record<string, string>;
}

function parseDeb822(content: string): { paragraphs: Deb822Stanza[]; unparsed: number[] } {
  const paragraphs: Deb822Stanza[] = [];
  const unparsed: number[] = [];
  let current: Deb822Stanza | null = null;
  let lastKey: string | null = null;
  const close = () => {
    if (current && Object.keys(current.fields).length > 0) paragraphs.push(current);
    current = null;
    lastKey = null;
  };
  for (const [index, rawLine] of content.split('\n').entries()) {
    const number = index + 1;
    // Only an empty line ends a stanza; a line of spaces or tabs continues the open field.
    if (/^\r?$/.test(rawLine)) {
      close();
      continue;
    }
    if (rawLine.startsWith('#')) continue;
    // With no field open an indented comment is a comment; with one open it continues the field.
    if (!(current && lastKey !== null) && /^[ \t]+#/.test(rawLine)) continue;
    // An indented line continues the open field; with none open apt skips it
    // (it is no field, and no stanza starts at it).
    if (/^[ \t]/.test(rawLine)) {
      if (current && lastKey !== null) current.fields[lastKey] = `${current.fields[lastKey]} ${aptTrim(rawLine)}`;
      continue;
    }
    // apt takes everything up to the colon as the field name, so a custom field
    // such as `X+Note`, `X-Note/foo` or `X Note`, or one with an empty name, is
    // as good as `Types`.
    const match = /^([^:]*?)[ \t]*:[ \t]*(.*)$/.exec(aptTrim(rawLine));
    if (!match) {
      unparsed.push(number);
      continue;
    }
    current ??= { line: number, fields: Object.create(null) as Record<string, string> };
    lastKey = match[1].toLowerCase();
    current.fields[lastKey] = match[2];
  }
  close();
  return { paragraphs, unparsed };
}

function parseDeb822Source(content: string): ParsedSourceFile {
  const { paragraphs, unparsed } = parseDeb822(content);
  const entries: AptSourceEntry[] = [];
  const invalid: string[] = [];
  // apt rejects the whole source list at a line that is not "Field: value" or a
  // comment, wherever it stands in the file.
  if (unparsed.length > 0) invalid.push(`line ${unparsed[0]} is not a valid apt entry, which apt rejects`);
  for (const { line, fields: paragraph } of paragraphs) {
    const where = `the stanza at line ${line}`;
    // apt reads the Types field as exact, case-sensitive, whitespace-separated
    // words and rejects the whole source list at any other token, in a disabled
    // stanza as well, so no token is dropped here and a stanza without the field
    // is not skipped.
    const typeWords = aptWords(paragraph.types ?? '');
    if (paragraph.types === undefined) {
      invalid.push(`${where} has no Types field, which apt rejects`);
    } else if (typeWords.some((word) => word !== 'deb' && word !== 'deb-src')) {
      invalid.push(`${where} has a Types value that apt does not know, which apt rejects`);
    }
    // A disabled stanza cannot supply packages to apt.
    if (paragraph.enabled !== undefined && disablesStanza(paragraph.enabled)) continue;
    const uris = aptWords(paragraph.uris ?? '');
    const suites = aptWords(paragraph.suites ?? '');
    const components = aptWords(paragraph.components ?? '');
    // apt rejects the whole source list at an enabled stanza with no URIs or
    // Suites, or with components that do not fit its suites.
    let stanzaProblem: string | null;
    if (uris.length === 0) stanzaProblem = 'no URIs';
    else if (uris.some((uri) => !URI_SCHEME.test(uri))) stanzaProblem = 'a URI with no lower-case scheme';
    else if (suites.length === 0) stanzaProblem = 'no Suites';
    else stanzaProblem = suiteComponentProblem(suites, components);
    if (stanzaProblem) invalid.push(`${where} is enabled with ${stanzaProblem}, which apt rejects`);
    const options = new Map(Object.entries(paragraph));
    // apt joins a multi-word architecture field with commas, and reads a comma list in one word the same way.
    for (const name of Object.values(LIST_OPTION_NAMES)) {
      const value = options.get(name);
      if (value !== undefined) options.set(name, aptWords(value).join(','));
    }
    const types = typeWords.filter((type): type is 'deb' | 'deb-src' => type === 'deb' || type === 'deb-src');
    // A stanza for Docker's host with an empty Types field (apt reads no source
    // from it), or a URI that names the host without being read as it (a
    // trailing dot), is not a source to ignore.
    const namesHost = mentionsDockerHost(paragraph.uris ?? '');
    if (namesHost && (types.length === 0 || !uris.some(isDockerHostUri))) invalid.push(`${where} names Docker's host but is not a valid apt entry`);
    for (const type of types) entries.push({ type, uris, suites, components, options });
  }
  return { entries, invalid, unknown: [], empty: paragraphs.length === 0 };
}

/** The URI as apt compares it: scheme and host in lower case, no trailing slash. */
function normalizeUri(uri: string): string {
  // A URL parser drops a fragment or query, trims whitespace and reads a backslash as a slash; apt keeps them all in the host or path, so such a URI is not any official one.
  if (/[#?\\\s\x00-\x1f\x7f\uFFFD]/.test(uri)) return uri.replace(/\/+$/, '');
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return uri.replace(/\/+$/, '');
  }
}

function isDockerHostUri(uri: string): boolean {
  try {
    return new URL(uri).hostname.toLowerCase() === DOCKER_HOST;
  } catch {
    return false;
  }
}

function architectureList(options: Map<string, string>, name: string): string[] | undefined {
  const value = options.get(name);
  return value === undefined ? undefined : value.split(',').filter(Boolean);
}

/**
 * Whether an entry's effective architectures include the host's own: the
 * listed ones plus the added ones minus the removed ones, or every architecture
 * the system has (native included) when the entry lists none.
 */
function supportsArchitecture(options: Map<string, string>, arch: string): boolean | null {
  const listed = architectureList(options, 'architectures');
  const added = architectureList(options, 'architectures-add') ?? [];
  const removed = architectureList(options, 'architectures-remove') ?? [];
  if (!arch) return listed === undefined && added.length === 0 && removed.length === 0 ? true : null;
  if (removed.includes(arch)) return false;
  return listed === undefined ? true : listed.includes(arch) || added.includes(arch);
}

/** Why a source is not verified: a negative answer, or none because something could not be read or established. */
type SourceCheck = { kind: 'fail' | 'unknown'; reason: string };

const fail = (reason: string): SourceCheck => ({ kind: 'fail', reason });
const unknownCheck = (reason: string): SourceCheck => ({ kind: 'unknown', reason });

function weakenedSigningCheck(options: Map<string, string>): SourceCheck | null {
  const weakened = INSECURE_SOURCE_OPTIONS.find((name) => weakensSignatures(options.get(name)));
  return weakened ? fail(`the source sets ${weakened}, which weakens signature checking`) : null;
}

/** The checks a binary entry of Docker's repository must pass; null when it passes. */
function checkBinaryEntry(entry: AptSourceEntry, codename: string, arch: string, keys: KeyringState): SourceCheck | null {
  if (entry.uris.length !== 1 || normalizeUri(entry.uris[0]) !== OFFICIAL_DOCKER_URI) {
    return fail(`the source points at ${entry.uris.map(redactUri).join(' ') || 'no URI'}, not ${OFFICIAL_DOCKER_URI}`);
  }
  if (!entry.components.includes('stable')) return fail('the source does not enable the stable component');
  if (entry.components.includes('')) return fail('the source has an empty component, which apt reads as an index that does not exist');
  const weakened = weakenedSigningCheck(entry.options);
  if (weakened) return weakened;
  const keyring = signedByState(entry.options.get('signed-by'), keys);
  if (keyring === 'unreadable') return unknownCheck('a keyring the source names could not be read in full');
  if (keyring === 'wrong') return fail('the source does not name an installed Docker keyring through signed-by');
  const supported = supportsArchitecture(entry.options, arch);
  if (supported === null) return unknownCheck('the host architecture is unknown, so the source architectures cannot be checked');
  if (!supported) return fail(`the source does not provide packages for the ${arch} architecture`);
  // Last, so that a contradiction found above is not hidden by an unknown release.
  if (!codename) return unknownCheck('the host release is unknown, so the source suite cannot be checked');
  if (!entry.suites.includes(codename)) return fail(`the source suite is not the host release ${codename}`);
  return null;
}

/** An option one entry sets for a source (URI and suite), which apt requires every entry for that source to agree on. */
interface SigningSetting {
  path: string;
  /** The comparison key, built from the source text: never put it in a reason. */
  target: string;
  /** The source as a diagnostic may name it (`redactUri`), with no suite or credential. */
  label: string;
  option: string;
  value: string;
}

interface SourceFileVerdict {
  /** The file holds a Docker source entry, content apt rejects, or is docker.list or docker.sources. */
  relevant: boolean;
  problems: SourceCheck[];
  /** Relevant binary entries, for the whole-configuration checks. */
  binaryEntries: number;
  signing: SigningSetting[];
}

function verifySourceFile(
  file: RepoFileObservation,
  codename: string,
  arch: string,
  keys: KeyringState,
): SourceFileVerdict {
  const conventional = CONVENTIONAL_SOURCE_FILE.test(file.path);
  const deb822 = /\.sources$/i.test(file.path);
  const parsed = deb822 ? parseDeb822Source(file.content) : parseListSource(file.content);
  const verdict: SourceFileVerdict = { relevant: conventional, problems: [], binaryEntries: 0, signing: [] };
  for (const reason of parsed.invalid) {
    verdict.relevant = true;
    verdict.problems.push(fail(reason));
  }
  for (const reason of parsed.unknown) {
    verdict.relevant = true;
    verdict.problems.push(unknownCheck(reason));
  }
  if (conventional && parsed.empty) {
    verdict.problems.push(fail(deb822 ? 'the Docker deb822 source is empty' : 'the Docker source file is empty'));
  }
  for (const entry of parsed.entries) {
    const dockerEntry = entry.uris.some(isDockerHostUri);
    // docker.list and docker.sources are checked whatever they point at; any
    // other file only where it configures Docker's host.
    if (!dockerEntry && !(conventional && entry.type === 'deb')) continue;
    verdict.relevant = true;
    // A deb-src entry cannot supply packages, but apt holds it to the signing
    // options of any entry that shares its URI and suite.
    if (entry.type === 'deb-src') {
      const weakened = weakenedSigningCheck(entry.options);
      if (weakened) verdict.problems.push(weakened);
    } else {
      verdict.binaryEntries += 1;
      const check = checkBinaryEntry(entry, codename, arch, keys);
      if (check) verdict.problems.push(check);
    }
    const signedBy = aptWords(entry.options.get('signed-by') ?? '').join(' ');
    for (const uri of entry.uris) {
      for (const suite of entry.suites) {
        const target = `${normalizeUri(uri)} ${suite}`;
        const label = redactUri(uri);
        if (signedBy) verdict.signing.push({ path: file.path, target, label, option: 'signed-by', value: signedBy });
        for (const option of SOURCE_AGREEMENT_OPTIONS) {
          const raw = entry.options.get(option);
          const value = raw === undefined ? undefined : aptTrim(raw).toLowerCase();
          let compared = value ?? 'unset';
          if (option === 'trusted' && value !== undefined && weakensSignatures(value)) compared = 'yes';
          verdict.signing.push({ path: file.path, target, label, option, value: compared });
        }
      }
    }
  }
  return verdict;
}

/**
 * apt rejects its whole source list when two entries for one URI and suite
 * disagree on the keyring (Signed-By) or on one of the agreement options
 * (Trusted, Check-Valid-Until and the like), so a preserved configuration must
 * not do that. An entry that does not set Signed-By agrees with any value; one
 * that leaves another option unset disagrees with an entry that sets it.
 */
function signingConflict(verdicts: SourceFileVerdict[]): string | null {
  const seen = new Map<string, { path: string; value: string }>();
  for (const verdict of verdicts) {
    for (const item of verdict.signing) {
      const key = `${item.option} ${item.target}`;
      const earlier = seen.get(key);
      if (!earlier) {
        seen.set(key, { path: item.path, value: item.value });
      } else if (earlier.value !== item.value) {
        return `${earlier.path} and ${item.path} set different ${item.option} values for one source on ${item.label}, which apt rejects`;
      }
    }
  }
  return null;
}

/**
 * Verify what every apt source file and the Docker keyring actually say. A
 * source in any file of the source list apt reads counts, whatever the file is
 * called; a file named docker.list with an arbitrary URL is not the official
 * repository, a keyring is Docker's only when its fingerprint is, a source that
 * leaves out the host's architecture cannot supply its packages, and an
 * unreadable file is unknown, never a pass. A known contradiction outweighs an
 * unknown, because reading more would not change it.
 */
export function parseDockerRepo(text: string, codename: string, arch: string): RepositoryObservation {
  const parsed = parseRepoProbeOutput(text);
  const verifiedKeys = parsed.keys.filter((key) => isDockerReleaseKeyFile(key.path, key.bytes));
  const keys: KeyringState = {
    verified: new Set(verifiedKeys.map((key) => key.path)),
    unreadable: new Set(parsed.keys.filter((key) => key.bytes === null).map((key) => key.path)),
  };
  const keyringVerified = verifiedKeys.length > 0
    ? true
    : parsed.keys.length > 0
      ? parsed.keys.every((key) => key.bytes === null) ? null : false
      : false;

  let sourceConfigured = false;
  // A keyring that is not Docker's is the root cause of any source it was meant to sign.
  let keyringProblem: string | null = null;
  let failureProblem: string | null = null;
  let unknownProblem: string | null = null;
  if (keyringVerified === null) {
    keyringProblem = 'a Docker keyring could not be read in full';
  } else if (keyringVerified === false && parsed.keys.length > 0) {
    keyringProblem = 'no Docker keyring holds the Docker release key';
  }
  const note = (check: SourceCheck, path: string) => {
    if (check.kind === 'fail') failureProblem ??= `${path}: ${check.reason}`;
    else unknownProblem ??= `${path}: ${check.reason}`;
  };
  const verdicts: SourceFileVerdict[] = [];
  for (const source of parsed.sources) {
    if (!source.readable) {
      sourceConfigured = true;
      note(unknownCheck('could not be read'), source.path);
      continue;
    }
    const verdict = verifySourceFile(source, codename, arch, keys);
    if (!verdict.relevant) continue;
    sourceConfigured = true;
    verdicts.push(verdict);
    for (const check of verdict.problems) note(check, source.path);
  }
  if (sourceConfigured && !failureProblem) {
    failureProblem = signingConflict(verdicts);
    if (!failureProblem && !unknownProblem && verdicts.every((verdict) => verdict.binaryEntries === 0)) {
      failureProblem = 'the Docker source files have no enabled binary (deb) entry';
    }
  }
  // A source seen at the default paths proves nothing about the sources apt
  // reads when apt could not say where those are.
  const sourceLocations = parseSourceLocations(text);
  if (sourceLocations === 'unknown') {
    unknownProblem ??= 'the locations apt reads its sources from could not be established';
  }
  let sourceVerified: boolean | null = true;
  if (!sourceConfigured || failureProblem) sourceVerified = false;
  else if (unknownProblem) sourceVerified = null;
  if (sourceLocations === 'custom' && !sourceConfigured) {
    unknownProblem ??= 'apt is configured to read its sources from somewhere other than /etc/apt/sources.list and /etc/apt/sources.list.d, and none of what it reads configures Docker';
  }

  return {
    probeComplete: true,
    sourceLocations,
    dockerSourceConfigured: sourceConfigured,
    keyringPresent: parsed.keys.length > 0,
    sourceVerified,
    keyringVerified,
    candidateSourceVerified: null,
    problem: keyringProblem ?? failureProblem ?? unknownProblem,
  };
}

const DOCKER_PACKAGES: DockerPackageName[] = [
  'docker-ce',
  'docker-ce-cli',
  'containerd.io',
  'docker-buildx-plugin',
  'docker-compose-plugin',
];

const NUMERIC = /^-?\d+$/;

/**
 * Parse `apt-cache policy`. A candidate is attributed to the archives listed
 * under its own version in the version table, never to the first archive that
 * follows the Candidate line. Each archive is classified here, against the host
 * release, and only the classification is kept: the release and component text
 * after the URI can hold a repository credential, and facts are hashed.
 */
export function parseAptPolicy(text: string, codename: string): DockerPackage[] {
  const packages = new Map<string, DockerPackage>();
  let current: (DockerPackage & { candidateSources: CandidateSource[] }) | null = null;
  let inVersionTable = false;
  let tableVersion: string | null = null;
  for (const line of text.split('\n')) {
    const nameMatch = /^([a-z0-9.-]+):\s*$/.exec(line);
    if (nameMatch) {
      const name = nameMatch[1] as DockerPackageName;
      inVersionTable = false;
      tableVersion = null;
      if (!DOCKER_PACKAGES.includes(name)) {
        current = null;
        continue;
      }
      current = { name, installedVersion: null, candidateVersion: null, candidateSources: [] };
      packages.set(name, current);
      continue;
    }
    if (!current) continue;
    if (/^\s+Version table:\s*$/.test(line)) {
      inVersionTable = true;
      tableVersion = null;
      continue;
    }
    if (!inVersionTable) {
      const installed = /^\s+Installed:\s*(\S+)/.exec(line);
      if (installed) {
        current.installedVersion = installed[1] === '(none)' ? null : installed[1];
        continue;
      }
      const candidate = /^\s+Candidate:\s*(\S+)/.exec(line);
      if (candidate) current.candidateVersion = candidate[1] === '(none)' ? null : candidate[1];
      continue;
    }
    const tokens = line.trim().split(/\s+/).filter((token) => token && token !== '***');
    if (tokens.length === 2 && NUMERIC.test(tokens[1])) {
      // "<version> <priority>" opens a stanza of the version table.
      tableVersion = tokens[0];
      continue;
    }
    // "<priority> <archive URI or path> [<release> ...]" lists where that version is served.
    if (tokens.length >= 2 && NUMERIC.test(tokens[0]) && tableVersion !== null) {
      const location = tokens[1];
      // The installed-package record is not an archive.
      if (location === '/var/lib/dpkg/status') continue;
      if (tableVersion === current.candidateVersion) {
        const uri = redactUri(location);
        // The official URI serves any release's index; only the host release's `<codename>/stable` is the one to use, which cannot be told when the release is unknown.
        if (uri === OFFICIAL_DOCKER_URI) current.candidateSources.push({ uri, official: codename ? tokens[2] === `${codename}/stable` : null });
        else current.candidateSources.push({ uri, official: false });
      }
    }
  }
  return DOCKER_PACKAGES.map((name) => packages.get(name) ?? {
    name,
    installedVersion: null,
    candidateVersion: null,
    candidateSources: [],
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

/** The command ran to its end: no timeout, no truncation and no transport error. */
function ranToEnd(result: SshCommandResult): boolean {
  return !result.timedOut && !result.truncated && !result.error;
}

/** A command that ran to its end and exited 0. */
export function isCompleteResult(result: SshCommandResult | undefined): result is SshCommandResult {
  return result !== undefined && ranToEnd(result) && result.exitCode === 0;
}

export function parseHubHealth(result: SshCommandResult): HubHealthObservation {
  if (!ranToEnd(result)) {
    return { reachable: null, statusCode: null, tlsTrusted: null };
  }
  const code = Number(result.stdout.trim());
  if (result.exitCode === 0 && Number.isInteger(code) && code > 0) {
    return { reachable: true, statusCode: code, tlsTrusted: true };
  }
  // curl exits 60 for an untrusted certificate; its message goes to stderr.
  if (result.exitCode === 60 || /server certificate|certificate verify|SSL certificate/i.test(result.stderr)) {
    return { reachable: true, statusCode: null, tlsTrusted: false };
  }
  // 126/127 mean the shell could not run curl at all, which says nothing about the hub.
  if (result.exitCode === 126 || result.exitCode === 127 || /command not found|curl: not found/i.test(result.stderr)) {
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

/** A `<device>:<inode>:<owner uid>:<birth time>` identity (the birth time is `-` where the filesystem keeps none), or null for anything else. */
function parseIdentity(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  // A directory whose creation time the host cannot give (`-`) cannot be told from another one that reused its inode, so it has no identity.
  return /^\d+:\d+:\d+:\S+$/.test(trimmed) && !trimmed.endsWith(':-') ? trimmed : null;
}

function parseTrust(value: string | undefined): TrustChain | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'ok') return { state: 'sealed' };
  const open = /^open:(\/.*)$/.exec(trimmed);
  if (open) return { state: 'open', at: open[1] };
  const unreadable = /^unreadable:(\/.*)$/.exec(trimmed);
  return unreadable ? { state: 'unreadable', at: unreadable[1] } : { state: 'unreadable', at: trimmed };
}

export function parsePathFacts(text: string, input: string, kindLabel = 'path'): ParsedPathFacts {
  const raw = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^P_([A-Z_]+)=(.*)$/.exec(line);
    if (match) raw.set(match[1], match[2]);
  }
  const exists = raw.get('EXISTS') === '1' && !raw.has('ERROR');
  const isDirectory = raw.get('ISDIR') === '1';
  const realPath = raw.get('REAL') ?? null;
  const dfFields = (raw.get('DF') ?? '').trim().split(/\s+/);
  const freeBytes = dfFields.length >= 4 && /^\d+$/.test(dfFields[3])
    ? Number(dfFields[3]) * 1024
    : null;
  const fstype = raw.get('FSTYPE')?.trim() || '';
  const fsSource = raw.get('FSSOURCE')?.trim() || '';
  const fsTarget = raw.get('FSTARGET')?.trim() || '';
  const error = raw.get('ERROR')
    ?? (raw.size === 0 ? `${kindLabel} probe returned no facts` : null)
    ?? (raw.has('EXISTS') ? null : `${kindLabel} probe did not report whether the path exists`);
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
    identity: parseIdentity(isDirectory ? raw.get('IDENT') : undefined),
    nearestExistingAncestorIdentity: exists ? null : parseIdentity(raw.get('NEAREST_IDENT')),
    trustSelf: parseTrust(raw.get('TRUST_SELF')),
    trustAbove: parseTrust(raw.get('TRUST_ABOVE')),
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

export function parseComposeInventory(text: string, composeDir: string, outputTruncated = false): InventorySummary {
  const normalizedDir = composeDir.endsWith('/') ? composeDir.slice(0, -1) : composeDir;
  const entries = text.split('\0').filter((entry) => entry.length > 0);
  const names = new Set<string>();
  let rootComposeFile = false;
  for (const entry of entries) {
    if (!entry.startsWith(`${normalizedDir}/`)) continue;
    const relative = entry.slice(normalizedDir.length + 1);
    const parts = relative.split('/').filter(Boolean);
    if (parts.length === 1) {
      rootComposeFile = true;
      continue;
    }
    if (parts.length >= 2) names.add(parts[0]);
  }
  const stackNames = [...names].sort();
  return {
    stackCount: stackNames.length,
    // Only the displayed names are capped. The count covers every entry, so it
    // is exact unless the transport cut the output off (a lower bound).
    stackNames: stackNames.slice(0, 50),
    truncated: outputTruncated,
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

export interface DockerRootDiskObservation {
  /** How the root was established; null when the script reported nothing usable. */
  source: 'daemon' | 'default' | 'unavailable' | null;
  root: string | null;
  freeBytes: number | null;
}

export function parseDockerRootDisk(text: string): DockerRootDiskObservation {
  const raw = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^D_([A-Z]+)=(.*)$/.exec(line);
    if (match) raw.set(match[1], match[2]);
  }
  const source = raw.get('SOURCE');
  return {
    source: source === 'daemon' || source === 'default' || source === 'unavailable' ? source : null,
    root: raw.get('ROOT')?.trim() || null,
    freeBytes: parseDfFreeBytes(raw.get('DF') ?? ''),
  };
}

/**
 * Whether apt would serve every candidate from the official archive. A
 * candidate without a known archive is unknown, and one foreign archive makes
 * the whole answer false.
 */
function candidateProvenance(packages: DockerPackage[]): boolean | null {
  const perPackage = packages
    .filter((pkg) => pkg.candidateVersion !== null)
    .map((pkg) => {
      const sources = pkg.candidateSources ?? [];
      if (sources.length === 0 || sources.some((source) => source.official === null) && !sources.some((source) => source.official === false)) return null;
      return sources.every((source) => source.official);
    });
  if (perPackage.includes(false)) return false;
  return perPackage.length === 0 || perPackage.includes(null) ? null : true;
}

// --- Fact assembly -------------------------------------------------------

export interface AssembleFactsInput {
  target: BootstrapFacts['target'];
  hostKey: HostKeyObservation;
  hubUrl: string;
  composeDir: string;
  agentDir: string;
  results: SshCommandResult[];
  /** Null when the fstab probe did not complete, so mounts are unknown. */
  fstabMountPoints: string[] | null;
  now: number;
}

function resultMap(results: SshCommandResult[]): Map<string, SshCommandResult> {
  const map = new Map<string, SshCommandResult>();
  for (const result of results) map.set(result.id, result);
  return map;
}

function stdoutOf(map: Map<string, SshCommandResult>, id: string): string {
  const result = map.get(id);
  return result && ranToEnd(result) ? result.stdout : '';
}

function succeeded(map: Map<string, SshCommandResult>, id: string): boolean {
  return isCompleteResult(map.get(id));
}

/** Output of a command that ran to a normal exit; anything else reads as empty. */
function completeStdout(map: Map<string, SshCommandResult>, id: string): string {
  const result = map.get(id);
  return isCompleteResult(result) ? result.stdout : '';
}

function isProbeUnknown(map: Map<string, SshCommandResult>, id: string): boolean {
  const result = map.get(id);
  return !result || !ranToEnd(result);
}

/** True when observed; otherwise null when the probe did not complete, false when it did. */
function observedOrUnknown(observed: boolean, map: Map<string, SshCommandResult>, id: string): boolean | null {
  if (observed) return true;
  return isProbeUnknown(map, id) ? null : false;
}

interface InventoryOutcome {
  text: string;
  complete: boolean;
  error: string | null;
  truncated: boolean;
}

function failureReason(result: SshCommandResult): string {
  if (result.timedOut) return 'timed out';
  if (result.truncated) return 'output truncated';
  if (result.error) return result.error;
  return `exited ${result.exitCode ?? 'without a status'}`;
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
  // Keep the richest partial listing: a failed direct attempt must not hide a
  // Pilot row that the sudo attempt did print before it was cut off.
  const partial = candidates
    .filter((result) => !result.timedOut || result.truncated)
    .sort((a, b) => b.stdout.length - a.stdout.length)[0];
  return {
    text: partial?.stdout ?? '',
    complete: false,
    error: candidates.length > 0 ? candidates.map(failureReason).join('; ') : 'not run',
    truncated: partial?.truncated === true,
  };
}

function isUnderAnyMount(path: string, mountPoints: string[]): boolean {
  return mountPoints.some((mount) => mount === path || (mount !== '/' && path.startsWith(`${mount}/`)));
}

/**
 * The default installation's Compose file. A direct answer of yes or no is
 * conclusive; a denied or failed direct attempt falls back to sudo, and when
 * neither answers the default directory is unknown, never absent.
 */
function defaultDirObservation(map: Map<string, SshCommandResult>): { hasComposeFile: boolean | null; realPath: string | null } {
  for (const id of ['default_agent_path', 'default_agent_path_sudo']) {
    const result = map.get(id);
    if (!isCompleteResult(result)) continue;
    const [answer, ...rest] = result.stdout.trim().split('\n').map((line) => line.trim());
    if (answer === 'yes') {
      const real = rest.find((line) => line.startsWith('real='))?.slice('real='.length) ?? '';
      return { hasComposeFile: true, realPath: real.startsWith('/') ? real : null };
    }
    if (answer === 'no') return { hasComposeFile: false, realPath: null };
  }
  return { hasComposeFile: null, realPath: null };
}

/**
 * Free space of the filesystem under the Docker root. The measurement counts
 * only for the root the daemon reported (or the default root of a host that has
 * no Docker CLI at all): another path's capacity is not this root's.
 */
function dockerRootFacts(
  map: Map<string, SshCommandResult>,
  dockerInfo: { rootDir: string | null } | null,
  cliInstalled: boolean,
  cliProbeUnknown: boolean,
): { path: string | null; freeBytes: number | null } {
  const disk = parseDockerRootDisk(completeStdout(map, 'docker_root_disk'));
  if (dockerInfo) {
    const sameRoot = disk.source === 'daemon' && disk.root !== null && disk.root === dockerInfo.rootDir;
    return { path: dockerInfo.rootDir, freeBytes: sameRoot ? disk.freeBytes : null };
  }
  if (!cliInstalled && !cliProbeUnknown && disk.source === 'default') {
    return { path: disk.root, freeBytes: disk.freeBytes };
  }
  return { path: null, freeBytes: null };
}

export function assembleFacts(input: AssembleFactsInput): BootstrapFacts {
  const map = resultMap(input.results);
  const osBase = parseOsRelease(stdoutOf(map, 'os_release'));
  const uname = parseUname(stdoutOf(map, 'uname'));
  const userBase = parseUser(stdoutOf(map, 'user'));
  const sudoAvailable = succeeded(map, 'sudo');
  const cliInstalled = succeeded(map, 'docker_cli');
  const cliProbeUnknown = isProbeUnknown(map, 'docker_cli');

  // `docker info` prints its empty template and exits non-zero when the daemon
  // cannot be reached, so only a clean exit with a server version is an answer.
  const directDocker = parseDockerInfo(completeStdout(map, 'docker_info'));
  const sudoDocker = parseDockerInfo(completeStdout(map, 'docker_info_sudo'));
  const dockerInfo = directDocker ?? sudoDocker;
  const dockerInfoUnknown = !dockerInfo
    && (isProbeUnknown(map, 'docker_info') || isProbeUnknown(map, 'docker_info_sudo'));
  const socketAccess: BootstrapFacts['docker']['socketAccess'] = directDocker
    ? 'user'
    : sudoDocker
      ? 'sudo'
      : dockerInfoUnknown ? 'unknown' : 'none';

  const composeVersion = parseComposeVersion(completeStdout(map, 'compose_version'))
    ?? parseComposeVersion(completeStdout(map, 'compose_version_sudo'));
  const composeProbeUnknown = composeVersion === null
    && (isProbeUnknown(map, 'compose_version') || isProbeUnknown(map, 'compose_version_sudo'));
  const repoProbe = map.get('docker_repo');
  const repoBase = isCompleteResult(repoProbe)
    ? parseDockerRepo(repoProbe.stdout, osBase?.codename ?? '', debianArchitecture(uname.arch))
    : {
      probeComplete: false,
      sourceLocations: 'unknown' as const,
      dockerSourceConfigured: false,
      keyringPresent: false,
      sourceVerified: null,
      keyringVerified: null,
      candidateSourceVerified: null,
      problem: 'the repository probe did not complete',
    };
  const packagesComplete = succeeded(map, 'apt_policy');
  const packages = parseAptPolicy(completeStdout(map, 'apt_policy'), osBase?.codename ?? '');
  const candidateSourceVerified = candidateProvenance(packages);
  const candidatesUnattributed = candidateSourceVerified === null
    && packages.some((pkg) => pkg.candidateVersion !== null)
    && repoBase.sourceVerified === true
    && repoBase.keyringVerified === true;
  // apt-cache policy exits non-zero when apt rejects a source file, whatever the
  // reading above made of it; the parser cannot know every value apt refuses, so
  // apt's own failure outweighs a verified reading.
  const policyContradictsSource = repoBase.sourceVerified === true && !packagesComplete;
  const repo: BootstrapFacts['repo'] = {
    ...repoBase,
    sourceVerified: policyContradictsSource ? null : repoBase.sourceVerified,
    candidateSourceVerified,
    problem: repoBase.problem
      ?? (policyContradictsSource ? 'apt-cache policy did not complete, so apt may reject a source file that was read as valid' : null)
      ?? (candidatesUnattributed ? 'apt does not show which archive serves the Docker packages' : null),
  };

  const containerOutcome = inventoryOutcome(map, 'containers', 'containers_sudo');
  const containerInventory = parseContainers(containerOutcome.text, containerOutcome.truncated);
  const containersComplete = containerOutcome.complete;
  const volumeOutcome = inventoryOutcome(map, 'agent_volume', 'agent_volume_sudo');
  const volumeNames = volumeOutcome.complete ? parseVolumeNames(volumeOutcome.text) : [];
  const clockMs = parseEpochSeconds(stdoutOf(map, 'clock'));
  const hubResult = map.get('hub_health');
  const hubHealth = hubResult
    ? parseHubHealth(hubResult)
    : { reachable: null, statusCode: null, tlsTrusted: null };

  const composeFacts = parsePathFacts(stdoutOf(map, 'path_compose'), input.composeDir, 'Compose directory');
  const agentFacts = parsePathFacts(stdoutOf(map, 'path_agent'), input.agentDir, 'Agent directory');
  const { raw: _composeRaw, ...composeBase } = composeFacts;
  const { raw: _agentRaw, ...agentBase } = agentFacts;

  const composeOutcome = inventoryOutcome(map, 'compose_inventory', 'compose_inventory_sudo');
  const composeInventory = composeBase.exists
    ? parseComposeInventory(composeOutcome.text, input.composeDir, composeOutcome.truncated)
    : { stackCount: 0, stackNames: [], truncated: false, rootComposeFile: false };
  const agentOutcome = inventoryOutcome(map, 'agent_inventory', 'agent_inventory_sudo');
  const agentInventory = parseAgentInventory(agentOutcome.text, agentOutcome.truncated);
  const markerOutcome = inventoryOutcome(map, 'agent_marker', 'agent_marker_sudo');
  const marker = parseBootstrapMarker(markerOutcome.complete ? markerOutcome.text : '');
  // A marker that is listed but could not be read is unknown, not "unrelated content".
  const markerUnreadable = !markerOutcome.complete && agentInventory.entries.includes('sencho-bootstrap.json');

  const composeDir: ComposeDirObservation = {
    ...composeBase,
    mountInFstab: composeBase.filesystem && input.fstabMountPoints
      ? isUnderAnyMount(composeBase.filesystem.mountPoint, input.fstabMountPoints)
      : null,
    stackCount: composeBase.exists && composeOutcome.complete ? composeInventory.stackCount : null,
    stackNames: composeInventory.stackNames,
    inventoryTruncated: composeInventory.truncated,
    inventoryError: composeBase.exists ? composeOutcome.error : null,
    rootComposeFile: composeInventory.rootComposeFile,
  };
  const agentDir: AgentDirObservation = {
    ...agentBase,
    mountInFstab: agentBase.filesystem && input.fstabMountPoints
      ? isUnderAnyMount(agentBase.filesystem.mountPoint, input.fstabMountPoints)
      : null,
    ...agentInventory,
    inventoryError: agentBase.exists
      ? agentOutcome.error ?? (markerUnreadable ? `the bootstrap marker could not be read (${markerOutcome.error})` : null)
      : null,
    ...marker,
  };

  // The planned container_name collides with a same-named container whether or
  // not Compose started it, so a `docker run` Pilot counts as well.
  const agentContainers = containerInventory.rows.filter((row) => (
    row.project === 'sencho-agent' || row.name === 'sencho-agent'
  ));
  const defaultDir = defaultDirObservation(map);
  const agentInstall: AgentInstallObservation = {
    projectContainers: agentContainers.map((row) => ({
      name: row.name,
      workingDir: row.workingDir,
      configFiles: null,
      image: row.image,
      status: row.status,
    })),
    dataVolumeExists: dockerInfo
      ? volumeOutcome.complete ? volumeNames.length > 0 : null
      : cliProbeUnknown || cliInstalled ? null : false,
    dataVolumeNames: volumeNames,
    defaultDirHasComposeFile: defaultDir.hasComposeFile,
    defaultDirRealPath: defaultDir.realPath,
  };

  const dockerRoot = dockerRootFacts(map, dockerInfo, cliInstalled, cliProbeUnknown);

  return {
    target: input.target,
    hostKey: input.hostKey,
    os: osBase ? { ...osBase, arch: uname.arch, kernel: uname.kernel } : null,
    user: userBase
      ? { ...userBase, sudoNonInteractive: observedOrUnknown(sudoAvailable, map, 'sudo') }
      : null,
    docker: {
      cliInstalled,
      cliProbeUnknown,
      serverVersion: dockerInfo?.serverVersion ?? null,
      composeVersion,
      composeProbeUnknown,
      serviceActive: observedOrUnknown(
        stdoutOf(map, 'docker_service_active').trim() === 'active',
        map,
        'docker_service_active',
      ),
      serviceEnabled: observedOrUnknown(
        ['enabled', 'enabled-runtime'].includes(stdoutOf(map, 'docker_service_enabled').trim()),
        map,
        'docker_service_enabled',
      ),
      socketAccess,
      rootDir: dockerInfo?.rootDir ?? null,
      endpoint: DOCKER_LOCAL_ENDPOINT,
    },
    repo,
    packages,
    packagesComplete,
    paths: { composeDir, agentDir },
    agent: agentInstall,
    dockerRoot: {
      ...dockerRoot,
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

/** Reject anything that is not a valid absolute http(s) URL without credentials; loopback is flagged for the caller to block. */
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

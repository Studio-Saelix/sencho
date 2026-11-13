import path from 'path';

/**
 * Host path rules for the bootstrap workflow.
 *
 * The two directories are typed by an operator, reach shell commands, Compose
 * YAML, Docker labels and documentation. The character allowlist is therefore a
 * deliberate v1 constraint: a character that is safe in one layer is not
 * necessarily safe in all of them, so anything outside the set is refused with
 * a reason instead of being quoted through every layer.
 */

export const DEFAULT_COMPOSE_DIR = '/opt/docker/sencho';
export const DEFAULT_AGENT_DIR = '/opt/sencho-agent';

export const PILOT_PROJECT_NAME = 'sencho-agent';
/** The plan step that writes the hub CA beside the compose file: the compose file, the enrollment and the start step all look it up by this id. */
export const HUB_CA_STEP_ID = 'agent-hub-ca';
export const PILOT_CONTAINER_NAME = 'sencho-agent';
export const PILOT_DATA_VOLUME = 'sencho-agent-data';
export const PILOT_DATA_MOUNT = '/app/data';
export const PILOT_IMAGE_REF = 'saelix/sencho:latest';
export const BOOTSTRAP_MARKER_FILENAME = 'sencho-bootstrap.json';
export const BOOTSTRAP_MARKER_SCHEMA_VERSION = 1;

export const MAX_PATH_LENGTH = 200;

/** Roots that must never be the stacks root or the agent directory. */
export const RESERVED_PATH_PREFIXES: readonly string[] = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/run',
  '/var/lib/docker',
  '/var/lib/containerd',
  '/app',
  '/tmp',
  '/var/tmp',
  '/snap',
  '/nix',
];

/** Roots that are too broad to hold either directory. */
export const DENIED_EXACT_ROOTS: readonly string[] = ['/home', '/opt', '/srv', '/mnt', '/media'];

export const PATH_CHARACTER_SET = 'A-Z a-z 0-9 . _ - /';

export type InstallPathKind = 'compose' | 'agent';

export type PathSyntaxReason =
  | 'not-absolute'
  | 'too-long'
  | 'bad-character'
  | 'dot-segment'
  | 'empty-segment'
  | 'trailing-slash'
  | 'root'
  | 'too-shallow'
  | 'reserved';

export interface PathSyntaxResult {
  ok: boolean;
  normalized: string | null;
  reason: PathSyntaxReason | null;
  message: string | null;
}

const ALLOWED_PATH_CHARACTERS = /^[A-Za-z0-9._/-]+$/;

export function installPathLabel(kind: InstallPathKind): string {
  return kind === 'compose' ? 'Compose stacks directory' : 'Pilot Agent installation directory';
}

function fail(reason: PathSyntaxReason, message: string): PathSyntaxResult {
  return { ok: false, normalized: null, reason, message };
}

/**
 * Validate a directory path for either install kind. Syntax only: existence,
 * ownership, symlinks and filesystem facts are read from the target host.
 */
export function validatePathSyntax(input: string, kind: InstallPathKind): PathSyntaxResult {
  const label = installPathLabel(kind);
  if (typeof input !== 'string' || !input.startsWith('/')) {
    return fail('not-absolute', `${label} must be an absolute path starting with /.`);
  }
  if (input.length > MAX_PATH_LENGTH) {
    return fail('too-long', `${label} must be at most ${MAX_PATH_LENGTH} characters.`);
  }
  if (!ALLOWED_PATH_CHARACTERS.test(input)) {
    return fail(
      'bad-character',
      `${label} may contain only ${PATH_CHARACTER_SET}, for example /opt/docker/sencho.`,
    );
  }
  if (input.length > 1 && input.endsWith('/')) {
    return fail('trailing-slash', `${label} must not end with a slash.`);
  }
  if (input.includes('//')) {
    return fail('empty-segment', `${label} must not contain an empty path segment.`);
  }
  if (input === '/') {
    return fail('root', `${label} must not be the filesystem root.`);
  }
  if (input === '/') {
    return fail('root', `${label} must not be the filesystem root.`);
  }
  const segments = input.split('/').slice(1);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return fail('dot-segment', `${label} must not contain . or .. path segments.`);
  }
  if (segments.some((segment) => segment.length === 0)) {
    return fail('empty-segment', `${label} must not contain an empty path segment.`);
  }
  const normalized = path.posix.normalize(input);
  if (normalized !== input) {
    return fail('dot-segment', `${label} must be a normalized path.`);
  }
  if (segments.length < 2) {
    return fail(
      'too-shallow',
      `${label} must name a directory at least two segments deep, for example /opt/docker/sencho.`,
    );
  }
  if (DENIED_EXACT_ROOTS.includes(input)) {
    return fail('reserved', `${label} must be more specific than ${input}.`);
  }
  for (const prefix of RESERVED_PATH_PREFIXES) {
    if (input === prefix || input.startsWith(`${prefix}/`)) {
      return fail('reserved', `${label} must not be under ${prefix}. Choose a path under /opt, /srv or /home.`);
    }
  }
  return { ok: true, normalized, reason: null, message: null };
}

/** True when `child` is `parent` or lives under it, on a path boundary. */
export function isAtOrBelowPath(child: string, parent: string): boolean {
  if (child === parent) return true;
  const normalizedParent = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return child.startsWith(`${normalizedParent}/`);
}

export type PathSeparationReason = 'equal' | 'agent-inside-compose' | 'compose-inside-agent' | null;

export interface PathSeparationResult {
  ok: boolean;
  reason: PathSeparationReason;
}

/**
 * The two directories must be disjoint: the agent directory inside the stacks
 * root would be listed as a stack, and the stacks root inside the agent
 * directory would be invisible to both.
 */
export function arePathsDisjoint(composeDir: string, agentDir: string): PathSeparationResult {
  if (composeDir === agentDir) return { ok: false, reason: 'equal' };
  if (isAtOrBelowPath(agentDir, composeDir)) return { ok: false, reason: 'agent-inside-compose' };
  if (isAtOrBelowPath(composeDir, agentDir)) return { ok: false, reason: 'compose-inside-agent' };
  return { ok: true, reason: null };
}

/**
 * Single-quote a value for a POSIX shell. Every interpolated value is validated
 * first; this is the second line of defence, not the only one.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The walk both the preflight and the start script use to tell whether the
 * places Docker looks a path up in can be changed only by root and by the
 * account that runs the bootstrap. Docker reads the compose file by name and the
 * daemon resolves the bind-mounted paths (the Compose directory, the hub CA) by
 * name too, after anything a script checked, and no script can hold those names
 * through Docker's own opening of them. What a script can do is refuse a place
 * where anyone else can put something at those names. A directory passes when
 * it is owned by root or by that account and nobody else can write to it:
 *
 * - Write permission for others, or for a group, is somebody else, unless the
 *   group is root's or the account's own (primary) group and has no member but
 *   root and that account (the private group most hosts give every account has
 *   none). A directory with an access control list that grants write through
 *   the group bits is somebody else too.
 * - A writable directory with the sticky bit is the one exception, and only for
 *   an entry owned by root or by that account: such a directory lets nobody
 *   remove or rename another user's entry, the way `/tmp` does.
 *
 * `sealed DIR [KIDOWNER]` walks DIR (a physical path) and every directory above
 * it, `KIDOWNER` being the owner of the entry below DIR that the sticky rule may
 * rely on. It returns 0 when sealed, 1 for a directory someone else can change
 * (named in `$bad`), 2 for one it could not inspect (also `$bad`).
 *
 * `sealed_under NAME KIDOWNER` takes a directory as it is written, links
 * included, and checks the place each of its components is looked up in: NAME
 * resolved, then the directory NAME is in, and so on up, each one resolved and
 * walked. A link in the name lives in a directory somebody could rewrite, and
 * Docker follows the name as written, so the physical path alone is not enough.
 * `KIDOWNER` is the owner of whatever is (or will be) in NAME.
 *
 * The account is the SSH user: the user itself, or, for root, the user sudo
 * reports (`SUDO_UID`) when it is a number.
 */
export const SEALED_DIRECTORY_SHELL = [
  'me=$(id -u); trusted=$me',
  'if [ "$me" = 0 ] && [ -n "${SUDO_UID-}" ]; then trusted=$SUDO_UID; fi',
  'case $trusted in ""|*[!0-9]*) trusted=0 ;; esac',
  // Whether a group may be written to: root's or the account's own, with no other member (listed or by primary group). A lookup that fails is never "yes".
  'group_ok() {',
  '  if [ "$1" != 0 ]; then',
  '    pg=$(getent passwd "$trusted" 2>/dev/null) || return 1',
  '    pg=${pg#*:*:*:}; pg=${pg%%:*}',
  '    [ "$1" = "$pg" ] || return 1',
  '  fi',
  '  gl=$(getent group "$1" 2>/dev/null) || return 1',
  '  gl=${gl#*:*:*:}',
  '  for gn in $(printf "%s" "$gl" | tr "," " "); do',
  '    gu=$(id -u -- "$gn" 2>/dev/null) || return 1',
  '    if [ "$gu" != 0 ] && [ "$gu" != "$trusted" ]; then return 1; fi',
  '  done',
  '  pw=$(getent passwd 2>/dev/null) || return 1',
  '  [ -n "$pw" ] || return 1',
  '  printf "%s\\n" "$pw" | awk -F: -v g="$1" -v t="$trusted" \'$4 == g && $3 != 0 && $3 != t { bad = 1 } END { exit bad }\'',
  '}',
  // Whether ls shows an access control list on the path (a `+` after the mode).
  'has_acl() { al=$(ls -ld -- "$1" 2>/dev/null) || return 0; al=${al%% *}; case $al in *+) return 0 ;; esac; return 1; }',
  'sealed() {',
  '  s=$1; kid=${2-}; prev=; bad=',
  '  while :; do',
  '    st=$(stat -c "%u %g %a" -- "$s" 2>/dev/null) || { bad=$s; return 2; }',
  '    o=${st%% *}; rest=${st#* }; g=${rest%% *}; m=${rest#* }',
  '    if [ "$o" != 0 ] && [ "$o" != "$trusted" ]; then bad=$s; return 1; fi',
  '    writable=0',
  '    if [ $((0$m & 002)) -ne 0 ]; then writable=1; fi',
  '    if [ $((0$m & 020)) -ne 0 ] && { has_acl "$s" || ! group_ok "$g"; }; then writable=1; fi',
  '    if [ "$writable" = 1 ]; then',
  // Sticky and the entry below is ours: nobody else can remove or rename it. Otherwise the entry (when known) or the directory is what somebody else could replace.
  '      if [ $((0$m & 01000)) -eq 0 ]; then bad=$s; return 1; fi',
  '      if [ "$kid" != 0 ] && [ "$kid" != "$trusted" ]; then bad=${prev:-$s}; return 1; fi',
  '    fi',
  '    kid=$o; prev=$s',
  '    if [ "$s" = / ]; then return 0; fi',
  '    s=$(dirname -- "$s")',
  '  done',
  '}',
  'sealed_under() {',
  '  sn=$1; ko=$2',
  '  while :; do',
  '    pa=$(cd -P -- "$sn" 2>/dev/null && pwd -P) || { bad=$sn; return 2; }',
  '    sealed "$pa" "$ko" || return $?',
  '    if [ "$sn" = / ]; then return 0; fi',
  '    ko=$(stat -c %u -- "$sn" 2>/dev/null) || { bad=$sn; return 2; }',
  '    sn=$(dirname -- "$sn")',
  '  done',
  '}',
].join('\n');

/** Fixed facts the plan and the UI must repeat verbatim. */
export function bootstrapFixedFacts() {
  return {
    projectName: PILOT_PROJECT_NAME,
    containerName: PILOT_CONTAINER_NAME,
    dataVolume: PILOT_DATA_VOLUME,
    dataMount: PILOT_DATA_MOUNT,
    image: PILOT_IMAGE_REF,
  };
}

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
 * The walk both the preflight and the start script use to tell whether a
 * directory can be changed only by root and by the account that runs the
 * bootstrap. Docker reads the compose file by name and the daemon resolves the
 * bind-mounted paths (the Compose directory, the hub CA) by name too, after
 * anything a script checked, and no script can hold those names through Docker's
 * own opening of them. What a script can do is refuse a place where anyone else
 * can put something at those names: every directory from the one given up to
 * `/` must be owned by root or by that account and must not be writable by
 * anyone else. Write permission for others, or for a group with a member other
 * than root and that account (a user's own private group, which most hosts give
 * every account, has none), is somebody else. A writable directory with the
 * sticky bit is the one exception, and only for a child owned by root or by that
 * account: such a directory lets nobody remove or rename another user's entry,
 * the way `/tmp` does. Access control lists are not read.
 *
 * `sealed DIR [above]` returns 0 when sealed, 1 for a directory that someone
 * else can change (named in `$bad`), 2 for one it could not inspect (also
 * `$bad`). With `above`, DIR's own owner and mode are left out (only its
 * ancestors and, for the sticky rule, its owner count): the Compose directory is
 * whatever the operator chose, and only the places that could replace it matter.
 * The account is the SSH user: the user itself, or under sudo the user that ran
 * it (`SUDO_UID`), never an arbitrary uid from the environment of a root session.
 */
export const SEALED_DIRECTORY_SHELL = [
  'me=$(id -u); trusted=$me',
  'if [ "$me" = 0 ] && [ -n "${SUDO_UID-}" ]; then trusted=$SUDO_UID; fi',
  'case $trusted in ""|*[!0-9]*) trusted=0 ;; esac',
  // Whether every member of a group, those listed and those who have it as their primary group, is root or the account.
  'group_ok() {',
  '  gl=$(getent group "$1" 2>/dev/null) || return 1',
  '  gl=${gl#*:*:*:}',
  '  for gn in $(printf "%s" "$gl" | tr "," " "); do',
  '    gu=$(id -u -- "$gn" 2>/dev/null) || return 1',
  '    if [ "$gu" != 0 ] && [ "$gu" != "$trusted" ]; then return 1; fi',
  '  done',
  '  getent passwd 2>/dev/null | awk -F: -v g="$1" -v t="$trusted" \'$4 == g && $3 != 0 && $3 != t { bad = 1 } END { exit bad }\'',
  '}',
  'sealed() {',
  '  s=$1; kid=; skip=${2-}; bad=',
  '  while :; do',
  '    st=$(stat -c "%u %g %a" -- "$s" 2>/dev/null) || { bad=$s; return 2; }',
  '    o=${st%% *}; rest=${st#* }; g=${rest%% *}; m=${rest#* }',
  '    if [ -n "$skip" ]; then skip=',
  '    else',
  '      if [ "$o" != 0 ] && [ "$o" != "$trusted" ]; then bad=$s; return 1; fi',
  '      writable=0',
  '      if [ $((0$m & 002)) -ne 0 ]; then writable=1; fi',
  '      if [ $((0$m & 020)) -ne 0 ] && ! group_ok "$g"; then writable=1; fi',
  '      if [ "$writable" = 1 ]; then',
  '        if [ $((0$m & 01000)) -ne 0 ] && { [ "$kid" = 0 ] || [ "$kid" = "$trusted" ]; }; then :; else bad=$s; return 1; fi',
  '      fi',
  '    fi',
  '    kid=$o',
  '    if [ "$s" = / ]; then return 0; fi',
  '    s=$(dirname -- "$s")',
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

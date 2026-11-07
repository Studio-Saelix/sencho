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

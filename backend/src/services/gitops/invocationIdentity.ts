/**
 * The two compose invocations an invocation drift item compares, and the
 * canonical form both are reduced to first.
 *
 * One shape, because a comparison between a path the author wrote and a path
 * Compose recorded would report a difference every time rather than one that
 * means something. Every path is relative to the stack directory and every
 * project name is lowercased, so the pair is comparable across nodes whose
 * compose directory is mounted at different absolute paths, and across a stack
 * name written `Web` against the project Compose names `web`.
 *
 * Nothing here reads the filesystem or Docker. The observation arrives as
 * container labels already read by `invocationObserve`, and the authored side
 * arrives as the argv a generation was built with, so both functions are total
 * and cheap enough for the projection to call per target.
 */
import path from 'path';

import { gitSourceLocalComposeFiles } from '../../utils/gitComposeFiles';
import { decodeGitOpsJson, isRecord, type ObservedInvocationIdentity } from './json';
import type { AuthoredInvocationIdentity } from './types';

/**
 * Why an invocation could not be compared.
 *
 * `not_comparable` is a real answer and not a failure: the two sides are
 * describing the same deployment in vocabularies that cannot be aligned, and
 * the honest response is to say so rather than to pick a winner. A missing
 * observation is handled before this, by the caller, because "Sencho has not
 * looked" and "Sencho looked and cannot tell" are different facts.
 */
export type InvocationComparison =
  | { kind: 'equal' }
  | { kind: 'different'; expected: AuthoredInvocationIdentity; observed: AuthoredInvocationIdentity }
  | { kind: 'not_comparable'; reason: InvocationNotComparableReason };

export type InvocationNotComparableReason =
  | 'authored_invocation_unreadable'
  | 'authored_path_outside_stack'
  | 'observed_path_outside_stack';

const PROJECT_LABEL = 'com.docker.compose.project';
const CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const ENVIRONMENT_FILE_LABEL = 'com.docker.compose.project.environment_file';

/**
 * The stack directory, rendered as itself.
 *
 * Used for a field that is genuinely the project directory, so a comparison
 * against an observed path outside the stack directory fails rather than
 * matching on a shared prefix.
 */
const STACK_DIR_MARKER = '.';

function stackRelative(stackDir: string, candidate: string): string | null {
  const base = path.resolve(stackDir);
  const resolved = path.resolve(base, candidate);
  if (resolved === base) return STACK_DIR_MARKER;
  const relative = path.relative(base, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * The project name Compose records for a stack, which is the stack name
 * lowercased. Compose normalizes the name it writes into the label, so an
 * authored `-p Web` and an observed `web` are the same project and must not
 * read as drift.
 */
function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase();
}

function splitLabelList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return [];
  return trimmed.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Parse the ordered argv a generation was built with.
 *
 * Only the four flags that name the invocation are read, and a flag outside
 * that set ends the comparison rather than being skipped. The reason is in the
 * parse loop below: an unrecognized flag's operand cannot be told from a value,
 * so reading past one would corrupt the order everything else rests on.
 *
 * Returns null when the payload is not an argv at all, which is a real case
 * rather than a corrupt one: the column holds more than one shape, and only
 * the argv names files.
 */
function parseAuthoredArgv(decoded: unknown): string[] | null {
  if (!Array.isArray(decoded)) return null;
  const argv: string[] = [];
  for (const entry of decoded) {
    if (typeof entry !== 'string') return null;
    argv.push(entry);
  }
  return argv;
}

/**
 * Read the column's other shape: an `AuthoredInvocationIdentity` written
 * directly.
 *
 * The migration seed writes exactly this, with every field empty, and an
 * inline Blueprint generation writes `{}`. Both mean the same thing: no
 * compose invocation was ever authored for that generation. Reading the
 * fields rather than rejecting the object keeps a real authored identity
 * comparable and leaves the empty one for the emptiness check below to catch.
 */
function parseAuthoredIdentity(decoded: Record<string, unknown>): Partial<AuthoredInvocationIdentity> | null {
  const keys = Object.keys(decoded);
  if (keys.length === 0) return {};
  const allowed = ['composeFileOrder', 'projectName', 'projectDirectory', 'envFileOrder'];
  if (!keys.every((key) => allowed.includes(key))) return null;
  const files = decoded.composeFileOrder;
  const envFiles = decoded.envFileOrder;
  if (files !== undefined && !Array.isArray(files)) return null;
  if (envFiles !== undefined && !Array.isArray(envFiles)) return null;
  if ((files as unknown[] | undefined)?.some((entry) => typeof entry !== 'string')) return null;
  if ((envFiles as unknown[] | undefined)?.some((entry) => typeof entry !== 'string')) return null;
  if (decoded.projectName !== undefined && decoded.projectName !== null && typeof decoded.projectName !== 'string') return null;
  if (decoded.projectDirectory !== undefined && decoded.projectDirectory !== null && typeof decoded.projectDirectory !== 'string') return null;
  return {
    composeFileOrder: files as string[] | undefined,
    projectName: (decoded.projectName as string | null | undefined) ?? undefined,
    projectDirectory: (decoded.projectDirectory as string | null | undefined) ?? undefined,
    envFileOrder: envFiles as string[] | undefined,
  };
}

export type AuthoredInvocationInput = {
  /** `gitops_generations.expected_invocation_json` for the accepted generation. */
  expectedInvocationJson: string;
  /**
   * The application's configured compose selection, as stored. Read only when
   * the argv names no file, which is the single-file case: Compose then
   * auto-discovers, so the authored side of the file order is the selection
   * rather than the argv.
   */
  composePathsJson: string | null;
  stackName: string;
  /** The target's own stack directory on its own node, not the default node's. */
  stackDir: string;
};

export function canonicalizeAuthoredInvocation(
  input: AuthoredInvocationInput,
): { kind: 'ok'; invocation: AuthoredInvocationIdentity } | { kind: 'not_comparable'; reason: InvocationNotComparableReason } {
  let decoded: unknown;
  try {
    decoded = decodeGitOpsJson(input.expectedInvocationJson);
  } catch {
    return { kind: 'not_comparable', reason: 'authored_invocation_unreadable' };
  }

  const argv = parseAuthoredArgv(decoded);
  const written = argv === null && isRecord(decoded) ? parseAuthoredIdentity(decoded) : null;
  if (argv === null && written === null) {
    return { kind: 'not_comparable', reason: 'authored_invocation_unreadable' };
  }

  const composeFiles: string[] = written?.composeFileOrder ? [...written.composeFileOrder] : [];
  const envFiles: string[] = written?.envFileOrder ? [...written.envFileOrder] : [];
  let projectName: string | null = written?.projectName ?? null;
  let projectDirectory: string | null = written?.projectDirectory ?? null;

  if (argv !== null) {
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index]!;
      const value = argv[index + 1];
      // A flag in the last position is a truncated record, whether it is one of
      // the four that take a value or an unknown one, and it is declined for
      // the same reason an unknown flag is: there is no honest way to tell an
      // operand that was lost from a flag that takes none.
      if (value === undefined) {
        return { kind: 'not_comparable', reason: 'authored_invocation_unreadable' };
      }
      index += 1;
      if (flag === '-f') {
        const relative = stackRelative(input.stackDir, value);
        if (relative === null) {
          return { kind: 'not_comparable', reason: 'authored_path_outside_stack' };
        }
        composeFiles.push(relative);
      } else if (flag === '--env-file') {
        const relative = stackRelative(input.stackDir, value);
        if (relative === null) {
          return { kind: 'not_comparable', reason: 'authored_path_outside_stack' };
        }
        envFiles.push(relative);
      } else if (flag === '-p') {
        projectName = normalizeProjectName(value);
      } else if (flag === '--project-directory') {
        const relative = stackRelative(input.stackDir, value);
        if (relative === null) {
          return { kind: 'not_comparable', reason: 'authored_path_outside_stack' };
        }
        projectDirectory = relative;
      } else {
        // A flag this build does not know, declined rather than skipped. The
        // operand of an unknown flag cannot be told from a value, because
        // whether it takes one is not knowable from the name: reading the next
        // entry as its operand would shift every later flag by one and silently
        // drop a real `-f` or `-p`, and skipping only the flag would read the
        // following flag as its operand. Either way the file order this
        // comparison rests on would be wrong rather than absent, and a wrong
        // order reports agreement or drift, neither of which is a fact.
        return { kind: 'not_comparable', reason: 'authored_invocation_unreadable' };
      }
    }
  }

  if (argv !== null && composeFiles.length === 0) {
    // Compose omits every flag for a single-file selection and resolves the
    // compose file itself from the project directory, so the authored file
    // order is the configured selection. Without this the observed side would
    // always carry one file against an authored side carrying none, and every
    // single-file stack would report drift for the rest of time.
    const configured = parseConfiguredComposePaths(input.composePathsJson);
    if (configured === null) {
      return { kind: 'not_comparable', reason: 'authored_invocation_unreadable' };
    }
    for (const local of configured) {
      const relative = stackRelative(input.stackDir, local);
      if (relative === null) {
        return { kind: 'not_comparable', reason: 'authored_path_outside_stack' };
      }
      composeFiles.push(relative);
    }
  }

  if (composeFiles.length === 0) {
    // Nothing named a compose file, so there is no expected order to compare
    // an observed one against. The migration seed and an inline Blueprint
    // generation both land here, and reporting a difference against them would
    // mean inventing the file they never named.
    return { kind: 'not_comparable', reason: 'authored_invocation_unreadable' };
  }

  return {
    kind: 'ok',
    invocation: {
      composeFileOrder: composeFiles,
      // A stack with no explicit `-p` is named after its own directory, which
      // is the stack name. Comparing it is therefore the same comparison the
      // explicit flag would make.
      projectName: projectName ?? normalizeProjectName(input.stackName),
      projectDirectory: projectDirectory ?? STACK_DIR_MARKER,
      envFileOrder: envFiles,
    },
  };
}

function parseConfiguredComposePaths(raw: string | null): string[] | null {
  if (raw === null) return [];
  let decoded: unknown;
  try {
    decoded = decodeGitOpsJson(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) return null;
  if (!decoded.every((entry): entry is string => typeof entry === 'string')) return null;
  // The application's selection is repo-relative; the stack-local filenames it
  // is written out as are what Compose was given, and the primary is always
  // rewritten to the fixed root name.
  return gitSourceLocalComposeFiles(decoded);
}

export type ObservedLabels = Record<string, string> | undefined | null;

/**
 * Reduce the labels Compose records on a project container to the canonical
 * form.
 *
 * The three facts are required and the env file list is not: Compose only sets
 * the environment-file label when `--env-file` was passed, so an absent label
 * is an empty list rather than an unknown. A project with no containers cannot
 * be read at all, which the caller reports as no observation.
 */
export function canonicalizeObservedInvocation(
  labels: ObservedLabels,
  stackDir: string,
  observedAt: number,
): { kind: 'ok'; observation: ObservedInvocationIdentity } | { kind: 'unreadable' } {
  const projectName = labels?.[PROJECT_LABEL];
  const configFiles = splitLabelList(labels?.[CONFIG_FILES_LABEL]);
  const workingDir = labels?.[WORKING_DIR_LABEL];
  if (!projectName || !workingDir || configFiles === null) return { kind: 'unreadable' };
  // An empty file list is refused for the same reason the authored side refuses
  // one: there is no expected order to compare it against, and a comparison
  // against an empty list would report a difference where the real problem is
  // that nothing was recorded. Compose always writes at least one file into
  // this label, so an empty one is not an invocation Sencho can read.
  if (configFiles.length === 0) return { kind: 'unreadable' };

  const composeFileOrder: string[] = [];
  for (const file of configFiles) {
    const relative = stackRelative(stackDir, file);
    if (relative === null) return { kind: 'unreadable' };
    composeFileOrder.push(relative);
  }
  const projectDirectory = stackRelative(stackDir, workingDir);
  if (projectDirectory === null) return { kind: 'unreadable' };

  // Compose writes one `--env-file` per label entry, comma joined, in order.
  const envFileOrder: string[] = [];
  for (const file of splitLabelList(labels?.[ENVIRONMENT_FILE_LABEL]) ?? []) {
    const relative = stackRelative(stackDir, file);
    if (relative === null) return { kind: 'unreadable' };
    envFileOrder.push(relative);
  }

  return {
    kind: 'ok',
    observation: {
      composeFileOrder,
      projectName: normalizeProjectName(projectName),
      projectDirectory,
      envFileOrder,
      observedAt,
    },
  };
}

/**
 * Compare the authored invocation of a generation against what a node recorded.
 *
 * Order matters on both file lists: two compose files swapped is a different
 * merge and therefore a different invocation, and a different env file order
 * resolves variables differently. The two lists are compared element by
 * element rather than as sets for that reason.
 */
export function compareInvocations(
  expected: AuthoredInvocationIdentity,
  observed: ObservedInvocationIdentity,
): InvocationComparison {
  const sameFiles = sameOrderedList(expected.composeFileOrder, observed.composeFileOrder);
  const sameEnvFiles = sameOrderedList(expected.envFileOrder, observed.envFileOrder);
  if (sameFiles
    && sameEnvFiles
    && expected.projectName === observed.projectName
    && expected.projectDirectory === observed.projectDirectory) {
    return { kind: 'equal' };
  }
  return {
    kind: 'different',
    expected,
    observed: {
      composeFileOrder: observed.composeFileOrder,
      projectName: observed.projectName,
      projectDirectory: observed.projectDirectory,
      envFileOrder: observed.envFileOrder,
    },
  };
}

function sameOrderedList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

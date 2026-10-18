import path from 'path';
import { promises as fsPromises } from 'fs';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { gitSecretsAreaBase, managedAreaBase } from '../services/gitops/managedPaths';
import { NodeRegistry } from '../services/NodeRegistry';
import { isPathWithinBase, isValidRelativeStackPath } from './validation';

/**
 * Build the `docker compose` global-flag prefix (`-f` per file, `-p <project>`,
 * `--project-directory`) for a stack's authored multi-file deploy spec.
 *
 * Returns `[]` for single-file / non-git stacks (no applied spec), so every
 * caller stays byte-identical to the pre-multi-file behavior: docker compose
 * resolves the single root compose.yaml via auto-discovery.
 *
 * `applied_deploy_spec` is DB state ultimately derived from user input, and this
 * prefix is spliced straight into a child-process argv, so it is treated as a
 * spawn sink: every file path and the context dir is re-validated with the
 * relative-path rules and resolved under the stack directory. A malformed,
 * absolute, or escaping entry throws here, before any `docker compose` runs.
 *
 * `-p <stackName>` pins the Compose project name so container labels stay
 * `com.docker.compose.project=<stackName>` even when `--project-directory`
 * changes the directory basename Compose would otherwise derive the name from.
 */
export function authoredComposeFileArgs(stackName: string, nodeId?: number, stackDirOverride?: string): string[] {
  const resolvedNodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
  const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec;
  if (!spec || spec.files.length === 0) return [];

  const baseDir = NodeRegistry.getInstance().getComposeDir(resolvedNodeId);
  const stackDir = stackDirOverride ? path.resolve(stackDirOverride) : path.resolve(baseDir, stackName);

  const args: string[] = [];
  for (const file of spec.files) {
    if (!file || !isValidRelativeStackPath(file)) {
      throw new Error(`Invalid compose file path in deploy spec for stack "${stackName}"`);
    }
    if (!isPathWithinBase(path.resolve(stackDir, file), stackDir)) {
      throw new Error(`Compose file path escapes the stack directory for stack "${stackName}"`);
    }
    args.push('-f', file);
  }

  args.push('-p', stackName);

  if (spec.contextDir) {
    if (!isValidRelativeStackPath(spec.contextDir)) {
      throw new Error(`Invalid context directory in deploy spec for stack "${stackName}"`);
    }
    const ctxAbs = path.resolve(stackDir, spec.contextDir);
    if (!isPathWithinBase(ctxAbs, stackDir)) {
      throw new Error(`Context directory escapes the stack directory for stack "${stackName}"`);
    }
    args.push('--project-directory', ctxAbs);
  }

  return args;
}

/**
 * `--env-file` for a root `.env` already known to sit under an area root
 * (`git-secrets` or `git-managed` only; never the candidate directory).
 * The path passed to the filesystem is contained against that area root.
 * After realpath, the file must be exactly where its name claims. A symlink
 * of the data directory stays valid. A link inside the area does not.
 */
async function readClaimedAreaEnv(
  stackName: string,
  envPath: string,
  areaRoot: string,
): Promise<string[]> {
  const root = path.resolve(areaRoot);
  if (!envPath.startsWith(root + path.sep)) {
    throw new Error(`Project env file path escapes stack directory for stack "${stackName}": ".env"`);
  }
  const relative = path.relative(root, envPath);
  if (relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Project env file path escapes stack directory for stack "${stackName}": ".env"`);
  }
  try {
    await fsPromises.access(envPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let realRoot: string;
  let realEnvPath: string;
  try {
    realRoot = await fsPromises.realpath(root);
    realEnvPath = await fsPromises.realpath(envPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (path.resolve(realRoot, relative) !== realEnvPath) {
    throw new Error(`Stack root .env for stack "${stackName}" resolves outside the stack directory.`);
  }
  const stat = await fsPromises.stat(realEnvPath);
  if (!stat.isFile()) {
    throw new Error(`Stack root .env for stack "${stackName}" is not a regular file.`);
  }
  return ['--env-file', realEnvPath];
}

function rejectBadProjectEnvName(stackName: string, file: string): void {
  if (!file || !isValidRelativeStackPath(file)) {
    throw new Error(`Invalid project env file path for stack "${stackName}": "${file}"`);
  }
  // Project env files live at the stack root, matching Compose auto-discovery.
  if (file.includes('/') || file.includes('\\')) {
    throw new Error(
      `Project env file "${file}" for stack "${stackName}" must be at the stack root. ` +
      `Update the project env file selection in the Environment tab.`
    );
  }
}

/** Refusal for a configured env file that resolves outside its authorized tree. */
function envResolvesOutsideError(stackName: string, file: string): Error {
  return new Error(
    `Project env file "${file}" for stack "${stackName}" resolves outside the stack directory. ` +
    `Update the project env file selection in the Environment tab.`
  );
}

/**
 * Build `--env-file` arguments for the stack's configured project env files.
 *
 * When the stack has one or more project env files configured (via the
 * project-env-files API), each file is resolved against the stack directory,
 * validated for containment and file type, and emitted as a repeated
 * `--env-file <absPath>` flag. Configured files apply to ALL stack types
 * (single-file, multi-file Git, non-Git).
 *
 * A file that exists in `preferredEnvDir` (the candidate or decrypt overlay
 * being validated) is taken from there. A deploy `stackDirOverride` under the
 * git-secrets or git-managed area is treated the same way. Files that are not
 * in that tree stay on the live stack. An override outside those roots and
 * outside the live stack is rejected. Containment is checked on real paths
 * against real roots, so a relocated (symlinked) data or compose directory is
 * accepted while a link out of the authorized tree is refused.
 * `options.missingMode: 'skip'` omits a configured file that is not on disk.
 * The change-plan snapshot uses that so a pull can continue. Deploy still
 * refuses a missing file.
 *
 * When no project env files are configured, fall back to the legacy behavior:
 * pass `--env-file <stackDir>/.env` only for multi-file Git stacks whose
 * deploy spec sets a contextDir and whose root `.env` actually exists.
 * A root `.env` under git-secrets or git-managed is resolved to the path its
 * name claims after realpath, so a relocated data directory still matches and
 * a link inside the area does not. The area root is those two directories,
 * not the candidate. An area that sits inside the compose root (DATA_DIR
 * nested under COMPOSE_DIR) is still recognized as an area, so validation and
 * deployment select the same file. Validation uses the same check. An override
 * outside the live stack and those areas is rejected. A live stack with no
 * override stays on the compose-root path.
 */
export async function authoredComposeEnvFileArgs(
  stackName: string,
  nodeId?: number,
  stackDirOverride?: string,
  preferredEnvDir?: string,
  options?: { missingMode?: 'throw' | 'skip' },
): Promise<string[]> {
  const missingMode = options?.missingMode ?? 'throw';
  const resolvedNodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
  const db = DatabaseService.getInstance();
  const configuredFiles = db.getStackProjectEnvFiles(resolvedNodeId, stackName);

  if (configuredFiles.length > 0) {
    const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(resolvedNodeId));
    const liveDir = path.resolve(baseResolved, stackName);
    if (!stackDirOverride && !preferredEnvDir && !liveDir.startsWith(baseResolved + path.sep)) return [];

    const preferred = preferredEnvDir ? path.resolve(preferredEnvDir) : null;
    const override = stackDirOverride ? path.resolve(stackDirOverride) : null;
    const secretsRoot = path.resolve(gitSecretsAreaBase());
    const managedRoot = path.resolve(managedAreaBase());
    let overrideRoot: string | null = null;
    if (override && !preferred) {
      if (override.startsWith(secretsRoot + path.sep)) overrideRoot = secretsRoot;
      else if (override.startsWith(managedRoot + path.sep)) overrideRoot = managedRoot;
      else if (override !== liveDir && !override.startsWith(liveDir + path.sep)) {
        const file = configuredFiles[0] ?? '';
        throw new Error(`Project env file path escapes stack directory for stack "${stackName}": "${file}"`);
      }
    }

    const args: string[] = [];
    for (const file of configuredFiles) {
      rejectBadProjectEnvName(stackName, file);
      let envDir = liveDir;
      let allowedRoot = baseResolved;
      const prefer = preferred ?? (overrideRoot ? override : null);
      if (prefer) {
        const preferPath = path.resolve(prefer, file);
        // Barrier for a candidate or overlay dir, inline with the access sink.
        if (preferPath.startsWith(prefer + path.sep)) {
          try {
            await fsPromises.access(preferPath);
            envDir = prefer;
            allowedRoot = overrideRoot && !preferred ? overrideRoot : prefer;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        }
      }
      const envPath = path.resolve(envDir, file);
      // Canonical js/path-injection barrier. Live files are checked against
      // the compose root. A preferred candidate or decrypt overlay is checked
      // against that directory. A deploy override under git-secrets or
      // git-managed is checked against that area root. CodeQL still treats a
      // check against only a directory that embeds stackName as tainted.
      if (!envPath.startsWith(allowedRoot + path.sep)) {
        throw new Error(`Project env file path escapes stack directory for stack "${stackName}": "${file}"`);
      }
      let realEnvPath: string;
      try {
        realEnvPath = await fsPromises.realpath(envPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          if (missingMode === 'skip') continue;
          throw new Error(
            `Project env file "${file}" configured for stack "${stackName}" is missing. ` +
            `Restore the file or update the project env file selection in the Environment tab.`
          );
        }
        throw err;
      }
      if (!realEnvPath.startsWith(allowedRoot + path.sep)) {
        // A relocated data or compose directory (a symlinked DATA_DIR, or a
        // symlinked COMPOSE_DIR) makes the physical file path differ from the
        // lexical root while the file is exactly where its name claims, so the
        // real path is compared against the real root.
        const realAllowedRoot = await fsPromises.realpath(allowedRoot);
        if (!realEnvPath.startsWith(realAllowedRoot + path.sep)) {
          throw envResolvesOutsideError(stackName, file);
        }
      }
      if (envDir !== liveDir && !realEnvPath.startsWith(path.resolve(envDir) + path.sep)) {
        const realEnvDir = await fsPromises.realpath(envDir);
        if (!realEnvPath.startsWith(realEnvDir + path.sep)) {
          throw envResolvesOutsideError(stackName, file);
        }
      }
      const stat = await fsPromises.stat(realEnvPath);
      if (!stat.isFile()) {
        throw new Error(
          `Project env file "${file}" configured for stack "${stackName}" is not a regular file. ` +
          `Update the project env file selection in the Environment tab.`
        );
      }
      args.push('--env-file', realEnvPath);
    }
    return args;
  }

  // Legacy fallback: --env-file .env only for multi-file Git stacks with contextDir.
  const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec;
  if (!spec || spec.files.length === 0 || !spec.contextDir) return [];

  // Inline barrier at the fs sink. Area files are checked against the
  // git-secrets or git-managed root. Live files are checked against the
  // compose root. A check against only a directory that embeds stackName
  // does not count, and neither does a helper whose root argument is sometimes
  // the candidate directory.
  const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(resolvedNodeId));
  const stackDir = stackDirOverride ? path.resolve(stackDirOverride) : path.resolve(baseResolved, stackName);
  const secretsRoot = path.resolve(gitSecretsAreaBase());
  const managedRoot = path.resolve(managedAreaBase());
  const envPath = path.resolve(stackDir, '.env');
  // Area membership is checked before compose-root membership: DATA_DIR can be
  // nested under COMPOSE_DIR, and an area there is still an authorized area.
  // Candidate validation accepts it, so deployment must select the same file.
  if (envPath.startsWith(secretsRoot + path.sep)) {
    return readClaimedAreaEnv(stackName, envPath, secretsRoot);
  }
  if (envPath.startsWith(managedRoot + path.sep)) {
    return readClaimedAreaEnv(stackName, envPath, managedRoot);
  }
  if (stackDirOverride) {
    const liveDir = path.resolve(baseResolved, stackName);
    const onLiveStack = stackDir === liveDir || stackDir.startsWith(liveDir + path.sep);
    if (!onLiveStack || !stackDir.startsWith(baseResolved + path.sep)) {
      throw new Error(`Project env file path escapes stack directory for stack "${stackName}": ".env"`);
    }
  } else if (!stackDir.startsWith(baseResolved + path.sep)) {
    return [];
  }
  // Barrier must sit on the path passed to access/return, against the compose root.
  if (!envPath.startsWith(baseResolved + path.sep)) return [];
  try {
    await fsPromises.access(envPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return ['--env-file', envPath];
}

/**
 * What COMPOSE_FILE decides about a run's compose layers.
 *
 * Compose replaces its own file discovery with that variable's value whenever it
 * is set in the process environment or in the env file it loads, and a `-f`
 * flag replaces the variable in turn, so `-f a -f b` and `COMPOSE_FILE=a:b` load
 * the same layers. Sencho never sets it, so a stack that does selects its layers
 * from something the stack directory alone does not describe.
 *
 * `unknown` means an env file Compose loads could not be read, so nothing here
 * can claim what the variable holds. Callers must treat it as deciding, because
 * inferring a layer set and pinning it is the failure this exists to prevent.
 */
export type ComposeFileEnvSelection =
  | { kind: 'absent' }
  | { kind: 'value'; value: string; pathSeparator: string }
  | { kind: 'unknown' };

/** Compose's chain separator when COMPOSE_PATH_SEPARATOR is unset or empty. */
export const DEFAULT_PATH_SEPARATOR = ':';

/** One dotenv assignment, with Compose's quoting and comment rules applied. */
function unquoteDotenvValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const closing = raw.indexOf(quote, 1);
    return closing === -1 ? raw.slice(1) : raw.slice(1, closing);
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

/**
 * Every assignment in dotenv text, last definition of a name winning.
 *
 * Covers the single-line forms Compose reads the same way: an unquoted trailing
 * `# ...` is a comment, a quoted value keeps its `#` verbatim, and a value may
 * be wrapped in matching single or double quotes. A quoted value continued on a
 * following line is read as its first line only, which for COMPOSE_FILE means the
 * chain does not resolve and the capture refuses rather than pinning a guess.
 */
export function parseDotenv(content: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) assignments.set(match[1], unquoteDotenvValue(match[2]));
  }
  return assignments;
}

export async function composeFileEnvVarSelection(stackName: string, nodeId?: number): Promise<ComposeFileEnvSelection> {
  const resolvedNodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
  const fsSvc = FileSystemService.getInstance(resolvedNodeId);
  let envArgs: string[];
  try {
    envArgs = await authoredComposeEnvFileArgs(stackName, resolvedNodeId);
  } catch {
    return { kind: 'unknown' };
  }
  const selected = envArgs.filter((_, index) => index % 2 === 1 && envArgs[index - 1] === '--env-file');
  // Compose reads a selected --env-file INSTEAD of the project .env, so the
  // project file only decides the value when no --env-file was given. Reading
  // both and taking one of them would answer for a variable Compose never
  // consulted.
  const sources = selected.length > 0 ? selected : [null];
  // Compose applies env files in the order given and lets a later one win.
  const merged = new Map<string, string>();
  for (const envPath of sources) {
    let content: string;
    try {
      content = envPath === null ? await fsSvc.getEnvContent(stackName) : await fsSvc.readFile(envPath);
    } catch (err) {
      if (envPath === null && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { kind: 'unknown' };
    }
    for (const [name, value] of parseDotenv(content)) merged.set(name, value);
  }
  // The process environment sits above every file.
  const value = process.env.COMPOSE_FILE ?? merged.get('COMPOSE_FILE');
  if (value === undefined) return { kind: 'absent' };
  return {
    kind: 'value',
    value,
    pathSeparator: process.env.COMPOSE_PATH_SEPARATOR ?? merged.get('COMPOSE_PATH_SEPARATOR') ?? DEFAULT_PATH_SEPARATOR,
  };
}

/**
 * True when COMPOSE_FILE, not Compose's own file discovery, decides which
 * compose files a run loads. Anything that cannot be read counts as deciding.
 *
 * Shared by the effective-anatomy renderer and the rollback inventory so both
 * agree on which stacks are unverifiable.
 */
export async function composeFileEnvVarSelectsLayers(stackName: string, nodeId?: number): Promise<boolean> {
  return (await composeFileEnvVarSelection(stackName, nodeId)).kind !== 'absent';
}

/**
 * `env_file` arguments for candidate `docker compose config` validation.
 * A configured project env file that exists on the candidate (or the decrypt
 * overlay passed as `candidateAbs`) is read from there. Configured files the
 * candidate does not carry stay on the live stack. Otherwise a context-dir
 * stack uses the candidate `.env` when that file exists on the candidate. If
 * it does not, fall back to the live legacy `.env` only when that file will
 * survive promotion (`syncEnv` is false). A managed synced `.env` that this
 * generation omits must not be used for validation.
 */
export async function candidateValidationEnvFileArgs(opts: {
  stackName: string;
  nodeId: number;
  candidateAbs: string;
  contextDir: string | null;
  syncEnv: boolean;
}): Promise<string[]> {
  const configured = DatabaseService.getInstance().getStackProjectEnvFiles(opts.nodeId, opts.stackName);
  if (configured.length > 0) {
    return authoredComposeEnvFileArgs(opts.stackName, opts.nodeId, undefined, opts.candidateAbs);
  }
  if (!opts.contextDir) return [];
  const baseResolved = path.resolve(opts.candidateAbs);
  const candidateEnv = path.resolve(baseResolved, '.env');
  const secretsRoot = path.resolve(gitSecretsAreaBase());
  const managedRoot = path.resolve(managedAreaBase());
  if (candidateEnv.startsWith(baseResolved + path.sep) && candidateEnv.startsWith(secretsRoot + path.sep)) {
    const claimed = await readClaimedAreaEnv(opts.stackName, candidateEnv, secretsRoot);
    if (claimed.length > 0) return claimed;
  } else if (candidateEnv.startsWith(baseResolved + path.sep) && candidateEnv.startsWith(managedRoot + path.sep)) {
    const claimed = await readClaimedAreaEnv(opts.stackName, candidateEnv, managedRoot);
    if (claimed.length > 0) return claimed;
  } else {
    try {
      if (candidateEnv.startsWith(baseResolved + path.sep)) {
        await fsPromises.access(candidateEnv);
        const stat = await fsPromises.lstat(candidateEnv);
        if (stat.isSymbolicLink()) {
          throw new Error(`Stack root .env for stack "${opts.stackName}" resolves outside the stack directory.`);
        }
        if (!stat.isFile()) {
          throw new Error(`Stack root .env for stack "${opts.stackName}" is not a regular file.`);
        }
        return ['--env-file', candidateEnv];
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  if (opts.syncEnv) return [];
  return authoredComposeEnvFileArgs(opts.stackName, opts.nodeId);
}

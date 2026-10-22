import path from 'path';
import { promises as fsPromises } from 'fs';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { gitSecretsAreaBase, managedAreaBase } from '../services/gitops/managedPaths';
import { NodeRegistry } from '../services/NodeRegistry';
import { isPathWithinBase, isValidRelativeStackPath } from './validation';
import { ComposeEnvFiles, DEFAULT_PATH_SEPARATOR } from './composeDotenv';
import { getErrorMessage } from './errors';

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
    throw notRegularEnvFileError(`Stack root .env for stack "${stackName}" is not a regular file.`);
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

/** Refusal for a configured env file that exists but is not a regular file. */
function notRegularEnvFileError(message: string): Error & { code: 'NOT_A_FILE' } {
  return Object.assign(new Error(message), { code: 'NOT_A_FILE' as const });
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
        throw notRegularEnvFileError(
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
 * The value is read out of the same files, in the same order, with the same
 * quoting, escapes and interpolation Compose applies (`ComposeEnvFiles`), so the
 * chain this returns is the chain the deploy ran.
 *
 * `unknown` means a file Compose loads could not be read, or its syntax is one
 * this reader cannot reproduce. Callers must treat it as deciding, because
 * inferring a layer set and pinning it is the failure this exists to prevent.
 *
 * `invalid` means a file the run is told to load exists but is not a regular
 * file, so Compose cannot read it at all. Unlike `unknown` this is never an
 * omission a capture may leave out: Compose would wait on a FIFO or fail on a
 * directory instead of rendering the project, so a capture refuses and a
 * recovery refuses to launch.
 *
 * `composeEnvFiles` names the files COMPOSE_ENV_FILES supplied, absolute, so a
 * capture can report that it does not hold them.
 *
 * `loadedEnvFiles` names every env file the run is given to load for
 * interpolation, in the order Compose reads them, whichever source selected
 * them, whether or not this reader could read the file: a path the compose-root
 * containment refuses here is one Compose can still read, and a file this
 * reader cannot reproduce at all is still one the run was told to load. A stack's
 * layers can be pinned by `-f` while those files still render every value in
 * them, so a capture that claims complete coverage has to account for the ones it
 * does not hold; naming a file the run cannot read costs a note and never widens
 * what a generation holds. The project `.env` is the one optional source, so it
 * is named only when it exists; a run with no source at all (no selected file and
 * the default env file disabled) reads no file.
 *
 * `stackEnvRead` and `projectEnvDisabled` describe the default env input the run
 * builds before it selects a project directory. Compose reads the working
 * directory's `.env` there, and it decides whether to load the selected project
 * directory's own `.env` from the environment that read produced. When the
 * stack `.env` itself supplies `COMPOSE_DISABLE_ENV_FILE=true`, Compose still
 * uses the file to resolve COMPOSE_FILE but does not load its assignments for
 * interpolation, and it skips the nested project `.env` too. A process-level
 * `false` wins over the file and keeps both enabled. Callers that replay the
 * invocation must use the evaluated decision and must not treat `stackEnvRead`
 * alone as proof that the file's values were applied.
 */
export type ComposeFileEnvSelection =
  | {
    kind: 'absent';
    composeEnvFiles: string[];
    loadedEnvFiles: string[];
    /**
     * True when the stack root `.env` was read: Compose looks for the default
     * env input in the working directory before it knows the project
     * directory, and that file is the only one it can read there. This alone
     * does not mean its values reached interpolation; see `projectEnvDisabled`.
     */
    stackEnvRead: boolean;
    /**
     * True when Compose does not load the selected project directory's `.env`.
     * An explicit source replaces it, the process environment can disable it,
     * and so can the value the run evaluates for COMPOSE_DISABLE_ENV_FILE
     * after it has read the stack root `.env`. When the stack root `.env`
     * supplies the disable, its own assignments are also left out of the
     * interpolation environment.
     */
    projectEnvDisabled: boolean;
  }
  | {
    kind: 'value';
    value: string;
    pathSeparator: string;
    composeEnvFiles: string[];
    loadedEnvFiles: string[];
    /** See the `absent` variant. */
    stackEnvRead: boolean;
    /** See the `absent` variant. */
    projectEnvDisabled: boolean;
  }
  | { kind: 'unknown'; reason: string; loadedEnvFiles: string[] }
  | { kind: 'invalid'; reason: string; loadedEnvFiles: string[] };

export { DEFAULT_PATH_SEPARATOR };

/**
 * The files COMPOSE_ENV_FILES names, or [] when it is unset or empty. Compose
 * splits the value on commas, ignores empty entries, and falls back to the
 * project .env when the result names no file. Every non-empty entry is used
 * verbatim, spaces included: Compose treats them as part of the filename.
 */
export function composeEnvFilesFromProcess(): string[] {
  const raw = process.env.COMPOSE_ENV_FILES;
  if (raw === undefined || raw === '') return [];
  return raw.split(',').filter((entry) => entry.length > 0);
}

/**
 * True or false as Go's strconv.ParseBool reads it, which is the check Compose
 * makes on COMPOSE_DISABLE_ENV_FILE; null for a value it refuses, so the run
 * fails instead of choosing a default.
 */
function parseGoBoolean(raw: string): boolean | null {
  switch (raw) {
    case '1': case 't': case 'T': case 'TRUE': case 'true': case 'True':
      return true;
    case '0': case 'f': case 'F': case 'FALSE': case 'false': case 'False':
      return false;
    default:
      return null;
  }
}

/**
 * The env files a run reads for interpolation, in read order. Compose reads one
 * set: an explicit --env-file wins over COMPOSE_ENV_FILES, which wins over the
 * project .env. A relative COMPOSE_ENV_FILES entry resolves against the working
 * directory, which is the stack directory for every Sencho spawn. A `path` of
 * null is the project .env, which is read through the stack's own accessor.
 */
function envFileSources(
  stackDir: string,
  selected: string[],
  listed: string[],
): { sources: Array<{ path: string | null; listed: boolean }> } | { reason: string } {
  if (selected.length > 0) {
    return { sources: selected.map((envPath) => ({ path: envPath, listed: false })) };
  }
  if (listed.length > 0) {
    return { sources: listed.map((entry) => ({ path: path.resolve(stackDir, entry), listed: true })) };
  }
  // Compose loads the project .env only when nothing above selected a file, and
  // it refuses to run when COMPOSE_DISABLE_ENV_FILE holds a value its boolean
  // parser does not accept. An ignored file must not decide anything here.
  const disabledRaw = process.env.COMPOSE_DISABLE_ENV_FILE;
  if (disabledRaw !== undefined) {
    const disabled = parseGoBoolean(disabledRaw);
    if (disabled === null) {
      return {
        reason: `COMPOSE_DISABLE_ENV_FILE is set to ${JSON.stringify(disabledRaw)}, which Compose does not accept as a boolean`,
      };
    }
    if (disabled) return { sources: [] };
  }
  return { sources: [{ path: null, listed: false }] };
}

/**
 * Express an authorized compose-root file path in the compose root's lexical
 * spelling.
 *
 * `authoredComposeEnvFileArgs` returns the physical path after realpath, which
 * is what the deploy hands Compose. The compose-root read guard works against
 * the lexical `getComposeDir`, so when COMPOSE_DIR is itself a link the two
 * prefixes differ and an ordinary stack-local file reads as an escape. Only a
 * path inside the physical root is rewritten; anything else keeps its spelling
 * and stays subject to the guard's real-path check.
 */
export async function lexicalComposePath(nodeId: number, physicalPath: string): Promise<string> {
  const lexicalRoot = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));
  try {
    const realRoot = await fsPromises.realpath(lexicalRoot);
    if (physicalPath === realRoot || physicalPath.startsWith(realRoot + path.sep)) {
      return path.join(lexicalRoot, path.relative(realRoot, physicalPath));
    }
  } catch (e) {
    // A compose root that does not exist yet has no physical spelling to map.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return physicalPath;
}

export async function composeFileEnvVarSelection(stackName: string, nodeId?: number): Promise<ComposeFileEnvSelection> {
  const resolvedNodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
  const fsSvc = FileSystemService.getInstance(resolvedNodeId);
  let envArgs: string[];
  try {
    envArgs = await authoredComposeEnvFileArgs(stackName, resolvedNodeId);
  } catch (e) {
    // A configured env file that exists but is not a regular file is a refusal
    // the run cannot proceed past, not a selection this reader could not
    // decide: Compose would open it and wait or fail there.
    if ((e as NodeJS.ErrnoException).code === 'NOT_A_FILE') {
      return {
        kind: 'invalid',
        reason: (e as Error).message,
        loadedEnvFiles: [],
      };
    }
    return {
      kind: 'unknown',
      reason: getErrorMessage(e, 'a selected env file could not be read'),
      loadedEnvFiles: [],
    };
  }
  const selected = envArgs.filter((_, index) => index % 2 === 1 && envArgs[index - 1] === '--env-file');
  const listed = selected.length > 0 ? [] : composeEnvFilesFromProcess();
  const stackDir = path.resolve(NodeRegistry.getInstance().getComposeDir(resolvedNodeId), stackName);
  const resolvedSources = envFileSources(stackDir, selected, listed);
  if ('reason' in resolvedSources) {
    return { kind: 'unknown', reason: resolvedSources.reason, loadedEnvFiles: [] };
  }
  const sources = resolvedSources.sources;
  // Compose looks for its default env input in the working directory, so that
  // input is the stack root `.env` when nothing replaced it.
  const defaultPathActive = sources.some((source) => source.path === null);
  let stackEnvRead = false;

  const reader = new ComposeEnvFiles((name) => process.env[name]);
  const composeEnvFiles: string[] = [];
  // Every file the run was given to load, in read order. Named before any read,
  // because a read that fails stops this reader while the file list Compose
  // holds is still what it loads: a caller accounting for coverage has to see
  // every name, including the ones after a file this reader refused. The project
  // .env is the one optional source, so it is named only once it is read.
  const loadedEnvFiles: string[] = [];
  for (const source of sources) {
    if (source.path !== null) loadedEnvFiles.push(source.path);
  }
  const unreadable = (reason: string): ComposeFileEnvSelection => ({
    kind: 'unknown',
    reason,
    loadedEnvFiles,
  });
  const invalid = (reason: string): ComposeFileEnvSelection => ({
    kind: 'invalid',
    reason,
    loadedEnvFiles,
  });
  for (const source of sources) {
    let content: string;
    if (source.path === null) {
      const projectEnv = path.resolve(stackDir, '.env');
      try {
        content = await fsSvc.getEnvContent(stackName);
      } catch (err) {
        // A stack with no project .env is an ordinary run, not an unknown, and
        // an absent default file is not one Compose loads either.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // The file is there but this reader could not read it, so the run reads
        // it wherever Compose can and the name is kept for the reason above.
        loadedEnvFiles.push(projectEnv);
        if ((err as NodeJS.ErrnoException).code === 'NOT_A_FILE') {
          return invalid('The project .env is not a regular file, so Compose cannot read it for interpolation');
        }
        return unreadable('the project .env could not be read');
      }
      loadedEnvFiles.push(projectEnv);
      stackEnvRead = true;
    } else {
      try {
        // A COMPOSE_ENV_FILES entry is read through the compose-root containment
        // rule every other env-file read uses, so a path outside it is refused
        // rather than read, and the reason below names the file so the operator
        // can move it into the compose folder. The read itself refuses a target
        // that is not a regular file without blocking on it.
        content = await fsSvc.readEnvFile(await lexicalComposePath(resolvedNodeId, source.path));
      } catch (err) {
        const named = source.listed ? source.path : path.basename(source.path);
        if ((err as NodeJS.ErrnoException).code === 'NOT_A_FILE') {
          return invalid(`The env file ${named} is not a regular file, so Compose cannot read it for interpolation`);
        }
        // Compose refuses to run when a file it was told to read is missing or
        // unreadable, so nothing here can claim which layers the run would load.
        return unreadable(`the env file ${named} could not be read`);
      }
      if (source.listed) composeEnvFiles.push(source.path);
    }
    try {
      reader.read(content);
    } catch (e) {
      // Unsupported syntax: refuse rather than pin a guess. The file is already
      // named, because Compose reads it whatever this reader can reproduce.
      return unreadable(
        `${source.listed && source.path !== null ? `${source.path} ` : ''}cannot be read the way Compose reads it: ${getErrorMessage(e, 'unsupported syntax')}`,
      );
    }
  }

  // Compose decides whether to load the project directory's own `.env` from the
  // environment it built before selecting that directory. An explicit source,
  // or a process-level disable, leaves the default input unread, so it is
  // suppressed too. A value the stack `.env` supplies is evaluated here: when
  // true, Compose used the file for config details but did not load its values
  // for interpolation, and it also skips the nested project `.env`. A value its
  // boolean parser refuses stops Compose before any project is rendered.
  let projectEnvDisabled = !defaultPathActive;
  if (defaultPathActive) {
    const disabledRaw = reader.lookup('COMPOSE_DISABLE_ENV_FILE');
    if (disabledRaw !== undefined) {
      const disabled = parseGoBoolean(disabledRaw);
      if (disabled === null) {
        return unreadable(
          `COMPOSE_DISABLE_ENV_FILE is set to ${JSON.stringify(disabledRaw)}, which Compose does not accept as a boolean`,
        );
      }
      projectEnvDisabled = disabled;
    }
  }

  // The process environment sits above every file, and the files in the order
  // Compose reads them.
  const value = reader.lookup('COMPOSE_FILE');
  if (value === undefined) {
    return { kind: 'absent', composeEnvFiles, loadedEnvFiles, stackEnvRead, projectEnvDisabled };
  }
  const separator = reader.lookup('COMPOSE_PATH_SEPARATOR');
  return {
    kind: 'value',
    value,
    pathSeparator: separator === undefined || separator === '' ? DEFAULT_PATH_SEPARATOR : separator,
    composeEnvFiles,
    loadedEnvFiles,
    stackEnvRead,
    projectEnvDisabled,
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

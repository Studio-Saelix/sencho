import path from 'path';
import { sanitizeForLog } from '../utils/safeLog';
import { DataRestoreFenceError, isDataRestoreFenceError } from './dataRestoreFenceError';

/** The values of every `-f`, `--file` and `--file=` flag in a Compose argv, in order. */
export function composeArgvFiles(args: readonly string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === '-f' || arg === '--file') && i + 1 < args.length) {
      files.push(args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--file=')) {
      files.push(arg.slice('--file='.length));
    }
  }
  return files;
}

/**
 * An early ask, before a command's side effects; the binding check is the
 * admission at its spawn (`prepareComposeAdmission`), which also covers the
 * files an argv with no `-f` opens and holds the fence off until the process
 * exits.
 *
 * Throw the fence's refusal when a file a Compose argv names with `-f`
 * (resolved against `cwd`, the command's working directory), whatever the
 * action (`config`, `pull`, `build`, `down` open their files as `up` does),
 * or a path a link on the way to it names, sits in a directory a data restore
 * is overwriting; a file missing there may only be mid-swap, so it refuses too.
 *
 * ComposeService asks it when it assembles each argv (a deploy's `up` before
 * its verification pull, when there is one), so a layer it adds
 * after the caller's own ask (`FileSystemService.refuseIfComposeFenced`) is
 * still asked: the root file and override that a recovery, Mesh, Pilot,
 * digest-pin or bind-remap layer pins, and a captured invocation's file set.
 * Those generated layers are asked too; they live outside any stack directory,
 * so they refuse only when a restore really holds them. An argv with no `-f`
 * is left to the caller's ask and to the spawn admission. A check that cannot run while a fence is held
 * is the fence's `unproven` refusal, as in `refuseIfComposeFenced`. No
 * filesystem work when nothing is fenced.
 */
export async function refuseIfComposeArgvFenced(cwd: string, args: readonly string[]): Promise<void> {
  const files = composeArgvFiles(args);
  if (files.length === 0) return;
  const { RestoreFenceStore } = await import('../services/recovery/restoreFence');
  const fenced = RestoreFenceStore.getInstance().liveFencedFsTargets();
  if (fenced.length === 0) return;
  try {
    const { refuseIfFencedSource } = await import('./envFileResolution');
    for (const file of files) {
      await refuseIfFencedSource(path.resolve(cwd, file));
    }
  } catch (err) {
    if (isDataRestoreFenceError(err)) throw err;
    console.warn(
      '[ComposeArgvFence] Could not check the compose files of %s against a data restore; answering as unproven: %s',
      sanitizeForLog(cwd),
      sanitizeForLog((err as Error)?.message ?? String(err)),
    );
    throw new DataRestoreFenceError(fenced[0].hostPath, 'unproven', 'directory');
  }
}

/** A piece of file work matched against the directory fences, ready to be admitted. */
export interface FileWorkAdmission {
  /**
   * Register the work, or throw the fence's refusal for a directory fenced
   * since the match. Synchronous, so a caller that starts its work in the same
   * step (a spawn) cannot be overtaken by a fence: the fence either is seen
   * here or finds the registration and waits for it (`waitForFsWorkOn`). The
   * caller releases the lease once the work has settled.
   */
  admit(): FsWorkLeaseLike;
}

/**
 * The part of `FsWorkLease` the callers here use; kept structural so this
 * module imports no recovery code statically.
 */
export interface FsWorkLeaseLike {
  recheck(): DataRestoreFenceError | null;
  release(): void;
}

const NO_FILE_WORK: FsWorkLeaseLike = { recheck: () => null, release: () => undefined };

/**
 * Match file work that reads or writes `paths` (absolute, in Sencho's
 * namespace) against the directory fences, by every spelling a link on the way
 * gives each path, and return the admission that registers it. A path a live
 * restore holds refuses here. A match that cannot run while a fence is held is
 * the fence's `unproven` refusal; with nothing fenced it is registered by
 * `fallback` instead (the directory the work runs in), so a fence recorded
 * while it runs still finds it and waits. Work with no paths is matched and
 * registered by `fallback` too. The spellings are worked out whether or not
 * anything is fenced (a readlink per path component), because a fence
 * recorded while the work runs compares them in its drain.
 */
export async function prepareFileWorkAdmission(paths: readonly string[], fallback: string): Promise<FileWorkAdmission> {
  const { matchFsWorkToFences, admitFsWork, RestoreFenceStore } = await import('../services/recovery/restoreFence');
  const { linkSpellings } = await import('./linkSpellings');
  let spellings: string[];
  let checked: ReadonlySet<string>;
  try {
    const lists = await Promise.all((paths.length > 0 ? paths : [fallback]).map((p) => linkSpellings(p)));
    spellings = [...new Set(lists.flat())];
    const match = await matchFsWorkToFences(spellings);
    if (match.refusal) throw match.refusal;
    checked = match.checked;
  } catch (err) {
    if (isDataRestoreFenceError(err)) throw err;
    const fenced = RestoreFenceStore.getInstance().liveFencedFsTargets();
    if (fenced.length > 0) {
      console.warn(
        '[ComposeArgvFence] Could not check the files of %s against a data restore; answering as unproven: %s',
        sanitizeForLog(fallback),
        sanitizeForLog((err as Error)?.message ?? String(err)),
      );
      throw new DataRestoreFenceError(fenced[0].hostPath, 'unproven', 'directory');
    }
    spellings = [path.resolve(fallback)];
    checked = new Set();
  }
  return {
    admit: () => {
      const lease = admitFsWork(spellings, checked);
      if (isDataRestoreFenceError(lease)) throw lease;
      return lease;
    },
  };
}

/** A Compose child process: its working directory, argv (starting `compose`), and the environment it gets. */
export interface ComposeProcessInput {
  cwd: string;
  args: readonly string[];
  /** The child's whole environment; omitted when it inherits this process's. */
  env?: Record<string, string | undefined>;
}

/**
 * Match one Compose process against the directory fences by the files it opens
 * (`composeSelectedInputPaths`: its `-f` files, or the COMPOSE_FILE selection
 * or discovered root and override when it names none, and its env sources),
 * whatever the caller asked before. Every spawn of `docker compose` for a
 * stack or a Git candidate admits through this (Sencho's self-update helper,
 * which runs Compose on Sencho's own project, does not) immediately before it
 * starts the child and holds the lease
 * until the child has exited, so a restore that fences one of those files
 * either refuses the process before it starts or waits for it to finish
 * (`waitForFsWorkOn`): a render, a pull, an `up` started after its own
 * earlier checks, all the same. `compose version` opens no project and is not
 * matched. Anything else that is not a Compose argv gets a lease that holds
 * nothing.
 */
export async function prepareComposeAdmission(input: ComposeProcessInput): Promise<FileWorkAdmission> {
  if (input.args[0] !== 'compose' || input.args[1] === 'version') return { admit: () => NO_FILE_WORK };
  const env = input.env;
  let paths: string[] = [];
  try {
    const { composeSelectedInputPaths } = await import('./composeExpansionGuard');
    paths = await composeSelectedInputPaths({
      cwd: input.cwd,
      invocation: input.args,
      ...(env ? { env: (name: string) => env[name] } : {}),
    });
  } catch (err) {
    // Unknown inputs: refused as unproven while a fence is held, and otherwise
    // registered by the working directory, so a fence recorded meanwhile waits.
    const { RestoreFenceStore } = await import('../services/recovery/restoreFence');
    const fenced = RestoreFenceStore.getInstance().liveFencedFsTargets();
    if (fenced.length > 0) {
      console.warn(
        '[ComposeArgvFence] Could not tell which files a Compose run in %s opens; answering as unproven: %s',
        sanitizeForLog(input.cwd),
        sanitizeForLog((err as Error)?.message ?? String(err)),
      );
      throw new DataRestoreFenceError(fenced[0].hostPath, 'unproven', 'directory');
    }
  }
  return prepareFileWorkAdmission(paths, input.cwd);
}

/** `prepareComposeAdmission` and its admission in one step, for a caller that holds the lease across several. */
export async function admitComposeProcess(input: ComposeProcessInput): Promise<FsWorkLeaseLike> {
  return (await prepareComposeAdmission(input)).admit();
}

/** Release `lease` once `child` has exited or failed to start. */
export function holdUntilExit(child: { once(event: 'close' | 'error', listener: () => void): unknown }, lease: FsWorkLeaseLike): void {
  child.once('close', () => lease.release());
  child.once('error', () => lease.release());
}

/**
 * Admit, then start the child in the same synchronous step, and hold the lease
 * until it exits. A spawn that throws (Node throws for a NUL byte in an
 * argument or the environment, or ENOMEM and E2BIG) releases the lease at
 * once, so it cannot stay registered and hold off every later restore.
 */
export function spawnUnderLease<C extends { once(event: 'close' | 'error', listener: () => void): unknown }>(
  admission: FileWorkAdmission,
  start: () => C,
): C {
  const lease = admission.admit();
  let child: C;
  try {
    child = start();
  } catch (err) {
    lease.release();
    throw err;
  }
  holdUntilExit(child, lease);
  return child;
}

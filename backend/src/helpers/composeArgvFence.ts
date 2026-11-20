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
 * Throw the fence's refusal when a file a mutating Compose argv names with
 * `-f` (resolved against `cwd`, the command's working directory), or a path a
 * link on the way to it names, sits in a directory a data restore is
 * overwriting; a file missing there may only be mid-swap, so it refuses too.
 *
 * ComposeService asks it on the argv it is about to spawn, so a layer it adds
 * after the caller's own ask (`FileSystemService.refuseIfComposeFenced`) is
 * still asked: the root file and override that a recovery, Mesh, Pilot,
 * digest-pin or bind-remap layer pins, and a captured invocation's file set.
 * Those generated layers are asked too; they live outside any stack directory,
 * so they refuse only when a restore really holds them. An argv with no `-f`
 * is left to the caller's ask. A check that cannot run while a fence is held
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

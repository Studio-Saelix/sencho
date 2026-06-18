import path from 'path';
import { promises as fsPromises } from 'fs';
import { DatabaseService } from '../services/DatabaseService';
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
export function authoredComposeFileArgs(stackName: string, nodeId?: number): string[] {
  const resolvedNodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
  const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec;
  if (!spec || spec.files.length === 0) return [];

  const baseDir = NodeRegistry.getInstance().getComposeDir(resolvedNodeId);
  const stackDir = path.resolve(baseDir, stackName);

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
 * Build the `--env-file <stackDir>/.env` flag a multi-file Git deploy needs when
 * the applied spec sets a context dir, or `[]` otherwise.
 *
 * When `authoredComposeFileArgs` emits `--project-directory <contextDir>`, Docker
 * Compose treats the context dir as the project directory and looks for `.env`
 * there, not at the stack root where Sencho writes it. `validateCompose` passes
 * the root `.env` explicitly with `--env-file` whenever the stack has env content,
 * so without the same flag at deploy/render/scan time a Git source could validate
 * with one effective config and deploy or render another. This flag makes every
 * compose invocation resolve env from the same root `.env` the validator used.
 *
 * Scoped to the context-dir case on purpose: with no `--project-directory`, the
 * project directory stays the stack dir (the compose command's cwd) and Compose
 * auto-discovers the root `.env`, so single-file / no-context stacks need no flag
 * and keep their existing behavior. An explicit `--env-file` to a missing file
 * errors, so the flag is only added when a root `.env` actually exists.
 */
export async function authoredComposeEnvFileArgs(stackName: string, nodeId?: number): Promise<string[]> {
  const resolvedNodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
  const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec;
  if (!spec || spec.files.length === 0 || !spec.contextDir) return [];

  // Inline js/path-injection barrier at the fs sink: resolve against a known-safe
  // base and assert containment with startsWith right here. CodeQL does not credit
  // the wrapped isPathWithinBase helper or a check separated from the sink, matching
  // the inline guards in renderConfig and validateCompose. `.env` is a fixed name.
  const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(resolvedNodeId));
  const stackDir = path.resolve(baseResolved, stackName);
  if (!stackDir.startsWith(baseResolved + path.sep)) return [];
  const envPath = path.resolve(stackDir, '.env');
  try {
    await fsPromises.access(envPath);
  } catch (err) {
    // A missing `.env` is the normal "nothing to pass" case. Any other error
    // (e.g. EACCES on an existing but unreadable `.env`) is a real fault: surface
    // it rather than silently dropping the flag and deploying a different effective
    // config than the one validated.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return ['--env-file', envPath];
}

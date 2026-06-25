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
 * Build `--env-file` arguments for the stack's configured project env files.
 *
 * When the stack has one or more project env files configured (via the
 * project-env-files API), each file is resolved against the stack directory,
 * validated for containment and file type, and emitted as a repeated
 * `--env-file <absPath>` flag. Configured files apply to ALL stack types
 * (single-file, multi-file Git, non-Git).
 *
 * When no project env files are configured, fall back to the legacy behavior:
 * pass `--env-file <stackDir>/.env` only for multi-file Git stacks whose
 * deploy spec sets a contextDir and whose root `.env` actually exists. This
 * preserves byte-identical behavior for existing stacks.
 */
export async function authoredComposeEnvFileArgs(stackName: string, nodeId?: number): Promise<string[]> {
  const resolvedNodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
  const db = DatabaseService.getInstance();
  const configuredFiles = db.getStackProjectEnvFiles(resolvedNodeId, stackName);

  if (configuredFiles.length > 0) {
    const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(resolvedNodeId));
    const stackDir = path.resolve(baseResolved, stackName);
    if (!stackDir.startsWith(baseResolved + path.sep)) return [];

    const args: string[] = [];
    for (const file of configuredFiles) {
      if (!file || !isValidRelativeStackPath(file)) {
        throw new Error(`Invalid project env file path for stack "${stackName}": "${file}"`);
      }
      // Reject paths with directory separators: project env files live at the
      // stack root, matching Compose's auto-discovery behavior.
      if (file.includes('/') || file.includes('\\')) {
        throw new Error(
          `Project env file "${file}" for stack "${stackName}" must be at the stack root. ` +
          `Update the project env file selection in the Environment tab.`
        );
      }
      const envPath = path.resolve(stackDir, file);
      if (!isPathWithinBase(envPath, stackDir)) {
        throw new Error(`Project env file path escapes stack directory for stack "${stackName}": "${file}"`);
      }
      // Verify the real path stays within the stack directory, defending against
      // symlinks that were created or swapped after configuration.
      let realEnvPath: string;
      try {
        realEnvPath = await fsPromises.realpath(envPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `Project env file "${file}" configured for stack "${stackName}" is missing. ` +
            `Restore the file or update the project env file selection in the Environment tab.`
          );
        }
        throw err;
      }
      if (!isPathWithinBase(realEnvPath, stackDir)) {
        throw new Error(
          `Project env file "${file}" for stack "${stackName}" resolves outside the stack directory. ` +
          `Update the project env file selection in the Environment tab.`
        );
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

  // Inline js/path-injection barrier at the fs sink: resolve against a known-safe
  // base and assert containment with startsWith right here. CodeQL does not credit
  // the wrapped isPathWithinBase helper or a check separated from the sink, matching
  // the inline guards in renderConfig and validateCompose.
  const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(resolvedNodeId));
  const stackDir = path.resolve(baseResolved, stackName);
  if (!stackDir.startsWith(baseResolved + path.sep)) return [];
  const envPath = path.resolve(stackDir, '.env');
  try {
    await fsPromises.access(envPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return ['--env-file', envPath];
}

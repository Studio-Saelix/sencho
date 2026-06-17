import path from 'path';
import { isValidGitSourcePath, isValidRelativeStackPath } from '../utils/validation';
import { PRIMARY_COMPOSE_FILENAME, gitSourceLocalComposeFiles } from '../utils/gitComposeFiles';

/** Upper bound on how many compose files one stack can order. Generous; real
 *  base+override layouts use a handful. */
export const MAX_COMPOSE_FILES = 10;
const MAX_COMPOSE_PATH_LENGTH = 1024;
const MAX_CONTEXT_DIR_LENGTH = 1024;

export interface ComposeSelection {
  composePaths: string[];
  contextDir: string | null;
}

type ParseResult =
  | { ok: true; value: ComposeSelection }
  | { ok: false; error: string };

/**
 * Validate and normalize the multi-file compose selection from a request body.
 * Accepts `compose_paths` (ordered array) or the legacy `compose_path` (single
 * string, mapped to a one-element array). Enforces the file-count cap, rejects
 * duplicates and a root `compose.yaml` collision (the primary is always
 * materialized there), and validates an optional `context_dir`.
 */
export function parseComposeSelection(body: unknown): ParseResult {
  const b = (body ?? {}) as Record<string, unknown>;

  let rawPaths: unknown = b.compose_paths;
  if (rawPaths === undefined && typeof b.compose_path === 'string') {
    rawPaths = [b.compose_path];
  }
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    return { ok: false, error: 'compose_paths must be a non-empty array of repository file paths' };
  }
  if (rawPaths.length > MAX_COMPOSE_FILES) {
    return { ok: false, error: `compose_paths cannot exceed ${MAX_COMPOSE_FILES} files` };
  }

  const composePaths: string[] = [];
  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: 'each compose path must be a non-empty string' };
    }
    const trimmed = raw.trim();
    if (trimmed.length > MAX_COMPOSE_PATH_LENGTH) {
      return { ok: false, error: 'a compose path is too long' };
    }
    if (!isValidGitSourcePath(trimmed)) {
      return { ok: false, error: `compose path must be a relative repository file path: ${trimmed}` };
    }
    composePaths.push(trimmed);
  }

  if (new Set(composePaths).size !== composePaths.length) {
    return { ok: false, error: 'compose_paths cannot contain duplicate entries' };
  }

  // Materialized local layout: the primary (index 0) is written to the root
  // compose.yaml, each additional file at its repo-relative path. Reject the
  // collisions that would make materialization fail at runtime (ENOTDIR / clobber):
  // an additional file equal to or nested under compose.yaml, and any file path
  // that is a directory ancestor of another selected file.
  const materialized = gitSourceLocalComposeFiles(composePaths);
  const label = (k: number) => (k === 0 ? PRIMARY_COMPOSE_FILENAME : composePaths[k]);
  for (let i = 0; i < materialized.length; i++) {
    for (let j = 0; j < materialized.length; j++) {
      if (i === j) continue;
      if (materialized[j] === materialized[i] || materialized[j].startsWith(materialized[i] + '/')) {
        return { ok: false, error: `compose file "${label(j)}" collides with "${label(i)}" once materialized to disk` };
      }
    }
  }

  let contextDir: string | null = null;
  const rawCtx = b.context_dir;
  if (rawCtx !== undefined && rawCtx !== null && rawCtx !== '') {
    if (typeof rawCtx !== 'string') {
      return { ok: false, error: 'context_dir must be a string' };
    }
    if (rawCtx.length > MAX_CONTEXT_DIR_LENGTH) {
      return { ok: false, error: 'context_dir is too long' };
    }
    const ctx = rawCtx.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (ctx !== '') {
      if (!isValidRelativeStackPath(ctx)) {
        return { ok: false, error: 'context_dir must be a relative path within the repository' };
      }
      if (ctx.split('/').some(seg => seg.toLowerCase() === '.git')) {
        return { ok: false, error: 'context_dir cannot target the .git directory' };
      }
      // The project dir is mkdir'd, so it cannot equal a compose file path or sit
      // beneath one (the primary compose.yaml and any override are files, not dirs).
      if (materialized.some(f => ctx === f || ctx.startsWith(f + '/'))) {
        return { ok: false, error: 'context_dir cannot match or be nested under a compose file path' };
      }
      contextDir = ctx;
    }
  }

  return { ok: true, value: { composePaths, contextDir } };
}

/**
 * Default the env path to a sibling `.env` of the primary compose file when env
 * sync is on and no explicit path is provided. Mirrors the prior single-file
 * behavior, keyed off the primary (compose_paths[0]).
 */
export function defaultEnvPath(primaryComposePath: string, explicit: unknown): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const dir = path.posix.dirname(primaryComposePath.replace(/\\/g, '/')) || '.';
  return path.posix.join(dir, '.env');
}

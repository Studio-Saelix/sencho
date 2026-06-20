/**
 * Name-only parsing of Compose interpolation and env-file keys, plus the shared
 * stderr parsers Compose Doctor and the deploy guard both use. Every function
 * here surfaces variable NAMES only; an env-file value is never returned or
 * retained, and the bounded reader never loads a whole large file into memory.
 */

import { promises as fsp } from 'fs';
import path from 'path';

/** A `${...}` reference found in authored compose source. */
export interface InterpolationRef {
  name: string;
  /** `${VAR:?e}` / `${VAR?e}`: Compose errors if unset (`:?` also if empty). */
  required: boolean;
  /** `${VAR:-d}` / `${VAR-d}`: a default makes the value optional. */
  hasDefault: boolean;
  /** `${VAR:+x}` / `${VAR+x}`: alternate value; an unset VAR is intentional. */
  alternate: boolean;
}

// ${VAR}, ${VAR:-d}, ${VAR-d}, ${VAR:?e}, ${VAR?e}, ${VAR:+x}, ${VAR+x}.
// The leading (?<!\$) skips Compose's `$${VAR}` escape (a literal, not a ref).
// Group 2 is the operator (':-','-',':?','?',':+','+') or undefined for a bare ref.
const INTERPOLATION_RE = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])[^}]*)?\}/g;

/**
 * Extract every distinct `${...}` reference from authored compose text, with its
 * operator semantics. Operates on raw text (no YAML/value construction), so it
 * never materializes an env value.
 */
export function parseInterpolationRefs(source: string): InterpolationRef[] {
  const byName = new Map<string, InterpolationRef>();
  for (const m of source.matchAll(INTERPOLATION_RE)) {
    const name = m[1];
    const op = m[2];
    const required = op === ':?' || op === '?';
    const hasDefault = op === ':-' || op === '-';
    const alternate = op === ':+' || op === '+';
    const existing = byName.get(name);
    if (existing) {
      existing.required ||= required;
      existing.hasDefault ||= hasDefault;
      existing.alternate ||= alternate;
    } else {
      byName.set(name, { name, required, hasDefault, alternate });
    }
  }
  return [...byName.values()];
}

/**
 * Pull the KEY name from a single env-file line, or null for a blank/comment line.
 * Handles `KEY=value`, `export KEY=value`, and a bare `KEY` (value sourced from the
 * shell). The value after `=` is never read or returned.
 */
export function extractEnvKeyFromLine(line: string): string | null {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('export ')) s = s.slice('export '.length).trim();
  const eq = s.indexOf('=');
  const key = (eq === -1 ? s : s.slice(0, eq)).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : null;
}

export interface EnvKeyReadLimits {
  maxBytes: number;
  maxLines: number;
  maxLineLen: number;
}

export const DEFAULT_ENV_KEY_LIMITS: EnvKeyReadLimits = {
  maxBytes: 256 * 1024,
  maxLines: 5000,
  maxLineLen: 8192,
};

export interface EnvKeyReadResult {
  /** Distinct key names, in first-seen order. Never includes a value. */
  keys: string[];
  /** True when the file exceeded a limit and was only partially read. */
  truncated: boolean;
  /** True when the path escaped the base or the file could not be read/statted. */
  unverifiable: boolean;
}

/**
 * Read env-file KEY names from a file under `baseDir`, bounded by `limits`. The
 * path containment barrier is inlined at the read sink (CodeQL does not credit a
 * wrapped helper), and the read is capped so a large or adversarial file cannot
 * exhaust heap. Values are never materialized: only the slice before the first
 * `=` of each line is kept.
 */
export async function readEnvFileKeys(
  filePath: string,
  baseDir: string,
  limits: EnvKeyReadLimits = DEFAULT_ENV_KEY_LIMITS,
): Promise<EnvKeyReadResult> {
  const resolved = path.resolve(filePath);
  const baseResolved = path.resolve(baseDir);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    return { keys: [], truncated: false, unverifiable: true };
  }

  let handle: fsp.FileHandle | undefined;
  try {
    // Open first, then fstat the open handle (not the path), so there is no
    // check-then-use window between a path stat and the open.
    handle = await fsp.open(resolved, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { keys: [], truncated: false, unverifiable: true };
    const truncated = stat.size > limits.maxBytes;
    const len = Math.min(stat.size, limits.maxBytes);
    const buf = Buffer.alloc(len);
    if (len > 0) await handle.read(buf, 0, len, 0);

    const seen = new Set<string>();
    const keys: string[] = [];
    const lines = buf.toString('utf-8').split(/\r?\n/);
    const lineBudget = Math.min(lines.length, limits.maxLines);
    for (let i = 0; i < lineBudget; i++) {
      const line = lines[i];
      if (line.length > limits.maxLineLen) continue;
      const key = extractEnvKeyFromLine(line);
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
    return { keys, truncated: truncated || lines.length > limits.maxLines, unverifiable: false };
  } catch {
    return { keys: [], truncated: false, unverifiable: true };
  } finally {
    await handle?.close();
  }
}

/** Collect the deduplicated capture-group-1 matches of a global regex over stderr. */
function collectNames(stderr: string, re: RegExp): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) names.add(m[1]);
  return [...names];
}

/**
 * Pull the names of variables Compose reported as unset from its stderr.
 * Compose prints this in logfmt (`msg="The \"VAR\" variable is not set..."`),
 * so the name is wrapped in an escaped quote; the pattern tolerates the
 * escaped, plain-quoted, and unquoted forms across Compose versions.
 */
export function parseUnsetEnvVars(stderr: string): string[] {
  return collectNames(stderr, /([A-Za-z_][A-Za-z0-9_]*)\\?"?\s+variable is not set/gi);
}

/** Names of required (${VAR:?...}) variables Compose reported as missing. Names only, never values. */
export function parseMissingRequiredVars(stderr: string): string[] {
  return collectNames(stderr, /required variable\s+\\?"?([A-Za-z_][A-Za-z0-9_]*)\\?"?\s+is missing/gi);
}

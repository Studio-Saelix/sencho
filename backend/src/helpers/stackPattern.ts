/**
 * Canonical stack-name glob matching and write-boundary validation.
 *
 * Glob only: `*` is the sole wildcard; `?` and regex metacharacters are literal.
 * Matching is case-sensitive and anchored. Matching never uses RegExp so
 * accepted patterns cannot trigger catastrophic backtracking.
 *
 * Write-time caps still reject extreme patterns (length, star count, runs of
 * consecutive stars). Invalid patterns fail closed at match time (no match).
 */

export function validateStackPatternForRedos(pattern: string): string | null {
  if (pattern.length > 200) return 'stack_pattern is too long';
  const stars = (pattern.match(/\*/g) ?? []).length;
  if (stars > 8) return 'stack_pattern has too many wildcards (max 8)';
  if (/\*{4,}/.test(pattern)) return 'stack_pattern must not contain 4+ consecutive wildcards';
  return null;
}

export function cleanStackPatterns(patterns: string[]): string[] {
  return [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
}

export type ParseStackPatternsResult =
  | { ok: true; patterns: string[] }
  | { ok: false; error: string };

/** Validate a present `stack_patterns` value. Callers must not invoke this for omitted keys. */
export function parseStackPatternsInput(raw: unknown): ParseStackPatternsResult {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'stack_patterns must be an array of strings' };
  }
  if (raw.some((p) => typeof p !== 'string')) {
    return { ok: false, error: 'stack_patterns must be an array of strings' };
  }
  const patterns = cleanStackPatterns(raw as string[]);
  for (const pattern of patterns) {
    const err = validateStackPatternForRedos(pattern);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, patterns };
}

/**
 * Bounded glob match: work is linear in name length times star count (no RegExp).
 * `*` matches any substring including empty; all other characters are literal.
 */
function globMatchBounded(name: string, pattern: string): boolean {
  let ni = 0;
  let pi = 0;
  let starP = -1;
  let starN = -1;
  const nLen = name.length;
  const pLen = pattern.length;

  while (ni < nLen) {
    if (pi < pLen && pattern[pi] !== '*' && pattern[pi] === name[ni]) {
      ni += 1;
      pi += 1;
      continue;
    }
    if (pi < pLen && pattern[pi] === '*') {
      starP = pi;
      starN = ni;
      pi += 1;
      continue;
    }
    if (starP !== -1) {
      pi = starP + 1;
      starN += 1;
      ni = starN;
      continue;
    }
    return false;
  }

  while (pi < pLen && pattern[pi] === '*') pi += 1;
  return pi === pLen;
}

/**
 * True when `name` matches the stack glob. Patterns rejected by write-time
 * caps return false without throwing so dispatch and policy evaluation stay safe.
 */
export function stackPatternMatches(name: string, pattern: string): boolean {
  if (validateStackPatternForRedos(pattern) !== null) return false;
  return globMatchBounded(name, pattern);
}

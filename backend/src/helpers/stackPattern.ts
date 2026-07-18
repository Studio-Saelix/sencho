/**
 * Canonical stack-name glob matching and write-boundary validation.
 *
 * Glob only: `*` is the sole wildcard; `?` and regex metacharacters are literal.
 * Matching is case-sensitive and anchored. Patterns that fail ReDoS caps never
 * construct a RegExp (fail closed at match time).
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
 * True when `name` matches the stack glob. Invalid / ReDoS-prone patterns
 * return false without throwing so dispatch and policy evaluation stay safe.
 */
export function stackPatternMatches(name: string, pattern: string): boolean {
  if (validateStackPatternForRedos(pattern) !== null) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

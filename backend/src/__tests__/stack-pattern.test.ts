import { describe, it, expect } from 'vitest';
import {
  stackPatternMatches,
  validateStackPatternForRedos,
  parseStackPatternsInput,
  cleanStackPatterns,
} from '../helpers/stackPattern';

describe('stackPattern', () => {
  it('matches exact names without wildcards', () => {
    expect(stackPatternMatches('prod-api', 'prod-api')).toBe(true);
    expect(stackPatternMatches('Prod-api', 'prod-api')).toBe(false);
  });

  it('matches anchored case-sensitive globs', () => {
    expect(stackPatternMatches('prod-api', 'prod-*')).toBe(true);
    expect(stackPatternMatches('staging-api', 'prod-*')).toBe(false);
    expect(stackPatternMatches('prod-api-extra', 'prod-*')).toBe(true);
    expect(stackPatternMatches('xprod-api', 'prod-*')).toBe(false);
  });

  it('treats ? and regex metacharacters as literal', () => {
    expect(stackPatternMatches('a?b', 'a?b')).toBe(true);
    expect(stackPatternMatches('ab', 'a?b')).toBe(false);
    expect(stackPatternMatches('a.b', 'a.b')).toBe(true);
    expect(stackPatternMatches('axb', 'a.b')).toBe(false);
    expect(stackPatternMatches('a+b', 'a+b')).toBe(true);
  });

  it('fails closed on ReDoS-prone stored patterns without throwing', () => {
    expect(() => stackPatternMatches('anything', '****')).not.toThrow();
    expect(stackPatternMatches('anything', '****')).toBe(false);
    expect(stackPatternMatches('x', 'a'.repeat(201))).toBe(false);
    expect(stackPatternMatches('x', `${'a*'.repeat(9)}`)).toBe(false);
  });

  it('OR semantics are call-site: any pattern may match', () => {
    const patterns = ['staging-*', 'prod-api'];
    expect(patterns.some((p) => stackPatternMatches('prod-api', p))).toBe(true);
    expect(patterns.some((p) => stackPatternMatches('staging-web', p))).toBe(true);
    expect(patterns.some((p) => stackPatternMatches('dev-web', p))).toBe(false);
  });

  it('validateStackPatternForRedos rejects unsafe inputs', () => {
    expect(validateStackPatternForRedos('ok-*')).toBeNull();
    expect(validateStackPatternForRedos('****')).toMatch(/consecutive/);
    expect(validateStackPatternForRedos('a'.repeat(201))).toMatch(/too long/);
  });

  it('parseStackPatternsInput rejects non-arrays and non-strings', () => {
    expect(parseStackPatternsInput(null).ok).toBe(false);
    expect(parseStackPatternsInput('prod-*').ok).toBe(false);
    expect(parseStackPatternsInput([1]).ok).toBe(false);
    expect(parseStackPatternsInput(['prod-*', '****']).ok).toBe(false);
    expect(parseStackPatternsInput([' prod-* ', 'prod-*'])).toEqual({
      ok: true,
      patterns: ['prod-*'],
    });
  });

  it('cleanStackPatterns trims, drops blanks, dedupes', () => {
    expect(cleanStackPatterns([' a ', '', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

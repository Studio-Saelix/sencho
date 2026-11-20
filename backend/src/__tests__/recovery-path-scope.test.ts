/**
 * A path restore's scope comes from the caller, so canonicalizing it must stay
 * linear in its length: a long run of slashes is cut by a scan, not by a
 * backtracking regex.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizePathScope } from '../services/recovery/recoveryPoints';

describe('canonicalizePathScope', () => {
  it('keeps a relative scope and drops trailing and doubled slashes', () => {
    expect(canonicalizePathScope('data')).toBe('data');
    expect(canonicalizePathScope('data/')).toBe('data');
    expect(canonicalizePathScope('data//sub///')).toBe('data/sub');
    expect(canonicalizePathScope('./data/./sub/')).toBe('data/sub');
  });

  it('refuses a scope that is empty, absolute, climbs out, or names only the root', () => {
    for (const raw of ['', '/data', '../data', 'data/../..', 'a\0b', '.', './', './/']) {
      expect(() => canonicalizePathScope(raw), JSON.stringify(raw)).toThrow();
    }
  });

  it('answers a scope made of long slash runs in linear time', () => {
    const raw = `a${'/'.repeat(200_000)}b${'/'.repeat(200_000)}`;
    const started = Date.now();
    expect(canonicalizePathScope(raw)).toBe('a/b');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

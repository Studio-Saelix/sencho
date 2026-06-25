/**
 * Unit tests for the bulk selection helpers (normalizeBulkPaths,
 * destWithinAnySource) used by the bulk delete/move/download routes.
 */
import { describe, it, expect } from 'vitest';
import { normalizeBulkPaths, destWithinAnySource } from '../utils/bulkPaths';

describe('normalizeBulkPaths', () => {
  it('dedupes exact duplicates', () => {
    expect(normalizeBulkPaths(['a.txt', 'a.txt', 'b.txt'], true)).toEqual(['a.txt', 'b.txt']);
  });

  it('drops a path whose ancestor is also selected', () => {
    expect(normalizeBulkPaths(['dir', 'dir/child.txt'], true)).toEqual(['dir']);
    expect(normalizeBulkPaths(['dir', 'dir/sub/deep.txt'], true)).toEqual(['dir']);
  });

  it('keeps siblings and unrelated paths', () => {
    expect(normalizeBulkPaths(['a/x', 'a/y', 'b'], true)).toEqual(['a/x', 'a/y', 'b']);
  });

  it('does not treat a name-prefix sibling as a descendant', () => {
    // "dir2" is not inside "dir" even though it shares the prefix.
    expect(normalizeBulkPaths(['dir', 'dir2/file'], true)).toEqual(['dir', 'dir2/file']);
  });

  it('preserves the first-seen order', () => {
    expect(normalizeBulkPaths(['z', 'a', 'm'], true)).toEqual(['z', 'a', 'm']);
  });

  describe('case sensitivity', () => {
    it('collapses Foo and foo on a case-insensitive root', () => {
      expect(normalizeBulkPaths(['Foo', 'foo'], false)).toEqual(['Foo']);
    });

    it('keeps both Foo and foo on a case-sensitive root (Linux / helper volumes)', () => {
      expect(normalizeBulkPaths(['Foo', 'foo'], true)).toEqual(['Foo', 'foo']);
    });

    it('drops a case-differing descendant only when case-insensitive', () => {
      expect(normalizeBulkPaths(['Foo', 'foo/bar'], false)).toEqual(['Foo']);
      expect(normalizeBulkPaths(['Foo', 'foo/bar'], true)).toEqual(['Foo', 'foo/bar']);
    });
  });
});

describe('destWithinAnySource', () => {
  it('flags a destination equal to a selected source', () => {
    expect(destWithinAnySource('dir', ['dir'], true)).toBe(true);
  });

  it('flags a destination inside a selected source', () => {
    expect(destWithinAnySource('dir/sub', ['dir'], true)).toBe(true);
  });

  it('allows a destination outside every source', () => {
    expect(destWithinAnySource('other', ['dir'], true)).toBe(false);
    expect(destWithinAnySource('', ['dir'], true)).toBe(false);
  });

  it('is case-aware', () => {
    expect(destWithinAnySource('DIR/sub', ['dir'], false)).toBe(true);
    expect(destWithinAnySource('DIR/sub', ['dir'], true)).toBe(false);
  });

  it('does not flag a name-prefix sibling destination', () => {
    expect(destWithinAnySource('dir2', ['dir'], true)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { formatBytes } from '../utils';

describe('formatBytes', () => {
  it.each([
    ['zero', 0, '0 B'],
    ['a few bytes', 512, '512 B'],
    ['a kilobyte', 1024, '1 KB'],
    ['a fractional megabyte', 1.5 * 1024 ** 2, '1.5 MB'],
    ['a terabyte', 2 * 1024 ** 4, '2 TB'],
    ['a petabyte', 3 * 1024 ** 5, '3 PB'],
    ['the largest unit', 1024 ** 8, '1 YB'],
  ])('formats %s', (_label, bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('keeps a value under one byte in bytes instead of indexing below the table', () => {
    expect(formatBytes(0.5)).toBe('0.5 B');
    expect(formatBytes(0.26, 1)).toBe('0.3 B');
    expect(formatBytes(0.001)).toBe('0 B');
  });

  it('keeps a value past the largest unit in that unit instead of indexing past the table', () => {
    expect(formatBytes(2048 * 1024 ** 8)).toBe('2048 YB');
  });

  it('honours the requested decimals', () => {
    expect(formatBytes(1536, 1)).toBe('1.5 KB');
    expect(formatBytes(1100, 0)).toBe('1 KB');
  });

  it.each([
    ['a negative value', -2048],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('reads %s as zero rather than rendering NaN or undefined', (_label, bytes) => {
    expect(formatBytes(bytes)).toBe('0 B');
  });
});

import { describe, it, expect } from 'vitest';
import { sourcesPresent, matchesSearch, type LabelSource } from '@/lib/labelInventory';

describe('sourcesPresent', () => {
  it('returns distinct sources in the fixed display order regardless of input order', () => {
    const input: LabelSource[] = ['runtime', 'unknown', 'compose', 'image', 'compose-system'];
    expect(sourcesPresent(input)).toEqual(['compose', 'image', 'runtime', 'compose-system', 'unknown']);
  });

  it('de-duplicates and omits sources not present', () => {
    expect(sourcesPresent(['runtime', 'runtime', 'image'])).toEqual(['image', 'runtime']);
    expect(sourcesPresent([])).toEqual([]);
  });
});

describe('matchesSearch', () => {
  it('matches when any part contains the (case-insensitive) query', () => {
    expect(matchesSearch('WATCH', 'com.centurylinklabs.watchtower.enable')).toBe(true);
    expect(matchesSearch('nope', 'traefik.enable', 'true')).toBe(false);
  });

  it('treats an empty or whitespace query as matching everything', () => {
    expect(matchesSearch('', 'anything')).toBe(true);
    expect(matchesSearch('   ', null)).toBe(true);
  });

  it('trims the query and tolerates null/undefined parts', () => {
    expect(matchesSearch('  enable  ', 'traefik.enable')).toBe(true);
    expect(matchesSearch('x', null, undefined)).toBe(false);
  });
});

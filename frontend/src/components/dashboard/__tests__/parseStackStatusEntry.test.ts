import { describe, expect, it } from 'vitest';
import { parseStackStatusEntry, parseStackStatusesMap, sanitizeNetworks } from '../parseStackStatusEntry';

describe('sanitizeNetworks', () => {
  it('returns undefined for non-arrays and empty results', () => {
    expect(sanitizeNetworks(undefined)).toBeUndefined();
    expect(sanitizeNetworks('arr_default')).toBeUndefined();
    expect(sanitizeNetworks([])).toBeUndefined();
    expect(sanitizeNetworks(['', 1, null])).toBeUndefined();
  });

  it('dedupes and sorts non-empty strings', () => {
    expect(sanitizeNetworks(['zebra', 'arr_default', 'arr_default', 'bridge']))
      .toEqual(['arr_default', 'bridge', 'zebra']);
  });
});

describe('parseStackStatusEntry', () => {
  it('keeps a valid status when networks is malformed', () => {
    const parsed = parseStackStatusEntry({ status: 'running', networks: 'nope' });
    expect(parsed).toEqual({ status: 'running' });
  });

  it('attaches sanitized networks beside canonical status', () => {
    expect(parseStackStatusEntry({
      status: 'partial',
      networks: ['b', 'a', 'a', ''],
    })).toEqual({ status: 'partial', networks: ['a', 'b'] });
  });

  it('rejects entries without a canonical status', () => {
    expect(parseStackStatusEntry({ networks: ['a'] })).toBeNull();
    expect(parseStackStatusEntry(null)).toBeNull();
  });
});

describe('parseStackStatusesMap', () => {
  it('treats a confirmed-empty object as ok', () => {
    expect(parseStackStatusesMap({})).toEqual({ kind: 'ok', entries: {} });
  });

  it('keeps valid rows when one optional networks value is malformed', () => {
    expect(parseStackStatusesMap({
      'web.yml': { status: 'running', networks: 1 },
      'api.yml': { status: 'exited', networks: ['b', 'a'] },
    })).toEqual({
      kind: 'ok',
      entries: {
        'web.yml': { status: 'running' },
        'api.yml': { status: 'exited', networks: ['a', 'b'] },
      },
    });
  });

  it('rejects a non-empty map where every entry is malformed', () => {
    expect(parseStackStatusesMap({ 'broken.yml': null })).toEqual({ kind: 'invalid' });
  });
});

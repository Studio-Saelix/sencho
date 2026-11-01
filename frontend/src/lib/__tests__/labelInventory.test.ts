import { describe, it, expect } from 'vitest';
import { sourcesPresent, matchesSearch, readLabelBehavior, type LabelSource } from '@/lib/labelInventory';

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

describe('readLabelBehavior', () => {
  it('names the origin when it drops a claim about a copy Sencho does not act on', () => {
    expect(readLabelBehavior('runtime', 'io.sencho.url', { state: 'active' })).toEqual({
      state: 'inert',
      reason: 'Present only on the running container, so Sencho does not act on it. Declare it in the Compose file instead.',
    });
    expect(readLabelBehavior('image', 'io.sencho.order', { state: 'active' })?.reason)
      .toBe('Set by the image, so Sencho does not act on it. Declare it in the Compose file instead.');
    for (const source of ['unknown', 'compose-system'] as const) {
      expect(readLabelBehavior(source, 'io.sencho.order', { state: 'invalid' })?.reason)
        .toBe('Its origin is unknown, so Sencho does not act on it.');
    }
  });

  it('keeps a node\'s own reason when the node already reports inert', () => {
    expect(readLabelBehavior('runtime', 'io.sencho.url', { state: 'inert', reason: 'Recreate the container to apply it.' }))
      .toEqual({ state: 'inert', reason: 'Recreate the container to apply it.' });
  });

  it('never accepts a behavior outside the namespace, and reserves the keys Sencho sets', () => {
    expect(readLabelBehavior('compose', 'traefik.enable', { state: 'active' })).toBeUndefined();
    expect(readLabelBehavior('compose', 'io.sencho.mesh', { state: 'active' })).toEqual({
      state: 'invalid',
      reason: 'Reserved for containers Sencho creates; it has no effect in a Compose file.',
    });
    expect(readLabelBehavior('runtime', 'io.sencho.helper', { state: 'active' })).toEqual({
      state: 'inert',
      reason: 'Set by Sencho on a container it manages.',
    });
  });

  it('keeps a deployed copy of the protective label, and nothing else from a container', () => {
    expect(readLabelBehavior('runtime', 'io.sencho.infrastructure', { state: 'active', reason: 'It protects this container.' }))
      .toEqual({ state: 'active', reason: 'It protects this container.' });
    expect(readLabelBehavior('runtime', 'io.sencho.hidden', { state: 'active' })?.state).toBe('inert');
  });
});

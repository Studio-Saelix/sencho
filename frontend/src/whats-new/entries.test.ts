import { describe, it, expect } from 'vitest';
import rawEntries from './entries.json';
import { isWhatsNewEntry, WHATS_NEW_CAP } from './types';

describe('whats-new entries.json', () => {
  it('is an array', () => {
    expect(Array.isArray(rawEntries)).toBe(true);
  });

  it('contains only valid entries', () => {
    for (const entry of rawEntries) {
      expect(isWhatsNewEntry(entry)).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = rawEntries.map((e) => (e as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(`does not exceed the ${WHATS_NEW_CAP}-entry cap`, () => {
    expect(rawEntries.length).toBeLessThanOrEqual(WHATS_NEW_CAP);
  });
});

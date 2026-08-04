import { describe, it, expect } from 'vitest';
import rawEntries from './entries.json';
import { isWhatsNewEntry, WHATS_NEW_CAP } from './types';

// These are authoring guards on the committed data, not tests of behaviour:
// they fail the build when a hand-written entry is malformed, duplicated, or
// pushes the file past the cap. The loader's own behaviour is covered in
// loader.test.ts. While entries.json is still empty they pass trivially, which
// is expected; they start biting as soon as the first entry lands.
describe('whats-new entries.json', () => {
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

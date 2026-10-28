import { describe, it, expect } from 'vitest';
import rawEntries from './entries.json';
import { isWhatsNewEntry, WHATS_NEW_CAP } from './types';

// These are authoring guards on the committed data, not tests of behaviour:
// they fail the build when a hand-written entry is malformed, duplicated, or
// pushes the file past the cap. The loader's own behaviour is covered in
// loader.test.ts.
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

  it('is not empty, because the icon and its Settings toggle hide on an empty feed', () => {
    expect(rawEntries.length).toBeGreaterThan(0);
  });

  // The feed is replaced wholesale every release, so every id carries one
  // release prefix (v<major>-<minor>-). A leftover entry from the previous
  // release fails here. Bump the prefix with each release so the new last id
  // can never equal a lastSeenId a user has already stored.
  it('belongs to a single release, with every id prefixed v<major>-<minor>-', () => {
    const ids = rawEntries.map((e) => (e as { id: string }).id);
    for (const id of ids) {
      expect(id).toMatch(/^v\d+-\d+-[a-z0-9-]+$/);
    }
    const prefixes = new Set(ids.map((id) => /^(v\d+-\d+)-/.exec(id)?.[1]));
    expect([...prefixes]).toHaveLength(1);
  });

  it(`does not exceed the ${WHATS_NEW_CAP}-entry cap`, () => {
    expect(rawEntries.length).toBeLessThanOrEqual(WHATS_NEW_CAP);
  });
});

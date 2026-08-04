import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// entries.ts reads entries.json at module load, so each case has to mock the
// JSON and re-import the module rather than calling a function.
async function loadWith(raw: unknown) {
  vi.resetModules();
  vi.doMock('./entries.json', () => ({ default: raw }));
  return import('./entries');
}

describe('whats-new entries loader', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock('./entries.json');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('treats the last entry as the newest, which is the contract the watermark relies on', async () => {
    const { whatsNewEntries, latestWhatsNewEntryId } = await loadWith([
      { id: 'oldest', title: 'Oldest', blurb: 'First shipped.' },
      { id: 'newest', title: 'Newest', blurb: 'Shipped most recently.' },
    ]);
    expect(whatsNewEntries.map((e) => e.id)).toEqual(['oldest', 'newest']);
    expect(latestWhatsNewEntryId).toBe('newest');
  });

  it('drops malformed entries but keeps the valid ones', async () => {
    const { whatsNewEntries, latestWhatsNewEntryId } = await loadWith([
      { id: 'good-1', title: 'Good', blurb: 'Valid.' },
      { id: 'missing-blurb', title: 'Bad' },
      { title: 'No id', blurb: 'Bad.' },
      null,
      'not an object',
      { id: 'good-2', title: 'Also good', blurb: 'Valid.' },
    ]);
    expect(whatsNewEntries.map((e) => e.id)).toEqual(['good-1', 'good-2']);
    expect(latestWhatsNewEntryId).toBe('good-2');
  });

  it('yields no entries and a null latest id for an empty file', async () => {
    const { whatsNewEntries, latestWhatsNewEntryId } = await loadWith([]);
    expect(whatsNewEntries).toEqual([]);
    expect(latestWhatsNewEntryId).toBeNull();
  });

  it('keeps the optional docUrl and screenshot fields when present', async () => {
    const { whatsNewEntries } = await loadWith([
      {
        id: 'full',
        title: 'Full entry',
        blurb: 'Has both optional fields.',
        docUrl: 'https://docs.sencho.io/features/full',
        screenshot: 'full.png',
      },
    ]);
    expect(whatsNewEntries[0]).toMatchObject({
      docUrl: 'https://docs.sencho.io/features/full',
      screenshot: 'full.png',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { alsoPulledLine, alsoPulledServices, serviceUpdateNotes, skipLabelLine } from '../updateServiceNotes';

const digest = `sha256:${'b'.repeat(64)}`;

function image(over: Record<string, unknown>) {
  return {
    service: 'web', current_tag: '1.0.0', next_tag: null, has_update: true,
    digest_update: false, tag_update: false, ...over,
  };
}

describe('serviceUpdateNotes', () => {
  it('offers the newer tag for a tag update and the registry digest for a rebuild', () => {
    expect(serviceUpdateNotes([image({ tag_update: true, next_tag: '1.1.0' })])[0].skipEntries).toEqual(['1.1.0']);
    expect(serviceUpdateNotes([image({ digest_update: true, next_tag: '1.0.0', candidate_digest: digest })])[0].skipEntries)
      .toEqual([digest]);
  });

  it('offers both when both are pending, so one copied line skips everything then pending', () => {
    const notes = serviceUpdateNotes([image({ tag_update: true, digest_update: true, next_tag: '1.1.0', candidate_digest: digest })]);
    expect(notes[0].skipEntries).toEqual(['1.1.0', digest]);
    expect(skipLabelLine(notes[0].skipEntries)).toBe(`io.sencho.update.ignore: "1.1.0,${digest}"`);
  });

  it('offers no skip when the candidate is unknown', () => {
    expect(serviceUpdateNotes([image({ digest_update: true, next_tag: '1.0.0', candidate_digest: null })])[0].skipEntries).toEqual([]);
    expect(serviceUpdateNotes([image({ digest_update: true, candidate_digest: 'sha256:short' })])[0].skipEntries).toEqual([]);
  });

  it('keeps entries already saved in the label and adds the new candidate', () => {
    const notes = serviceUpdateNotes([
      image({ tag_update: true, next_tag: '1.1.0', ignore_entries: [digest], candidate_digest: digest }),
    ]);
    expect(notes[0].skipEntries).toEqual([digest, '1.1.0']);
    expect(notes[0].skipLimitReached).toBe(false);
    expect(skipLabelLine(notes[0].skipEntries)).toBe(`io.sencho.update.ignore: "${digest},1.1.0"`);
  });

  it('does not duplicate a candidate already saved in the label', () => {
    const notes = serviceUpdateNotes([
      image({ digest_update: true, candidate_digest: digest, ignore_entries: [digest] }),
    ]);
    expect(notes[0].skipEntries).toEqual([digest]);
  });

  it('offers no invalid line when the saved entries plus the new one exceed the limit', () => {
    const ignored = Array.from({ length: 8 }, (_, i) => `1.0.${i}`);
    const notes = serviceUpdateNotes([image({ tag_update: true, next_tag: '2.0.0', ignore_entries: ignored })]);
    expect(notes[0].skipEntries).toEqual([]);
    expect(notes[0].skipLimitReached).toBe(true);
  });

  it('keeps the full-label state when another image of the same service has a saved candidate', () => {
    const saved = [...Array.from({ length: 7 }, (_, i) => `1.0.${i}`), '2.0.0'];
    const notes = serviceUpdateNotes([
      image({ service: 'web', tag_update: true, next_tag: '3.0.0', ignore_entries: saved }),
      image({ service: 'web', image: 'web:2', tag_update: true, next_tag: '2.0.0', ignore_entries: saved }),
    ]);
    expect(notes[0].skipEntries).toEqual([]);
    expect(notes[0].skipLimitReached).toBe(true);
  });

  it('keeps only a safe http(s) changelog link and ignores services without an update', () => {
    const notes = serviceUpdateNotes([
      image({ tag_update: true, next_tag: '1.1.0', changelog_url: 'javascript:alert(1)' }),
      image({ service: 'db', has_update: false, changelog_url: 'https://example.com/db' }),
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0].changelogUrl).toBeNull();
    expect(serviceUpdateNotes([image({ tag_update: true, next_tag: '1.1.0', changelog_url: 'https://example.com/web' })])[0].changelogUrl)
      .toBe('https://example.com/web');
  });
});

describe('alsoPulledServices', () => {
  const images = [
    { service: 'app', detection: undefined },
    { service: 'web', detection: 'ignored' as const },
    { service: 'db', detection: 'off' as const },
  ];

  it('names the skipped and unchecked services an update also pulls', () => {
    const services = alsoPulledServices({ images, summary: { has_update: true } });
    expect(alsoPulledLine(services)).toBe('Applying also pulls: web (update skipped), db (not checked)');
  });

  it('says nothing when there is no update or rebuild to apply', () => {
    expect(alsoPulledServices({ images, summary: { has_update: false } })).toEqual([]);
    expect(alsoPulledLine([])).toBeNull();
  });

  it('names the pull for a rebuild-only apply', () => {
    const services = alsoPulledServices({
      images, summary: { has_update: false, rebuild_available: true },
    });
    expect(alsoPulledLine(services)).toBe('Applying also pulls: web (update skipped), db (not checked)');
  });

  it('never names a build-backed service, which Compose builds instead of pulling', () => {
    const services = alsoPulledServices({
      images,
      summary: { has_update: true },
      build_services: ['web'],
    });
    expect(alsoPulledLine(services)).toBe('Applying also pulls: db (not checked)');
  });
});

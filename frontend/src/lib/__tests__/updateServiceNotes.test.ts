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

  it('says nothing when there is no update to apply', () => {
    expect(alsoPulledServices({ images, summary: { has_update: false } })).toEqual([]);
    expect(alsoPulledLine([])).toBeNull();
  });
});

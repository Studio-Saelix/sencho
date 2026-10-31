import { describe, expect, it } from 'vitest';
import type { BuildInfo } from '@/context/BuildInfoProvider';
import { extractHighlights, stableReleaseVersion } from '../releaseHighlights';

const BODY = [
  '## [0.99.0](https://example.test/compare) (2026-11-02)',
  '',
  '### Highlights',
  '',
  '<!-- highlights-hash: 0123456789abcdef -->',
  '',
  'Cordon is here.',
  '',
  'Health gates retry.',
  '',
  '### Added',
  '',
  '* **fleet:** add node cordon',
].join('\n');

describe('extractHighlights', () => {
  it('returns the paragraphs without the hash comment or later sections', () => {
    expect(extractHighlights(BODY)).toBe('Cordon is here.\n\nHealth gates retry.');
  });

  it('handles CRLF bodies', () => {
    expect(extractHighlights(BODY.replace(/\n/g, '\r\n'))).toBe('Cordon is here.\n\nHealth gates retry.');
  });

  it('returns null when there is no block, an empty block, or no body', () => {
    expect(extractHighlights('### Added\n\n* a fix')).toBeNull();
    expect(extractHighlights('### Highlights\n\n<!-- highlights-hash: 0123456789abcdef -->\n\n### Added')).toBeNull();
    expect(extractHighlights('')).toBeNull();
    expect(extractHighlights(null)).toBeNull();
  });

  it('reads a block that runs to the end of the body', () => {
    expect(extractHighlights('### Highlights\n\nOnly this.')).toBe('Only this.');
  });
});

describe('stableReleaseVersion', () => {
  const info = (over: Partial<BuildInfo>): BuildInfo => ({
    version: '0.98.1',
    channel: 'stable',
    imageChannel: 'community',
    imageRef: null,
    imageId: null,
    revision: null,
    restricted: false,
    ...over,
  });

  it('returns the version for a stable release', () => {
    expect(stableReleaseVersion(info({}))).toBe('0.98.1');
  });

  it('returns null for dev and preview builds, unknown versions, and no build info', () => {
    expect(stableReleaseVersion(info({ channel: 'dev' }))).toBeNull();
    expect(stableReleaseVersion(info({ channel: 'preview' }))).toBeNull();
    expect(stableReleaseVersion(info({ version: null }))).toBeNull();
    expect(stableReleaseVersion(info({ version: '0.98.1-rc.1' }))).toBeNull();
    expect(stableReleaseVersion(null)).toBeNull();
  });
});

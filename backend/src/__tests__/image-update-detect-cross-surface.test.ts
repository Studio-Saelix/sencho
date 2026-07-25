import { describe, it, expect, vi } from 'vitest';
import { detectImageUpdateAvailability } from '../services/imageUpdateDetect';
import { computeImagePreview } from '../services/UpdatePreviewService';
import type { DigestComparisonResult } from '../services/registry-api';

const PLATFORM = { os: 'linux', architecture: 'amd64' };
const LOCAL_DIGEST = `sha256:${'a'.repeat(64)}`;
const CREDENTIALS = { username: 'u', password: 'p' };
const IMAGE = 'nginx:1.2.3';

/**
 * COR-1 regression: persisted sidebar status (via detectImageUpdateAvailability /
 * checkImage) and Fleet/Anatomy preview (computeImagePreview) must agree when
 * the declared-tag digest matches but a higher semantic tag exists.
 */
describe('cross-surface update detection (digest match + higher semver)', () => {
  async function runDetectionAndPreview(
    comparison: DigestComparisonResult,
    tags: string[],
    localDigest: string | null = LOCAL_DIGEST,
  ) {
    const compareDigest = vi.fn().mockResolvedValue(comparison);
    const listTags = vi.fn().mockResolvedValue(tags);

    const detection = await detectImageUpdateAvailability({
      localDigest,
      platform: PLATFORM,
      registry: 'registry-1.docker.io',
      repo: 'library/nginx',
      tag: '1.2.3',
      credentials: CREDENTIALS,
      deps: { compareDigest, listTags },
    });

    const preview = await computeImagePreview('app', IMAGE, {
      getCredentials: vi.fn().mockResolvedValue(CREDENTIALS),
      getLocalDigest: vi.fn().mockResolvedValue({ digest: localDigest, platform: PLATFORM }),
      compareDigest,
      listRegistryTags: listTags,
    });

    return { detection, preview, compareDigest };
  }

  it('shared detector and preview both report hasUpdate for app:1.2.3 when 1.2.4 exists', async () => {
    const { detection, preview } = await runDetectionAndPreview(
      { kind: 'match' },
      ['1.2.3', '1.2.4'],
    );

    expect(detection.hasUpdate).toBe(true);
    expect(detection.nextTag).toBe('1.2.4');
    expect(detection.digestUpdate).toBe(false);
    expect(preview.has_update).toBe(true);
    expect(preview.next_tag).toBe('1.2.4');
    expect(preview.has_update).toBe(detection.hasUpdate);
  });

  it('shared detector and preview both clear when digest matches and no higher tag exists', async () => {
    const { detection, preview } = await runDetectionAndPreview({ kind: 'match' }, ['1.2.3']);

    expect(detection.hasUpdate).toBe(false);
    expect(preview.has_update).toBe(false);
    expect(preview.has_update).toBe(detection.hasUpdate);
  });

  it('shared detector and preview both report hasUpdate when digest errors but 1.2.4 exists', async () => {
    const { detection, preview } = await runDetectionAndPreview(
      { kind: 'error', reason: 'Registry unreachable' },
      ['1.2.3', '1.2.4'],
    );

    expect(detection.hasUpdate).toBe(true);
    expect(detection.nextTag).toBe('1.2.4');
    expect(detection.digestUpdate).toBe(false);
    expect(detection.digestError).toBe('Registry unreachable');
    expect(preview.has_update).toBe(true);
    expect(preview.next_tag).toBe('1.2.4');
    expect(preview.has_update).toBe(detection.hasUpdate);
  });

  it('shared detector and preview both report hasUpdate with no local digest when 1.2.4 exists', async () => {
    const { detection, preview, compareDigest } = await runDetectionAndPreview(
      { kind: 'update' },
      ['1.2.3', '1.2.4'],
      null,
    );

    expect(compareDigest).not.toHaveBeenCalled();
    expect(detection.hasUpdate).toBe(true);
    expect(detection.digestUpdate).toBe(false);
    expect(detection.nextTag).toBe('1.2.4');
    expect(preview.has_update).toBe(true);
    expect(preview.next_tag).toBe('1.2.4');
    expect(preview.has_update).toBe(detection.hasUpdate);
  });
});

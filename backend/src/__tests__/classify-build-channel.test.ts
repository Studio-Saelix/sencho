/**
 * Truth table for classifyBuildChannel, the canonical build-identity classifier.
 * Answers "is this a dev, preview, or stable build" from the image reference
 * alone, independent of the packaged semver.
 */
import { describe, it, expect } from 'vitest';
import { classifyBuildChannel } from '../helpers/selfUpdateCompose';

describe('classifyBuildChannel', () => {
  it('classifies the dev repository as dev regardless of tag', () => {
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho-dev:dev')).toBe('dev');
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho-dev:dev-abc1234')).toBe('dev');
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho-dev:latest')).toBe('dev');
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho-dev@sha256:abc')).toBe('dev');
  });

  it('classifies stable-repo preview tags as preview', () => {
    expect(classifyBuildChannel('saelix/sencho:pr-42')).toBe('preview');
    expect(classifyBuildChannel('saelix/sencho:preview-abc1234')).toBe('preview');
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho:pr-7')).toBe('preview');
  });

  it('classifies stable-repo release/floating tags as stable', () => {
    expect(classifyBuildChannel('saelix/sencho:0.97.1')).toBe('stable');
    expect(classifyBuildChannel('saelix/sencho:latest')).toBe('stable');
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho:v1.2.3')).toBe('stable');
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho-hardened:1.2.3')).toBe('stable');
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho-hardened:latest')).toBe('stable');
  });

  it('treats a dev-<sha> tag as preview-matching-tolerant (still dev repo wins)', () => {
    // dev repo takes precedence over the preview/stable tag classification
    expect(classifyBuildChannel('ghcr.io/studio-saelix/sencho-dev:pr-42')).toBe('dev');
  });

  it('classifies unknown repositories as unknown', () => {
    expect(classifyBuildChannel('ubuntu:22.04')).toBe('unknown');
    expect(classifyBuildChannel('registry.example.com/private/app:1.0')).toBe('unknown');
    expect(classifyBuildChannel('')).toBe('unknown');
    expect(classifyBuildChannel('   ')).toBe('unknown');
  });
});
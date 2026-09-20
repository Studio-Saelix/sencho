import { describe, expect, it } from 'vitest';
import {
  digestPinsOverlayYaml,
  isDigestPinValue,
  isDigestPinsMap,
  toDigestImageRef,
} from '../services/gitops/digestPins';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;

describe('digestPins', () => {
  it('strips tags and digests when building a pin ref', () => {
    expect(toDigestImageRef('nginx:1.27', DIGEST_A)).toBe(`nginx@${DIGEST_A}`);
    expect(toDigestImageRef('ghcr.io/org/app:v1', DIGEST_B)).toBe(`ghcr.io/org/app@${DIGEST_B}`);
    expect(toDigestImageRef(`nginx@${DIGEST_A}`, DIGEST_C)).toBe(`nginx@${DIGEST_C}`);
    expect(toDigestImageRef('nginx', 'not-a-digest')).toBeNull();
    expect(toDigestImageRef('nginx', 'sha256:abc')).toBeNull();
  });

  it('validates digest pin shape', () => {
    expect(isDigestPinValue(`nginx@${DIGEST_A}`)).toBe(true);
    expect(isDigestPinValue('nginx@sha256:')).toBe(false);
    expect(isDigestPinValue('nginx@sha256:not-hex')).toBe(false);
    expect(isDigestPinsMap({ web: `nginx@${DIGEST_A}` })).toBe(true);
    expect(isDigestPinsMap({ web: 'nginx@sha256:short' })).toBe(false);
    expect(isDigestPinsMap({})).toBe(false);
  });

  it('renders a compose overlay that pins images without touching authored files', () => {
    const yaml = digestPinsOverlayYaml({
      web: `nginx@${DIGEST_A}`,
      api: `ghcr.io/org/api@${DIGEST_B}`,
    });
    expect(yaml).toContain('services:');
    expect(yaml).toContain('"api":');
    expect(yaml).toContain(`image: "ghcr.io/org/api@${DIGEST_B}"`);
    expect(yaml).toContain('"web":');
    expect(yaml).toContain(`image: "nginx@${DIGEST_A}"`);
  });
});

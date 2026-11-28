import { expect, it } from 'vitest';
import { mergeImageUpdateAuthority } from '../services/imageUpdateAuthority';
import type { ImageUpdateDetectResult } from '../services/imageUpdateDetect';

const anonymousFailure: ImageUpdateDetectResult = {
    hasUpdate: false, digestUpdate: false, tagUpdate: false, nextTag: null,
    digestError: 'Authentication required', tagEnumKind: 'error',
    tagEnumReason: 'Authentication required', checkStatus: 'failed',
    reason: 'Authentication required', semverBump: 'none', candidateDigest: null,
};
const hubSuccess: ImageUpdateDetectResult = {
    hasUpdate: true, digestUpdate: true, tagUpdate: false, nextTag: null,
    digestError: null, tagEnumKind: 'skipped', tagEnumReason: null,
    checkStatus: 'ok', reason: null, semverBump: 'patch', candidateDigest: `sha256:${'b'.repeat(64)}`,
};

it('uses conclusive hub evidence for anonymous failure, never for a configured target credential', () => {
    expect(mergeImageUpdateAuthority({
        source: 'anonymous', result: anonymousFailure, observedAt: 1,
    }, hubSuccess)).toBe(hubSuccess);
    expect(mergeImageUpdateAuthority({
        source: 'target_credential', result: anonymousFailure, observedAt: 1,
    }, hubSuccess)).toEqual(anonymousFailure);
});

it('reads a target result sent without a candidate digest as an unknown candidate', () => {
    const { candidateDigest: _omitted, ...wire } = hubSuccess;
    expect(mergeImageUpdateAuthority({ source: 'target_credential', result: wire, observedAt: 1 }, null))
        .toEqual({ ...hubSuccess, candidateDigest: null });
});

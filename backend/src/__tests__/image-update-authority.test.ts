import { expect, it } from 'vitest';
import { mergeImageUpdateAuthority } from '../services/imageUpdateAuthority';
import type { ImageUpdateDetectResult } from '../services/imageUpdateDetect';

const anonymousFailure: ImageUpdateDetectResult = {
    hasUpdate: false, digestUpdate: false, tagUpdate: false, nextTag: null,
    digestError: 'Authentication required', tagEnumKind: 'error',
    tagEnumReason: 'Authentication required', checkStatus: 'failed',
    reason: 'Authentication required', semverBump: 'none',
};
const hubSuccess: ImageUpdateDetectResult = {
    hasUpdate: true, digestUpdate: true, tagUpdate: false, nextTag: null,
    digestError: null, tagEnumKind: 'skipped', tagEnumReason: null,
    checkStatus: 'ok', reason: null, semverBump: 'patch',
};

it('uses conclusive hub evidence for anonymous failure, never for a configured target credential', () => {
    expect(mergeImageUpdateAuthority({
        source: 'anonymous', result: anonymousFailure, observedAt: 1,
    }, hubSuccess)).toBe(hubSuccess);
    expect(mergeImageUpdateAuthority({
        source: 'target_credential', result: anonymousFailure, observedAt: 1,
    }, hubSuccess)).toBe(anonymousFailure);
});

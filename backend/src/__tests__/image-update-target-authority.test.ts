import { describe, expect, it, vi } from 'vitest';
import { collectTargetImageAuthority } from '../services/imageUpdateTargetAuthority';

const image = {
    ref: 'registry.example.com/team/app:1.0.0',
    localDigests: ['sha256:aaa'],
    platform: { os: 'linux', architecture: 'amd64' },
    emptyReason: 'none' as const,
};

describe('target image authority', () => {
    it('preserves configured credential failure without attempting anonymous detection', async () => {
        const resolveCredentials = vi.fn().mockResolvedValue({ state: 'unavailable' });
        const detect = vi.fn();
        const authority = await collectTargetImageAuthority(image, { resolveCredentials, detect });

        expect(resolveCredentials).toHaveBeenCalledWith('registry.example.com');
        expect(detect).not.toHaveBeenCalled();
        expect(authority).toEqual({
            source: 'target_credential',
            observedAt: expect.any(Number),
            result: {
                hasUpdate: false, digestUpdate: false, tagUpdate: false, nextTag: null,
                digestError: 'Target registry credentials are unavailable', tagEnumKind: 'error',
                tagEnumReason: 'Target registry credentials are unavailable', checkStatus: 'failed',
                reason: 'Target registry credentials are unavailable', semverBump: 'none',
            },
        });
    });
});

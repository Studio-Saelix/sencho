/**
 * The candidate digest a detection reports: the registry's current digest for
 * the tag when it is a same-tag rebuild. It is what a skip entry names, so it
 * must be the exact (lowercased) digest the comparison saw, and absent when
 * there is nothing to skip.
 */
import { describe, expect, it, vi } from 'vitest';
import { detectImageUpdate } from '../services/imageUpdateDetect';
import { applyIgnore } from '../services/updateDetectionDirectives';

const LOCAL = `sha256:${'1'.repeat(64)}`;
const REMOTE = `sha256:${'A'.repeat(64)}`;

async function detect(comparison: { kind: 'match' | 'update' | 'error'; primaryDigest?: string; reason?: string }) {
    return detectImageUpdate({
        localDigests: [LOCAL], platform: { os: 'linux', architecture: 'amd64' },
        registry: 'registry-1.docker.io', repo: 'library/nginx', tag: 'latest', credentials: null,
        deps: {
            compareDigest: vi.fn().mockResolvedValue(comparison),
            listRegistryTagsResult: vi.fn().mockResolvedValue({ ok: true, tags: [] }),
        },
    });
}

describe('candidateDigest', () => {
    it('is the lowercased registry digest on a same-tag rebuild', async () => {
        const result = await detect({ kind: 'update', primaryDigest: REMOTE });
        expect(result.digestUpdate).toBe(true);
        expect(result.candidateDigest).toBe(REMOTE.toLowerCase());
    });

    it('is null when the image matches, the comparison fails, or the digest is unknown', async () => {
        expect((await detect({ kind: 'match', primaryDigest: REMOTE })).candidateDigest).toBeNull();
        expect((await detect({ kind: 'error', primaryDigest: REMOTE, reason: 'boom' })).candidateDigest).toBeNull();
        expect((await detect({ kind: 'update' })).candidateDigest).toBeNull();
    });
});

describe('tag candidates', () => {
    it('reports only the highest newer tag, and skipping it leaves no lower advisory', async () => {
        const result = await detectImageUpdate({
            localDigests: [LOCAL], platform: { os: 'linux', architecture: 'amd64' },
            registry: 'registry-1.docker.io', repo: 'library/nginx', tag: '1.0.0', credentials: null,
            deps: {
                compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
                listRegistryTagsResult: vi.fn().mockResolvedValue({ ok: true, tags: ['1.1.0', '2.0.0'] }),
            },
        });
        expect(result.nextTag).toBe('2.0.0');
        const skipped = applyIgnore(result, [{ kind: 'tag', tag: '2.0.0' }], '1.0.0').result;
        expect(skipped).toMatchObject({ hasUpdate: false, tagUpdate: false, nextTag: null });
    });
});

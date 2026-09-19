import { beforeEach, expect, it, vi } from 'vitest';
import { RemoteImageUpdateService } from '../services/RemoteImageUpdateService';
import { fetchRemoteImageUpdateFacts } from '../services/remoteImageUpdateClient';
import { probeRemoteImageUpdate } from '../services/remoteImageUpdateProbe';
import type { ImageUpdateStackFacts } from '../services/imageUpdateFacts';
import type { ImageUpdateDetectResult } from '../services/imageUpdateDetect';

vi.mock('../services/remoteImageUpdateClient', () => ({
    fetchRemoteImageUpdateFacts: vi.fn(), fetchRemoteImageUpdateRoster: vi.fn(),
}));
vi.mock('../services/remoteImageUpdateProbe', () => ({ probeRemoteImageUpdate: vi.fn() }));
const owner = vi.hoisted(() => ({ reserveStackWriteGeneration: vi.fn(), commitRemoteObservation: vi.fn() }));
vi.mock('../services/ImageUpdateService', () => ({
    ImageUpdateService: { getInstance: () => owner, isChecksEnabled: () => true },
    UPDATE_VERIFICATION_INCOMPLETE_WARNING: 'Incomplete',
}));
const failed: ImageUpdateDetectResult = {
    hasUpdate: false, digestUpdate: false, tagUpdate: false, nextTag: null, digestError: 'Authentication required',
    tagEnumKind: 'error', tagEnumReason: 'Authentication required', checkStatus: 'failed', reason: 'Authentication required', semverBump: 'none',
};
const success: ImageUpdateDetectResult = { ...failed, hasUpdate: true, digestUpdate: true, digestError: null,
    tagEnumKind: 'skipped', tagEnumReason: null, checkStatus: 'ok', reason: null, semverBump: 'patch' };
const facts: ImageUpdateStackFacts = {
    name: 'web', model: { renderable: true }, observationRevision: 999, observationToken: 'fixture',
    services: [{ name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false }],
    images: [{ ref: 'nginx:latest', localDigests: [], platform: null, emptyReason: 'no_repo_digests',
        authority: { source: 'anonymous', result: failed, observedAt: 1 } }],
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(structuredClone(facts));
    vi.mocked(probeRemoteImageUpdate).mockResolvedValue(success);
});

it('uses safe hub evidence to replace an anonymous failure through the scanner entry point', async () => {
    const result = await RemoteImageUpdateService.getInstance().inspectRemoteStack(2, 'web', new AbortController().signal);
    expect(result.imageResults.get('nginx:latest')).toEqual({ hasUpdate: true, digestUpdate: true, tagUpdate: false, checkStatus: 'ok' });
});

it('retains explicit target credential failures without a hub credential probe', async () => {
    const target = structuredClone(facts);
    target.images[0].authority = { source: 'target_credential', result: failed, observedAt: 0 };
    vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(target);
    const result = await RemoteImageUpdateService.getInstance().inspectRemoteStack(2, 'web', new AbortController().signal);
    expect(result.imageResults.get('nginx:latest')).toMatchObject({ checkStatus: 'failed', error: 'Authentication required' });
    expect(probeRemoteImageUpdate).not.toHaveBeenCalled();
});

it('builds a read-only remote preview with complete tag and digest evidence', async () => {
    vi.mocked(probeRemoteImageUpdate).mockResolvedValue({ ...success, tagUpdate: true, nextTag: '2.0.0', semverBump: 'major' });
    const preview = await RemoteImageUpdateService.getInstance().getPreview(2, 'web', new AbortController().signal);
    expect(preview.images[0]).toMatchObject({ service: 'app', image: 'nginx:latest',
        next_tag: '2.0.0', digest_update: true, tag_update: true, check_status: 'ok' });
    expect(preview.summary).toMatchObject({ has_update: true, blocked: true, update_kind: 'tag' });
    expect(owner.commitRemoteObservation).not.toHaveBeenCalled();
});

it('preserves target credential authority in remote previews', async () => {
    const target = structuredClone(facts);
    target.images[0].authority = { source: 'target_credential', result: failed, observedAt: 0 };
    vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(target);
    const preview = await RemoteImageUpdateService.getInstance().getPreview(2, 'web', new AbortController().signal);
    expect(preview.summary).toMatchObject({ check_status: 'failed', verification_failed: true });
    expect(preview.images[0].digest_error).toBe('Authentication required');
    expect(probeRemoteImageUpdate).not.toHaveBeenCalled();
});

it('reserves a hub generation before fetching facts and never uses the target revision as the write generation', async () => {
    owner.reserveStackWriteGeneration.mockReturnValue(7);
    owner.commitRemoteObservation.mockResolvedValue({ outcome: 'still_present', warning: 'Still present' });
    await RemoteImageUpdateService.getInstance().recheckRemoteStack(2, 'web', new AbortController().signal);
    expect(owner.reserveStackWriteGeneration.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fetchRemoteImageUpdateFacts).mock.invocationCallOrder[0]);
    expect(owner.commitRemoteObservation).toHaveBeenCalledWith(2, facts, expect.any(Map), 7);
});

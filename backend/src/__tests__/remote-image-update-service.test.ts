import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteImageUpdateService } from '../services/RemoteImageUpdateService';
import { fetchRemoteImageUpdateFacts, fetchRemoteImageUpdateRoster } from '../services/remoteImageUpdateClient';
import { probeRemoteImageUpdate } from '../services/remoteImageUpdateProbe';
import { probeRemoteCapability } from '../helpers/remoteCapabilities';
import { SENCHO_LABEL_DETECTION_CAPABILITY, SENCHO_LABEL_POLICY_CAPABILITY } from '../helpers/senchoLabels';
import type { ImageUpdateStackFacts } from '../services/imageUpdateFacts';
import type { ImageUpdateDetectResult } from '../services/imageUpdateDetect';

vi.mock('../services/remoteImageUpdateClient', () => ({
    fetchRemoteImageUpdateFacts: vi.fn(), fetchRemoteImageUpdateRoster: vi.fn(),
}));
vi.mock('../services/remoteImageUpdateProbe', () => ({ probeRemoteImageUpdate: vi.fn() }));
vi.mock('../helpers/remoteCapabilities', () => ({
    probeRemoteCapability: vi.fn().mockResolvedValue({ kind: 'supported' }),
}));
const owner = vi.hoisted(() => ({
    reserveStackWriteGeneration: vi.fn(),
    commitRemoteObservation: vi.fn(),
    runRemoteScan: vi.fn(),
}));
vi.mock('../services/ImageUpdateService', () => ({
    ImageUpdateService: { getInstance: () => owner, isChecksEnabled: () => true },
    UPDATE_VERIFICATION_INCOMPLETE_WARNING: 'Incomplete',
}));
const failed: ImageUpdateDetectResult = {
    hasUpdate: false, digestUpdate: false, tagUpdate: false, nextTag: null, digestError: 'Authentication required',
    tagEnumKind: 'error', tagEnumReason: 'Authentication required', checkStatus: 'failed', reason: 'Authentication required', semverBump: 'none',
    candidateDigest: null,
};
const success: ImageUpdateDetectResult = { ...failed, hasUpdate: true, digestUpdate: true, digestError: null,
    tagEnumKind: 'skipped', tagEnumReason: null, checkStatus: 'ok', reason: null, semverBump: 'patch',
    candidateDigest: `sha256:${'c'.repeat(64)}` };
const facts: ImageUpdateStackFacts = {
    name: 'web', model: { renderable: true }, observationRevision: 999, observationToken: 'fixture',
    services: [{ name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false }],
    images: [{ ref: 'nginx:latest', localDigests: [], platform: null, emptyReason: 'no_repo_digests',
        authority: { source: 'anonymous', result: failed, observedAt: 1 } }],
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(structuredClone(facts));
    vi.mocked(fetchRemoteImageUpdateRoster).mockResolvedValue(['web']);
    vi.mocked(probeRemoteCapability).mockResolvedValue({ kind: 'supported' });
    vi.mocked(probeRemoteImageUpdate).mockResolvedValue(success);
    owner.runRemoteScan.mockImplementation(async (_nodeId: number, _manual: boolean, scan: () => Promise<void>) => {
        await scan();
        return true;
    });
});

it('uses safe hub evidence to replace an anonymous failure through the scanner entry point', async () => {
    const result = await RemoteImageUpdateService.getInstance().inspectRemoteStack(2, 'web', new AbortController().signal);
    expect(result.imageResults.get('nginx:latest')).toEqual({
        hasUpdate: true, digestUpdate: true, tagUpdate: false, checkStatus: 'ok', detection: success,
    });
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
    // A target that evaluates the label answers with the policy, so the commit
    // can record the same skip its own schedule applies.
    expect(fetchRemoteImageUpdateFacts).toHaveBeenCalledWith(2, 'web', expect.any(AbortSignal), { includePolicy: true, detection: true });
    expect(probeRemoteCapability).toHaveBeenCalledWith(2, SENCHO_LABEL_POLICY_CAPABILITY);
    expect(probeRemoteCapability).toHaveBeenCalledWith(2, SENCHO_LABEL_DETECTION_CAPABILITY);
});

it('asks a policy-capable target for the decision on a full node scan', async () => {
    owner.reserveStackWriteGeneration.mockReturnValue(7);
    owner.commitRemoteObservation.mockResolvedValue({ outcome: 'cleared', warning: null });
    await RemoteImageUpdateService.getInstance().checkRemoteNode(2, true);
    expect(fetchRemoteImageUpdateFacts).toHaveBeenCalledWith(2, 'web', expect.any(AbortSignal), { includePolicy: true, detection: true });
    expect(owner.commitRemoteObservation).toHaveBeenCalledWith(2, facts, expect.any(Map), 7);
    expect(probeRemoteCapability).toHaveBeenCalledWith(2, SENCHO_LABEL_POLICY_CAPABILITY);
});

it('does not ask an older target for a policy or detection labels it cannot evaluate', async () => {
    vi.mocked(probeRemoteCapability).mockResolvedValue({ kind: 'unsupported' });
    owner.reserveStackWriteGeneration.mockReturnValue(7);
    owner.commitRemoteObservation.mockResolvedValue({ outcome: 'cleared', warning: null });
    await RemoteImageUpdateService.getInstance().recheckRemoteStack(2, 'web', new AbortController().signal);
    expect(fetchRemoteImageUpdateFacts).toHaveBeenCalledWith(2, 'web', expect.any(AbortSignal), { includePolicy: false, detection: false });
    expect(probeRemoteCapability).toHaveBeenCalledWith(2, SENCHO_LABEL_POLICY_CAPABILITY);
});

describe('update detection labels on hub-run checks', () => {
    const CANDIDATE = `sha256:${'c'.repeat(64)}`;
    function labeled(): ImageUpdateStackFacts {
        const body = structuredClone(facts);
        body.services.push({ name: 'cache', declaredImage: 'redis:7', runtimeImages: [], hasBuild: false });
        body.images.push({ ref: 'redis:7', localDigests: [], platform: null, emptyReason: 'no_repo_digests',
            authority: { source: 'unchecked', result: null, observedAt: 1 } });
        body.directives = [
            { service: 'app', check: true, ignore: [CANDIDATE], changelogUrl: 'https://example.com/notes' },
            { service: 'cache', check: false, ignore: [], changelogUrl: null },
        ];
        return body;
    }

    it('does not probe an image only a checks-off service uses, and reads it as not checked', async () => {
        vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(labeled());
        const { imageResults } = await RemoteImageUpdateService.getInstance()
            .inspectRemoteStack(2, 'web', new AbortController().signal, { detection: true });
        expect(vi.mocked(probeRemoteImageUpdate).mock.calls.map(call => call[0].ref)).toEqual(['nginx:latest']);
        expect(imageResults.get('redis:7')).toEqual({ hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true });
    });

    it('probes every image for an unattended pre-flight', async () => {
        vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(labeled());
        await RemoteImageUpdateService.getInstance()
            .inspectRemoteStack(2, 'web', new AbortController().signal, { detection: true, probeAll: true });
        expect(vi.mocked(probeRemoteImageUpdate).mock.calls.map(call => call[0].ref).sort()).toEqual(['nginx:latest', 'redis:7']);
    });

    it('asks a detection-capable target for its labels and shows skipped and unchecked services in the preview', async () => {
        vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(labeled());
        const preview = await RemoteImageUpdateService.getInstance().getPreview(2, 'web', new AbortController().signal);
        expect(fetchRemoteImageUpdateFacts).toHaveBeenCalledWith(2, 'web', expect.any(AbortSignal), { detection: true });
        // The hub probe won the authority merge, and its candidate digest is the one skipped.
        expect(preview.images.find(image => image.service === 'app')).toMatchObject({
            has_update: false, detection: 'ignored', check_status: 'ok',
        });
        expect(preview.images.find(image => image.service === 'cache')).toMatchObject({
            has_update: false, detection: 'off', check_status: 'not_checkable',
        });
        expect(preview.summary.has_update).toBe(false);
        expect(probeRemoteImageUpdate).toHaveBeenCalledTimes(1);
    });

    it('matches a skip against the target credential result too', async () => {
        const body = labeled();
        body.images[0].authority = { source: 'target_credential', result: success, observedAt: 1 };
        vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(body);
        const preview = await RemoteImageUpdateService.getInstance().getPreview(2, 'web', new AbortController().signal);
        expect(probeRemoteImageUpdate).not.toHaveBeenCalled();
        expect(preview.images.find(image => image.service === 'app')).toMatchObject({ has_update: false, detection: 'ignored' });
    });

    it('reports a newer candidate with its changelog link', async () => {
        vi.mocked(probeRemoteImageUpdate).mockResolvedValue({ ...success, candidateDigest: `sha256:${'d'.repeat(64)}` });
        vi.mocked(fetchRemoteImageUpdateFacts).mockResolvedValue(labeled());
        const preview = await RemoteImageUpdateService.getInstance().getPreview(2, 'web', new AbortController().signal);
        expect(preview.images.find(image => image.service === 'app')).toMatchObject({
            has_update: true, candidate_digest: `sha256:${'d'.repeat(64)}`, changelog_url: 'https://example.com/notes',
        });
    });

    it('reports every update from a target without the capability', async () => {
        vi.mocked(probeRemoteCapability).mockResolvedValue({ kind: 'unsupported' });
        const preview = await RemoteImageUpdateService.getInstance().getPreview(2, 'web', new AbortController().signal);
        expect(fetchRemoteImageUpdateFacts).toHaveBeenCalledWith(2, 'web', expect.any(AbortSignal), { detection: false });
        expect(preview.images[0]).toMatchObject({ has_update: true, candidate_digest: CANDIDATE });
    });
});

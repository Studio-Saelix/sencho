import { describe, it, expect, vi } from 'vitest';
import {
    parseSemverTag,
    findNextTag,
    computeSemverBump,
    computeImagePreview,
    buildSummary,
    isMovingTag,
    listAllRegistryTagsBounded,
    isAuthoritativeNegativePreview,
    PREVIEW_TAG_LIST_MAX_PAGES,
    type ComputePreviewDeps,
    type LocalDigestInfo,
} from '../services/UpdatePreviewService';
import { selectLocalRepoDigests, type DigestComparisonResult, type ParsedRef, type TagListResult } from '../services/registry-api';

const PLATFORM = { os: 'linux', architecture: 'amd64' };

function localDigest(
    digest: string | null | string[],
    emptyReason: LocalDigestInfo['emptyReason'] = null,
): LocalDigestInfo {
    if (Array.isArray(digest)) return { digests: digest, platform: PLATFORM, emptyReason };
    if (digest) return { digests: [digest], platform: PLATFORM, emptyReason: null };
    return {
        digests: [],
        platform: PLATFORM,
        emptyReason: emptyReason ?? 'not_checkable',
    };
}

function tagsOk(tags: string[], nextCursor?: string): TagListResult {
    return nextCursor ? { ok: true, tags, nextCursor } : { ok: true, tags };
}

describe('parseSemverTag', () => {
    it('parses bare semver', () => {
        expect(parseSemverTag('1.2.3')).toMatchObject({ prefix: '', major: 1, minor: 2, patch: 3, suffix: '' });
    });
    it('parses v-prefixed semver', () => {
        expect(parseSemverTag('v1.2.3')).toMatchObject({ prefix: 'v', major: 1, minor: 2, patch: 3 });
    });
    it('parses suffixed semver (alpine, slim)', () => {
        expect(parseSemverTag('27.1.4-alpine')).toMatchObject({ major: 27, minor: 1, patch: 4, suffix: 'alpine' });
    });
    it('rejects non-semver', () => {
        expect(parseSemverTag('latest')).toBeNull();
        expect(parseSemverTag('main')).toBeNull();
        expect(parseSemverTag('1.2')).toBeNull();
    });
});

describe('isMovingTag', () => {
    it('treats fully-pinned semver as immutable', () => {
        expect(isMovingTag('1.2.3')).toBe(false);
        expect(isMovingTag('v1.2.3')).toBe(false);
        expect(isMovingTag('27.1.4-alpine')).toBe(false);
    });
    it('treats latest, branches, and unpinned major/minor as moving', () => {
        expect(isMovingTag('latest')).toBe(true);
        expect(isMovingTag('main')).toBe(true);
        expect(isMovingTag('stable')).toBe(true);
        expect(isMovingTag('1.25')).toBe(true);
        expect(isMovingTag('unknown')).toBe(true);
    });
});

describe('findNextTag', () => {
    it('picks highest semver greater than current', () => {
        const tags = ['27.1.3', '27.1.4', '27.1.5', '27.2.0', '27.1.5-alpine'];
        expect(findNextTag('27.1.4', tags)).toBe('27.2.0');
    });
    it('keeps prefix style (v vs bare)', () => {
        const tags = ['1.2.3', '1.2.4', 'v1.2.4', 'v1.3.0'];
        expect(findNextTag('v1.2.3', tags)).toBe('v1.3.0');
        expect(findNextTag('1.2.3', tags)).toBe('1.2.4');
    });
    it('keeps suffix style (alpine)', () => {
        const tags = ['1.2.3', '1.2.4', '1.2.3-alpine', '1.2.4-alpine'];
        expect(findNextTag('1.2.3-alpine', tags)).toBe('1.2.4-alpine');
    });
    it('returns null when current tag is not semver', () => {
        expect(findNextTag('latest', ['latest', '1.2.3'])).toBeNull();
    });
    it('returns null when no higher semver exists', () => {
        expect(findNextTag('1.2.3', ['1.2.0', '1.2.1', '1.2.2'])).toBeNull();
    });
});

describe('computeSemverBump', () => {
    it('detects major jump', () => {
        expect(computeSemverBump('1.2.3', '2.0.0')).toBe('major');
    });
    it('detects minor jump', () => {
        expect(computeSemverBump('1.2.3', '1.3.0')).toBe('minor');
    });
    it('detects patch jump', () => {
        expect(computeSemverBump('1.2.3', '1.2.4')).toBe('patch');
    });
    it('returns patch when tags are identical (digest rebuild)', () => {
        expect(computeSemverBump('latest', 'latest')).toBe('patch');
    });
    it('returns none when no next tag', () => {
        expect(computeSemverBump('1.2.3', null)).toBe('none');
    });
    it('returns unknown for non-semver pairs', () => {
        expect(computeSemverBump('main', 'stable')).toBe('unknown');
    });
});

function makeDeps(overrides: Partial<ComputePreviewDeps> = {}): ComputePreviewDeps {
    return {
        getCredentials: vi.fn().mockResolvedValue(null),
        getLocalDigest: vi.fn().mockResolvedValue(localDigest(null)),
        compareDigest: vi.fn().mockResolvedValue({ kind: 'error', reason: 'not configured' } satisfies DigestComparisonResult),
        listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        ...overrides,
    };
}

describe('computeImagePreview', () => {
    it('reports no update when the comparison resolver matches and no higher tag exists', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk(['1.2.3'])),
        });
        const result = await computeImagePreview('web', 'nginx:1.2.3', deps);
        expect(result.has_update).toBe(false);
        expect(result.semver_bump).toBe('none');
        expect(result.next_tag).toBeNull();
    });

    it('reports digest rebuild as patch when tag is unchanged but the resolver classifies an update', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'update' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        });
        const result = await computeImagePreview('web', 'nginx:latest', deps);
        expect(result.has_update).toBe(true);
        expect(result.current_tag).toBe('latest');
        expect(result.next_tag).toBe('latest');
        expect(result.semver_bump).toBe('patch');
    });

    it('reports higher semver tag when available', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk(['27.1.4', '27.1.5', '27.2.0'])),
        });
        const result = await computeImagePreview('engine', 'docker.io/library/docker:27.1.4', deps);
        expect(result.has_update).toBe(true);
        expect(result.next_tag).toBe('27.2.0');
        expect(result.semver_bump).toBe('minor');
    });

    it('flags major semver jumps', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk(['1.2.3', '2.0.0'])),
        });
        const result = await computeImagePreview('db', 'postgres:1.2.3', deps);
        expect(result.next_tag).toBe('2.0.0');
        expect(result.semver_bump).toBe('major');
    });

    it('fails soft (no digest-based update) when the comparison resolver errors, but a higher tag still surfaces', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'error', reason: 'Registry unreachable' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk(['1.2.3', '1.2.4'])),
        });
        const result = await computeImagePreview('web', 'nginx:1.2.3', deps);
        expect(result.has_update).toBe(true);
        expect(result.next_tag).toBe('1.2.4');
        expect(result.semver_bump).toBe('patch');
        // A confirmed tag-based update overrides the digest hiccup: the overall
        // check_status resolves 'ok' and check_error is not surfaced (see the
        // "treats digest error + higher tag as a confirmed update" test below).
        expect(result.check_error).toBeNull();
    });

    it('surfaces verification failure when the comparison resolver errors and no higher tag exists', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'error', reason: 'Registry unreachable' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        });
        const result = await computeImagePreview('web', 'nginx:1.2.3', deps);
        expect(result.has_update).toBe(false);
        expect(result.next_tag).toBeNull();
        expect(result.semver_bump).toBe('none');
        expect(result.check_error).toBe('Registry unreachable');
        expect(result.check_status).toBe('partial');
    });

    it('treats digest error + higher tag as a confirmed update (ok)', async () => {
        const result = await computeImagePreview('web', 'nginx:1.2.3', makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'error', reason: 'Registry unreachable' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk(['1.2.3', '1.2.4'])),
        }));
        expect(result.has_update).toBe(true);
        expect(result.next_tag).toBe('1.2.4');
        expect(result.check_status).toBe('ok');
    });

    it('treats empty RepoDigests as not_checkable (no verification failure)', async () => {
        const compareDigest = vi.fn().mockResolvedValue({ kind: 'update' });
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest(null, 'not_checkable')),
            compareDigest,
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        });
        const result = await computeImagePreview('web', 'nginx:1.2.3', deps);
        expect(compareDigest).not.toHaveBeenCalled();
        expect(result.has_update).toBe(false);
        expect(result.check_error).toBeNull();
    });

    it('surfaces unresolved RepoDigests as verification failure without claiming an update', async () => {
        const compareDigest = vi.fn().mockResolvedValue({ kind: 'update' });
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest(null, 'unresolved')),
            compareDigest,
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        });
        const result = await computeImagePreview('web', 'nginx:1.2.3', deps);
        expect(compareDigest).not.toHaveBeenCalled();
        expect(result.has_update).toBe(false);
        expect(result.check_error).toBe('Could not resolve a local registry digest');
    });

    it('wires a real unrelated-repository RepoDigest through selectLocalRepoDigests to an unresolved verification failure', async () => {
        // getLocalDigest here is not a canned stand-in: it runs the real
        // selectLocalRepoDigests against a RepoDigests array whose sole valid
        // entry belongs to a different repository, proving the removed
        // sole-unmatched-digest fallback stays removed through the actual
        // preview-computation path, not just at the registry-api unit level.
        const compareDigest = vi.fn().mockResolvedValue({ kind: 'update' });
        const deps = makeDeps({
            getLocalDigest: async (_imageRef: string, parsed: ParsedRef) => {
                const digests = selectLocalRepoDigests(
                    [`ghcr.io/other/image@sha256:${'b'.repeat(64)}`],
                    parsed,
                );
                return { digests, platform: PLATFORM, emptyReason: digests.length === 0 ? 'unresolved' as const : null };
            },
            compareDigest,
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        });
        const result = await computeImagePreview('web', 'nginx:1.2.3', deps);
        expect(compareDigest).not.toHaveBeenCalled();
        expect(result.has_update).toBe(false);
        expect(result.check_error).toBe('Could not resolve a local registry digest');
    });

    it('surfaces inspect failure as verification failure', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest(null, 'inspect_failed')),
            compareDigest: vi.fn(),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        });
        const result = await computeImagePreview('web', 'nginx:1.2.3', deps);
        expect(result.has_update).toBe(false);
        expect(result.check_error).toBe('Failed to inspect local image');
    });

    it('passes the local digest, tag, and platform through to the comparison resolver', async () => {
        const compareDigest = vi.fn().mockResolvedValue({ kind: 'match' });
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest,
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        });
        await computeImagePreview('web', 'ghcr.io/linuxserver/radarr:latest', deps);
        expect(compareDigest).toHaveBeenCalledWith(['sha256:aaa'], 'ghcr.io', 'linuxserver/radarr', 'latest', PLATFORM, null);
    });

    it('forwards every local digest candidate and reports no same-tag rebuild on match', async () => {
        const STALE = `sha256:${'f'.repeat(64)}`;
        const CURRENT = `sha256:${'e'.repeat(64)}`;
        const compareDigest = vi.fn().mockResolvedValue({ kind: 'match' });
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest([STALE, CURRENT])),
            compareDigest,
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk([])),
        });
        const result = await computeImagePreview('broker', 'redis:8.8.0', deps);
        expect(compareDigest).toHaveBeenCalledWith(
            [STALE, CURRENT],
            'registry-1.docker.io',
            'library/redis',
            '8.8.0',
            PLATFORM,
            null,
        );
        expect(result).toMatchObject({
            has_update: false,
            next_tag: null,
            semver_bump: 'none',
        });
    });
});

describe('buildSummary', () => {
    const baseImage = (partial: Partial<Parameters<typeof buildSummary>[1][number]> = {}) => ({
        service: 'svc',
        image: 'nginx:1.0.0',
        current_tag: '1.0.0',
        next_tag: null,
        has_update: false,
        digest_update: false,
        tag_update: false,
        semver_bump: 'none' as const,
        check_status: 'ok' as const,
        check_error: null as string | null,
        ...partial,
    });

    it('flags blocked when any image has a major bump', () => {
        const images = [
            baseImage({ service: 'web', has_update: true, semver_bump: 'major', next_tag: '2.0.0' }),
            baseImage({ service: 'cache', has_update: true, semver_bump: 'patch', next_tag: '1.0.1', image: 'redis:1.0.0' }),
        ];
        const preview = buildSummary('stacky', images);
        expect(preview.summary.blocked).toBe(true);
        expect(preview.summary.blocked_reason).toMatch(/major/i);
        expect(preview.summary.semver_bump).toBe('major');
        expect(preview.summary.verification_failed).toBe(false);
        expect(preview.summary.verification_error).toBeNull();
    });

    it('aggregates digest verification failure without claiming a digest rebuild', () => {
        const images = [
            baseImage({
                service: 'broker',
                image: 'redis:8.8.0',
                current_tag: '8.8.0',
                check_error: 'Local image platform is unknown; cannot verify multi-arch membership',
            }),
        ];
        const preview = buildSummary('app', images);
        expect(preview.summary.has_update).toBe(false);
        expect(preview.summary.update_kind).toBe('none');
        expect(preview.summary.verification_failed).toBe(true);
        expect(preview.summary.verification_error).toContain('cannot verify multi-arch membership');
    });

    it('keeps a tag update when digest verification failed on the same image', () => {
        const images = [
            baseImage({
                service: 'web',
                has_update: true,
                semver_bump: 'patch',
                next_tag: '1.0.1',
                check_error: 'Registry unreachable',
            }),
        ];
        const preview = buildSummary('app', images);
        expect(preview.summary.has_update).toBe(true);
        expect(preview.summary.update_kind).toBe('tag');
        expect(preview.summary.verification_failed).toBe(true);
        expect(preview.summary.verification_error).toBe('Registry unreachable');
    });

    it('picks first updated image as primary', () => {
        const images = [
            baseImage({ service: 'clean', has_update: false }),
            baseImage({ service: 'web', has_update: true, semver_bump: 'minor', next_tag: '1.1.0', image: 'nginx:1.0.0' }),
        ];
        const preview = buildSummary('stacky', images);
        expect(preview.summary.primary_image).toBe('nginx:1.0.0');
        expect(preview.summary.next_tag).toBe('1.1.0');
        expect(preview.summary.blocked).toBe(false);
    });

    it('returns has_update=false when no images update', () => {
        const images = [baseImage({ service: 'clean', has_update: false })];
        const preview = buildSummary('stacky', images);
        expect(preview.summary.has_update).toBe(false);
        expect(preview.summary.semver_bump).toBe('none');
    });

    it('handles empty image list', () => {
        const preview = buildSummary('empty', []);
        expect(preview.summary.has_update).toBe(false);
        expect(preview.summary.primary_image).toBeNull();
        expect(preview.rollback_target).toBeNull();
        expect(preview.summary.has_build_services).toBe(false);
        expect(preview.summary.rebuild_available).toBe(false);
    });

    it('flags rebuild_available for build-only stacks', () => {
        const preview = buildSummary('build-stack', [], ['app']);
        expect(preview.build_services).toEqual(['app']);
        expect(preview.summary.has_update).toBe(false);
        expect(preview.summary.has_build_services).toBe(true);
        expect(preview.summary.rebuild_available).toBe(true);
    });

    it('supports mixed image and build services', () => {
        const images = [
            baseImage({ service: 'web', has_update: true, semver_bump: 'patch', next_tag: '1.0.1', current_tag: '1.0.0' }),
        ];
        const preview = buildSummary('mixed', images, ['worker']);
        expect(preview.summary.has_update).toBe(true);
        expect(preview.summary.has_build_services).toBe(true);
        expect(preview.summary.rebuild_available).toBe(true);
    });

    it('computes rollback target from current tag of primary', () => {
        const images = [
            baseImage({ service: 'web', image: 'nginx:1.0.0', has_update: true, semver_bump: 'patch', next_tag: '1.0.1', current_tag: '1.0.0' }),
        ];
        const preview = buildSummary('stacky', images);
        expect(preview.rollback_target).toBe('nginx:1.0.0');
    });

    it('computes rollback target for Docker Hub library image', () => {
        const images = [
            baseImage({ service: 'db', image: 'library/postgres:16', has_update: true, semver_bump: 'patch', next_tag: '16', current_tag: '16' }),
        ];
        expect(buildSummary('stacky', images).rollback_target).toBe('postgres:16');
    });

    it('computes rollback target for registry with port', () => {
        const images = [
            baseImage({
                service: 'app',
                image: 'registry.example.com:5000/team/image:1.2.3',
                has_update: true,
                semver_bump: 'patch',
                next_tag: '1.2.4',
                current_tag: '1.2.3',
            }),
        ];
        expect(buildSummary('stacky', images).rollback_target).toBe('registry.example.com:5000/team/image:1.2.3');
    });

    it('leaves blocked false for patch/minor only updates', () => {
        const images = [
            baseImage({ service: 'web', has_update: true, semver_bump: 'patch', next_tag: '1.0.1' }),
            baseImage({ service: 'cache', has_update: true, semver_bump: 'minor', next_tag: '1.1.0', image: 'redis:1.0.0' }),
        ];
        const preview = buildSummary('stacky', images);
        expect(preview.summary.blocked).toBe(false);
        expect(preview.summary.blocked_reason).toBeNull();
        expect(preview.summary.semver_bump).toBe('minor');
    });

    it('does not let unknown bumps mask a real major bump', () => {
        const images = [
            baseImage({ service: 'odd', has_update: true, semver_bump: 'unknown', next_tag: 'main', image: 'ghcr.io/org/odd:main' }),
            baseImage({ service: 'db', has_update: true, semver_bump: 'major', next_tag: '2.0.0', image: 'postgres:1.0.0' }),
        ];
        const preview = buildSummary('stacky', images);
        expect(preview.summary.semver_bump).toBe('major');
        expect(preview.summary.blocked).toBe(true);
    });

    it('reports update_kind="tag" when at least one image has a strictly newer tag', () => {
        const images = [
            baseImage({ service: 'web', has_update: true, semver_bump: 'patch', next_tag: '1.0.1', current_tag: '1.0.0' }),
        ];
        expect(buildSummary('stacky', images).summary.update_kind).toBe('tag');
    });

    it('reports update_kind="digest" when only same-tag rebuilds are available', () => {
        const images = [
            baseImage({ service: 'web', has_update: true, semver_bump: 'patch', next_tag: '10.11', current_tag: '10.11', image: 'redis:10.11' }),
        ];
        expect(buildSummary('stacky', images).summary.update_kind).toBe('digest');
    });

    it('reports update_kind="none" when nothing has an update', () => {
        const images = [baseImage({ service: 'clean', has_update: false })];
        expect(buildSummary('stacky', images).summary.update_kind).toBe('none');
    });

    it('sets check_status=ok for empty and all-ok images', () => {
        expect(buildSummary('empty', []).summary.check_status).toBe('ok');
        expect(buildSummary('ok', [baseImage({ check_status: 'ok' })]).summary.check_status).toBe('ok');
    });

    it('rolls up mixed and failed check_status', () => {
        expect(buildSummary('mixed', [
            baseImage({ service: 'a', check_status: 'ok' }),
            baseImage({ service: 'b', check_status: 'partial' }),
        ]).summary.check_status).toBe('partial');
        expect(buildSummary('fail', [
            baseImage({ service: 'a', check_status: 'failed' }),
            baseImage({ service: 'b', check_status: 'failed' }),
        ]).summary.check_status).toBe('failed');
    });
});

describe('preview authority', () => {
    it('marks digest match + exhausted empty tags as authoritative ok with no update', async () => {
        const result = await computeImagePreview('web', 'nginx:1.2.3', makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk(['1.2.3'])),
        }));
        expect(result.has_update).toBe(false);
        expect(result.check_status).toBe('ok');
        expect(isAuthoritativeNegativePreview(buildSummary('s', [result]))).toBe(true);
    });

    it('marks digest error + successful tag list with no next as partial (not authoritative-negative)', async () => {
        const result = await computeImagePreview('web', 'nginx:1.2.3', makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'error', reason: 'boom' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue(tagsOk(['1.2.3'])),
        }));
        expect(result.has_update).toBe(false);
        expect(result.check_status).toBe('partial');
        expect(isAuthoritativeNegativePreview(buildSummary('s', [result]))).toBe(false);
    });

    it('does not treat empty or not_checkable-only previews as authoritative-negative', () => {
        expect(isAuthoritativeNegativePreview(buildSummary('empty', []))).toBe(false);
        expect(isAuthoritativeNegativePreview(buildSummary('build', [
            {
                service: 'app',
                image: 'sha256:dead',
                current_tag: 'unknown',
                next_tag: null,
                has_update: false,
                digest_update: false,
                tag_update: false,
                semver_bump: 'none',
                check_status: 'not_checkable',
                check_error: null,
            },
        ]))).toBe(false);
    });

    it('marks digest match + tag list failure as partial for semver tags', async () => {
        const result = await computeImagePreview('web', 'nginx:1.2.3', makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
            listRegistryTagsResult: vi.fn().mockResolvedValue({
                ok: false,
                code: 'REGISTRY_UPSTREAM',
                message: 'Registry unreachable',
            }),
        }));
        expect(result.has_update).toBe(false);
        expect(result.check_status).toBe('partial');
    });

    it('allows moving/non-semver tags to be authoritative-negative on digest match without tag enum', async () => {
        const listFn = vi.fn();
        const result = await computeImagePreview('web', 'nginx:latest', makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
            listRegistryTagsResult: listFn,
        }));
        expect(listFn).not.toHaveBeenCalled();
        expect(result.has_update).toBe(false);
        expect(result.check_status).toBe('ok');
        expect(isAuthoritativeNegativePreview(buildSummary('s', [result]))).toBe(true);
    });

    it('detects a newer tag found on a later page', async () => {
        const listFn = vi.fn()
            .mockResolvedValueOnce(tagsOk(['1.0.0', '1.0.1'], 'cursor-1'))
            .mockResolvedValueOnce(tagsOk(['1.1.0']));
        const result = await computeImagePreview('web', 'nginx:1.0.0', makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
            listRegistryTagsResult: listFn,
        }));
        expect(listFn).toHaveBeenCalledTimes(2);
        expect(result.has_update).toBe(true);
        expect(result.next_tag).toBe('1.1.0');
        expect(result.check_status).toBe('ok');
    });

    it('treats page-cap with remaining cursor as non-authoritative for semver negatives', async () => {
        let page = 0;
        const listFn = vi.fn().mockImplementation(async () => {
            page += 1;
            return tagsOk([`1.0.${page}`], `cursor-${page}`);
        });
        const result = await computeImagePreview('web', 'nginx:2.0.0', makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue(localDigest('sha256:aaa')),
            compareDigest: vi.fn().mockResolvedValue({ kind: 'match' }),
            listRegistryTagsResult: listFn,
        }));
        expect(listFn).toHaveBeenCalledTimes(PREVIEW_TAG_LIST_MAX_PAGES);
        expect(result.has_update).toBe(false);
        expect(result.check_status).toBe('partial');
        expect(isAuthoritativeNegativePreview(buildSummary('s', [result]))).toBe(false);
    });

    it('marks invalid refs as not_checkable', async () => {
        const result = await computeImagePreview('web', 'sha256:deadbeef', makeDeps());
        expect(result.check_status).toBe('not_checkable');
        expect(result.has_update).toBe(false);
    });
});

describe('listAllRegistryTagsBounded', () => {
    it('returns incomplete when nextCursor remains after the page cap', async () => {
        const listFn = vi.fn().mockResolvedValue(tagsOk(['a'], 'more'));
        const outcome = await listAllRegistryTagsBounded(listFn, 'ghcr.io', 'acme/app', null, { maxPages: 2 });
        expect(outcome.kind).toBe('incomplete');
        expect(listFn).toHaveBeenCalledTimes(2);
    });

    it('returns complete when pagination exhausts', async () => {
        const listFn = vi.fn()
            .mockResolvedValueOnce(tagsOk(['a'], 'c1'))
            .mockResolvedValueOnce(tagsOk(['b']));
        const outcome = await listAllRegistryTagsBounded(listFn, 'ghcr.io', 'acme/app', null);
        expect(outcome).toEqual({ kind: 'complete', tags: ['a', 'b'] });
    });
});

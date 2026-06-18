import { describe, it, expect, vi } from 'vitest';
import {
    parseSemverTag,
    findNextTag,
    computeSemverBump,
    computeImagePreview,
    buildSummary,
    isMovingTag,
    type ComputePreviewDeps,
} from '../services/UpdatePreviewService';

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
        getLocalDigest: vi.fn().mockResolvedValue(null),
        getRemoteDigest: vi.fn().mockResolvedValue(null),
        listRegistryTags: vi.fn().mockResolvedValue([]),
        ...overrides,
    };
}

describe('computeImagePreview', () => {
    it('reports no update when digests match and no higher tag exists', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue('sha256:aaa'),
            getRemoteDigest: vi.fn().mockResolvedValue('sha256:aaa'),
            listRegistryTags: vi.fn().mockResolvedValue(['1.2.3']),
        });
        const result = await computeImagePreview('web', 'nginx:1.2.3', deps);
        expect(result.has_update).toBe(false);
        expect(result.semver_bump).toBe('none');
        expect(result.next_tag).toBeNull();
    });

    it('reports digest rebuild as patch when tag is unchanged but digest differs', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue('sha256:aaa'),
            getRemoteDigest: vi.fn().mockResolvedValue('sha256:bbb'),
            listRegistryTags: vi.fn().mockResolvedValue([]),
        });
        const result = await computeImagePreview('web', 'nginx:latest', deps);
        expect(result.has_update).toBe(true);
        expect(result.current_tag).toBe('latest');
        expect(result.next_tag).toBe('latest');
        expect(result.semver_bump).toBe('patch');
    });

    it('reports higher semver tag when available', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue('sha256:aaa'),
            getRemoteDigest: vi.fn().mockResolvedValue('sha256:aaa'),
            listRegistryTags: vi.fn().mockResolvedValue(['27.1.4', '27.1.5', '27.2.0']),
        });
        const result = await computeImagePreview('engine', 'docker.io/library/docker:27.1.4', deps);
        expect(result.has_update).toBe(true);
        expect(result.next_tag).toBe('27.2.0');
        expect(result.semver_bump).toBe('minor');
    });

    it('flags major semver jumps', async () => {
        const deps = makeDeps({
            getLocalDigest: vi.fn().mockResolvedValue('sha256:aaa'),
            getRemoteDigest: vi.fn().mockResolvedValue('sha256:aaa'),
            listRegistryTags: vi.fn().mockResolvedValue(['1.2.3', '2.0.0']),
        });
        const result = await computeImagePreview('db', 'postgres:1.2.3', deps);
        expect(result.next_tag).toBe('2.0.0');
        expect(result.semver_bump).toBe('major');
    });
});

describe('buildSummary', () => {
    const baseImage = (partial: Partial<Parameters<typeof buildSummary>[1][number]>) => ({
        service: 'svc',
        image: 'nginx:1.0.0',
        current_tag: '1.0.0',
        next_tag: null,
        has_update: false,
        semver_bump: 'none' as const,
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
});

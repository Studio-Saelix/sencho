import { describe, expect, it } from 'vitest';
import {
    applyIgnore,
    applyIgnoreToCheck,
    checkResultFromDetection,
    directivesFromFacts,
    directivesFromResolution,
    directivesToFacts,
    triggerResultForRef,
    uncheckedRefs,
    type ServiceDetectionDirective,
} from '../services/updateDetectionDirectives';
import { resolveSenchoLabels, unrenderableSenchoLabels } from '../helpers/senchoLabels';
import type { ImageUpdateDetectResult } from '../services/imageUpdateDetect';
import type { ImageCheckResult } from '../services/ImageUpdateService';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function detection(overrides: Partial<ImageUpdateDetectResult> = {}): ImageUpdateDetectResult {
    const base: ImageUpdateDetectResult = {
        hasUpdate: false, digestUpdate: false, tagUpdate: false, nextTag: null,
        digestError: null, tagEnumKind: 'complete', tagEnumReason: null,
        checkStatus: 'ok', reason: null, semverBump: 'none', candidateDigest: null,
    };
    const merged = { ...base, ...overrides };
    return { ...merged, hasUpdate: merged.digestUpdate || merged.tagUpdate };
}

/** A same-tag rebuild of 1.0.0 whose registry digest is DIGEST_A. */
const rebuild = detection({ digestUpdate: true, nextTag: '1.0.0', semverBump: 'patch', candidateDigest: DIGEST_A });
/** A newer tag 1.1.0 and a rebuild of 1.0.0 pending at once. */
const both = detection({
    digestUpdate: true, tagUpdate: true, nextTag: '1.1.0', semverBump: 'minor', candidateDigest: DIGEST_A,
});

function directive(overrides: Partial<ServiceDetectionDirective> = {}): ServiceDetectionDirective {
    return { check: true, ignore: [], changelogUrl: null, ...overrides };
}

describe('directivesFromResolution', () => {
    it('applies nothing for a missing or unrenderable resolution', () => {
        expect(directivesFromResolution(null).size).toBe(0);
        expect(directivesFromResolution(unrenderableSenchoLabels()).size).toBe(0);
    });

    it('keeps only services with a non-default directive', () => {
        const resolution = resolveSenchoLabels({
            services: {
                plain: { labels: {} },
                off: { labels: { 'io.sencho.update.check': 'false' } },
                skip: { labels: [`io.sencho.update.ignore=${DIGEST_A.toUpperCase()},1.2.0`] },
                notes: { labels: { 'io.sencho.update.changelog': 'https://example.com/releases' } },
                broken: { labels: { 'io.sencho.update.check': 'maybe' } },
            },
        });
        const directives = directivesFromResolution(resolution);
        expect([...directives.keys()].sort()).toEqual(['notes', 'off', 'skip']);
        expect(directives.get('off')).toEqual({ check: false, ignore: [], changelogUrl: null });
        expect(directives.get('skip')?.ignore).toEqual([
            { kind: 'digest', digest: DIGEST_A }, { kind: 'tag', tag: '1.2.0' },
        ]);
        expect(directives.get('notes')?.changelogUrl).toBe('https://example.com/releases');
    });
});

describe('uncheckedRefs', () => {
    it('checks a shared ref while any owner still checks it', () => {
        const directives = new Map([['off', directive({ check: false })]]);
        expect(uncheckedRefs([
            { name: 'off', refs: ['shared:1', 'only-off:1'] },
            { name: 'on', refs: ['shared:1'] },
        ], directives)).toEqual(new Set(['only-off:1']));
    });

    it('leaves a ref unchecked only when every owner has checks off, and never names an ownerless ref', () => {
        const directives = new Map([['a', directive({ check: false })], ['b', directive({ check: false })]]);
        expect(uncheckedRefs([
            { name: 'a', refs: ['x:1'] }, { name: 'b', refs: ['x:1'] },
        ], directives)).toEqual(new Set(['x:1']));
        expect(uncheckedRefs([], directives).size).toBe(0);
    });
});

describe('applyIgnore', () => {
    it('clears a matched same-tag rebuild and leaves a mismatched digest reporting', () => {
        const matched = applyIgnore(rebuild, [{ kind: 'digest', digest: DIGEST_A }], '1.0.0');
        expect(matched.ignored).toBe(true);
        expect(matched.result).toMatchObject({
            hasUpdate: false, digestUpdate: false, nextTag: null, semverBump: 'none', candidateDigest: null, checkStatus: 'ok',
        });
        const other = applyIgnore(rebuild, [{ kind: 'digest', digest: DIGEST_B }], '1.0.0');
        expect(other).toEqual({ result: rebuild, ignored: false });
    });

    it('matches a digest whatever its case', () => {
        const upper = detection({ digestUpdate: true, nextTag: '1.0.0', candidateDigest: DIGEST_A.toUpperCase() });
        expect(applyIgnore(upper, [{ kind: 'digest', digest: DIGEST_A }], '1.0.0').ignored).toBe(true);
    });

    it('clears a matched newer tag', () => {
        const tag = detection({ tagUpdate: true, nextTag: '1.1.0', semverBump: 'minor' });
        const applied = applyIgnore(tag, [{ kind: 'tag', tag: '1.1.0' }], '1.0.0');
        expect(applied.ignored).toBe(true);
        expect(applied.result).toMatchObject({ hasUpdate: false, tagUpdate: false, nextTag: null, checkStatus: 'ok' });
    });

    it('reports the other candidate when only one of two is listed, and none when both are', () => {
        const tagOnly = applyIgnore(both, [{ kind: 'tag', tag: '1.1.0' }], '1.0.0').result;
        expect(tagOnly).toMatchObject({
            hasUpdate: true, digestUpdate: true, tagUpdate: false, nextTag: '1.0.0', semverBump: 'patch', candidateDigest: DIGEST_A,
        });
        const digestOnly = applyIgnore(both, [{ kind: 'digest', digest: DIGEST_A }], '1.0.0').result;
        expect(digestOnly).toMatchObject({
            hasUpdate: true, digestUpdate: false, tagUpdate: true, nextTag: '1.1.0', semverBump: 'minor', candidateDigest: null,
        });
        const none = applyIgnore(both, [{ kind: 'digest', digest: DIGEST_A }, { kind: 'tag', tag: '1.1.0' }], '1.0.0').result;
        expect(none).toMatchObject({ hasUpdate: false, digestUpdate: false, tagUpdate: false });
    });

    it('never matches a digest entry when the candidate digest is unknown', () => {
        const unknown = detection({ digestUpdate: true, nextTag: '1.0.0', candidateDigest: null });
        expect(applyIgnore(unknown, [{ kind: 'digest', digest: DIGEST_A }], '1.0.0').ignored).toBe(false);
    });

    it('reads a skipped digest with a failed tag listing as partial, never up to date', () => {
        const listingFailed = detection({
            digestUpdate: true, nextTag: '1.0.0', candidateDigest: DIGEST_A,
            tagEnumKind: 'error', tagEnumReason: 'tag list failed',
        });
        const applied = applyIgnore(listingFailed, [{ kind: 'digest', digest: DIGEST_A }], '1.0.0').result;
        expect(applied.checkStatus).toBe('partial');
        expect(applied.reason).toBe('tag list failed');
        expect(applied.hasUpdate).toBe(false);
    });

    it('keeps hasUpdate equal to digestUpdate or tagUpdate for every ignore combination', () => {
        const lists = [[], [{ kind: 'digest' as const, digest: DIGEST_A }], [{ kind: 'tag' as const, tag: '1.1.0' }],
            [{ kind: 'digest' as const, digest: DIGEST_A }, { kind: 'tag' as const, tag: '1.1.0' }]];
        for (const ignore of lists) {
            for (const input of [rebuild, both]) {
                const { result } = applyIgnore(input, ignore, '1.0.0');
                expect(result.hasUpdate).toBe(result.digestUpdate || result.tagUpdate);
            }
        }
    });

    it('leaves a not-checkable result alone', () => {
        const notCheckable = detection({ checkStatus: 'not_checkable' });
        expect(applyIgnore(notCheckable, [{ kind: 'tag', tag: '1.1.0' }], '1.0.0')).toEqual({ result: notCheckable, ignored: false });
    });
});

describe('applyIgnoreToCheck', () => {
    it('returns a result without its detection unchanged', () => {
        const check: ImageCheckResult = { hasUpdate: true, digestUpdate: true, checkStatus: 'ok' };
        expect(applyIgnoreToCheck('app:1.0.0', check, [{ kind: 'digest', digest: DIGEST_A }]))
            .toEqual({ result: check, ignored: false });
    });

    it('reads the current tag from the ref', () => {
        const applied = applyIgnoreToCheck('app:1.0.0', checkResultFromDetection(both), [{ kind: 'tag', tag: '1.1.0' }]);
        expect(applied.ignored).toBe(true);
        expect(applied.result.detection?.nextTag).toBe('1.0.0');
    });
});

describe('triggerResultForRef', () => {
    const check = checkResultFromDetection(rebuild);

    it('suppresses an update when every owner has checks off', () => {
        const directives = new Map([['a', directive({ check: false })]]);
        const out = triggerResultForRef('app:1.0.0', ['a'], check, directives);
        expect(out.suppressed).toBe('off');
        expect(out.result.digestUpdate).toBe(false);
        expect(out.result.hasUpdate).toBe(false);
    });

    it('still counts when one owner has checks off and another checks', () => {
        const directives = new Map([['a', directive({ check: false })]]);
        expect(triggerResultForRef('app:1.0.0', ['a', 'b'], check, directives)).toEqual({ result: check, suppressed: null });
    });

    it('suppresses an update every checking owner skips', () => {
        const skip = directive({ ignore: [{ kind: 'digest', digest: DIGEST_A }] });
        const directives = new Map([['a', skip], ['b', directive({ check: false })]]);
        const out = triggerResultForRef('app:1.0.0', ['a', 'b'], check, directives);
        expect(out.suppressed).toBe('ignored');
        expect(out.result.digestUpdate).toBe(false);
    });

    it('passes a check error through untouched', () => {
        const failed: ImageCheckResult = { hasUpdate: false, checkStatus: 'failed', error: 'Registry unreachable' };
        const directives = new Map([['a', directive({ check: false })]]);
        expect(triggerResultForRef('app:1.0.0', ['a'], failed, directives)).toEqual({ result: failed, suppressed: null });
    });

    it('always counts an image with no known owner', () => {
        const directives = new Map([['a', directive({ check: false })]]);
        expect(triggerResultForRef('app:1.0.0', [], check, directives)).toEqual({ result: check, suppressed: null });
    });
});

describe('wire directives', () => {
    it('round-trips through the facts projection', () => {
        const directives = new Map([
            ['web', directive({ ignore: [{ kind: 'digest', digest: DIGEST_A }, { kind: 'tag', tag: '2.0.0' }], changelogUrl: 'https://example.com/r' })],
            ['db', directive({ check: false })],
        ]);
        const wire = directivesToFacts(directives);
        expect(wire.map(entry => entry.service)).toEqual(['db', 'web']);
        expect(directivesFromFacts({ directives: wire })).toEqual(directives);
    });

    it('drops an unreadable ignore list or link so the update is reported, not hidden', () => {
        const out = directivesFromFacts({
            directives: [
                { service: 'web', check: true, ignore: [DIGEST_A, 'not a tag'], changelogUrl: null },
                { service: 'api', check: true, ignore: [], changelogUrl: 'https://user:pw@example.com' },
                { service: 'db', check: false, ignore: ['bad entry'], changelogUrl: 'javascript:alert(1)' },
            ],
        });
        expect(out.has('web')).toBe(false);
        expect(out.has('api')).toBe(false);
        expect(out.get('db')).toEqual({ check: false, ignore: [], changelogUrl: null });
        expect(directivesFromFacts({}).size).toBe(0);
    });
});

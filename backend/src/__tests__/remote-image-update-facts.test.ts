import { describe, expect, it } from 'vitest';
import { parseRemoteImageUpdateFacts, parseRemoteImageUpdateRoster } from '../services/remoteImageUpdateFacts';
import type { ImageUpdateFactsResponse } from '../services/imageUpdateFacts';

const nonce = 'a'.repeat(32);
function response(): ImageUpdateFactsResponse {
    return {
        contractVersion: 1, requestNonce: nonce,
        stacks: [{
            name: 'web', observationRevision: 1, observationToken: 'signed-observation',
            model: { renderable: true },
            services: [{ name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false }],
            images: [{
                ref: 'nginx:latest', localDigests: [`sha256:${'b'.repeat(64)}`],
                platform: { os: 'linux', architecture: 'amd64' }, emptyReason: 'none',
                authority: { source: 'unchecked', result: null, observedAt: 1 },
            }],
        }],
    };
}

describe('remote image facts boundary', () => {
    it('accepts a bound named response without changing its evidence', () => {
        const body = response();
        expect(parseRemoteImageUpdateFacts(body, nonce, 'web')).toEqual(body);
    });

    it.each(['nonce', 'stack', 'duplicate-image', 'duplicate-service', 'missing-image', 'extra-key', 'authority', 'digest'])('rejects %s before using facts', kind => {
        const body = response();
        const stack = body.stacks[0];
        if (kind === 'nonce') body.requestNonce = 'c'.repeat(32);
        if (kind === 'stack') stack.name = 'other';
        if (kind === 'duplicate-image') stack.images.push(stack.images[0]);
        if (kind === 'duplicate-service') stack.services.push(stack.services[0]);
        if (kind === 'missing-image') stack.images = [];
        if (kind === 'extra-key') Object.assign(stack, { credentials: {} });
        if (kind === 'authority') Object.assign(stack.images[0].authority, { source: 'target_credential' });
        if (kind === 'digest') stack.images[0].localDigests = ['not-a-digest'];
        expect(() => parseRemoteImageUpdateFacts(body, nonce, 'web')).toThrow('Invalid remote image facts');
    });

    it('accepts the optional unattended policy and rejects a malformed or inconsistent one', () => {
        const body = response();
        body.stacks[0].unattendedPolicy = { decision: 'skip', ineligible: [{ service: 'app', policy: 'manual' }] };
        expect(parseRemoteImageUpdateFacts(body, nonce, 'web')).toEqual(body);

        for (const bad of [
            { decision: 'maybe', ineligible: [] },
            { decision: 'skip', ineligible: [{ service: 'db' }] },
            { decision: 'skip', ineligible: [], extra: true },
            { decision: 'allow', ineligible: [{ service: 'app', policy: 'manual' }] },
            { decision: 'skip', ineligible: [{ service: 'missing', policy: 'manual' }] },
        ]) {
            body.stacks[0].unattendedPolicy = bad as never;
            expect(() => parseRemoteImageUpdateFacts(body, nonce, 'web')).toThrow('Invalid remote image facts');
        }

        // A model that did not render can only skip, and a skip with no named
        // service means exactly that.
        body.stacks[0].model = { renderable: false, code: 'effective_model_render_failed', error: 'Cannot render' };
        body.stacks[0].services = [];
        body.stacks[0].images = [];
        body.stacks[0].unattendedPolicy = { decision: 'skip', ineligible: [] };
        expect(parseRemoteImageUpdateFacts(body, nonce, 'web')).toEqual(body);
        body.stacks[0].unattendedPolicy = { decision: 'allow', ineligible: [] };
        expect(() => parseRemoteImageUpdateFacts(body, nonce, 'web')).toThrow('Invalid remote image facts');
    });

    it('accepts render failures only without partial image evidence', () => {
        const body = response();
        body.stacks[0].model = { renderable: false, code: 'effective_model_render_failed', error: 'Cannot render' };
        expect(() => parseRemoteImageUpdateFacts(body, nonce, 'web')).toThrow();
        body.stacks[0].images = [];
        body.stacks[0].services = [];
        expect(parseRemoteImageUpdateFacts(body, nonce, 'web')).toEqual(body);
    });

    it('bounds image and stack counts and requires unique roster names', () => {
        const body = response();
        body.stacks[0].images = Array.from({ length: 25 }, (_, i) => ({ ...body.stacks[0].images[0], ref: `nginx:${i}` }));
        expect(() => parseRemoteImageUpdateFacts(body, nonce, 'web')).toThrow();
        expect(parseRemoteImageUpdateRoster({ contractVersion: 1, requestNonce: nonce, stacks: ['web'] }, nonce)).toEqual(['web']);
        for (const stacks of [['web', 'web'], ['../escape'], Array.from({ length: 501 }, (_, i) => `stack-${i}`)]) {
            expect(() => parseRemoteImageUpdateRoster({ contractVersion: 1, requestNonce: nonce, stacks }, nonce)).toThrow();
        }
    });
});

describe('update detection labels on the wire', () => {
    const CANDIDATE = `sha256:${'c'.repeat(64)}`;
    function detectionResponse(): ImageUpdateFactsResponse {
        const body = response();
        const stack = body.stacks[0];
        stack.images[0].authority = {
            source: 'anonymous', observedAt: 1,
            result: {
                hasUpdate: true, digestUpdate: true, tagUpdate: false, nextTag: 'latest', digestError: null,
                tagEnumKind: 'skipped', tagEnumReason: null, checkStatus: 'ok', reason: null, semverBump: 'patch',
                candidateDigest: CANDIDATE,
            },
        };
        stack.directives = [{ service: 'app', check: true, ignore: [CANDIDATE, '1.2.3'], changelogUrl: 'https://example.com/notes' }];
        return body;
    }

    it('accepts directives and the candidate digest when the hub asked for detection', () => {
        const body = detectionResponse();
        expect(parseRemoteImageUpdateFacts(body, nonce, 'web', true)).toEqual(body);
    });

    it('refuses directives or a candidate digest the hub did not ask for', () => {
        const withDirectives = detectionResponse();
        const result = withDirectives.stacks[0].images[0].authority.result!;
        delete result.candidateDigest;
        expect(() => parseRemoteImageUpdateFacts(withDirectives, nonce, 'web')).toThrow('Invalid remote image facts');

        const withCandidate = detectionResponse();
        delete withCandidate.stacks[0].directives;
        expect(() => parseRemoteImageUpdateFacts(withCandidate, nonce, 'web')).toThrow('Invalid remote image facts');
    });

    it.each([
        ['an unknown service', { service: 'ghost', check: false, ignore: [], changelogUrl: null }],
        ['a bad ignore entry', { service: 'app', check: true, ignore: ['not a tag'], changelogUrl: null }],
        ['a padded ignore entry', { service: 'app', check: true, ignore: [' 1.2.3'], changelogUrl: null }],
        ['nine ignore entries', { service: 'app', check: true, ignore: Array.from({ length: 9 }, (_, i) => `1.0.${i}`), changelogUrl: null }],
        ['an over-long link', { service: 'app', check: true, ignore: [], changelogUrl: `https://example.com/${'a'.repeat(2100)}` }],
        ['a link with userinfo', { service: 'app', check: true, ignore: [], changelogUrl: 'https://user:pw@example.com/' }],
        ['a non-http link', { service: 'app', check: true, ignore: [], changelogUrl: 'javascript:alert(1)' }],
        ['an extra key', { service: 'app', check: true, ignore: [], changelogUrl: null, secret: 'x' }],
    ])('rejects a directive with %s', (_name, directive) => {
        const body = detectionResponse();
        (body.stacks[0] as unknown as { directives: unknown[] }).directives = [directive];
        expect(() => parseRemoteImageUpdateFacts(body, nonce, 'web', true)).toThrow('Invalid remote image facts');
    });

    it('rejects two directives for the same service', () => {
        const body = detectionResponse();
        body.stacks[0].directives!.push({ service: 'app', check: false, ignore: [], changelogUrl: null });
        expect(() => parseRemoteImageUpdateFacts(body, nonce, 'web', true)).toThrow('Invalid remote image facts');
    });
});

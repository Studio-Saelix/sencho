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

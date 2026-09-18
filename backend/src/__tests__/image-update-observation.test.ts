import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { ImageUpdateObservationService } from '../services/ImageUpdateObservationService';

const secret = randomBytes(32).toString('hex');
vi.mock('../services/DatabaseService', () => ({
    DatabaseService: {
        getInstance: () => ({ getGlobalSettings: () => ({ auth_jwt_secret: secret }) }),
    },
}));

const binding = {
    contractVersion: 1 as const,
    requestNonce: 'a'.repeat(32),
    stack: 'demo',
    observationRevision: 1,
    factsHash: 'b'.repeat(64),
};

describe('ImageUpdateObservationService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        ImageUpdateObservationService.resetForTests();
    });
    afterEach(() => vi.useRealTimers());

    it('verifies without consuming, then consumes exactly once', () => {
        const service = ImageUpdateObservationService.getInstance();
        const token = service.issue(binding);
        expect(() => service.verify(token, binding)).not.toThrow();
        expect(() => service.verify(token, binding)).not.toThrow();
        service.consume(token, binding);
        expect(() => service.verify(token, binding)).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
        expect(() => service.consume(token, binding)).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
    });

    it('returns verified binding metadata and consumes against freshly read facts', () => {
        const service = ImageUpdateObservationService.getInstance();
        const token = service.issue(binding);
        expect(service.verifyCurrent(token, { stack: binding.stack })).toEqual(binding);
        expect(() => service.consumeCurrent(token, { stack: binding.stack, factsHash: 'c'.repeat(64) }))
            .toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
        expect(service.verifyCurrent(token, { stack: binding.stack })).toEqual(binding);
        service.consumeCurrent(token, { stack: binding.stack, factsHash: binding.factsHash });
        expect(() => service.verifyCurrent(token, { stack: binding.stack })).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
    });

    it('rejects a different stack and expired tokens through the current-facts entry points', () => {
        const service = ImageUpdateObservationService.getInstance();
        const token = service.issue(binding);
        expect(() => service.verifyCurrent(token, { stack: 'other' })).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
        vi.advanceTimersByTime(301_000);
        expect(() => service.verifyCurrent(token, { stack: binding.stack })).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
        expect(() => service.consumeCurrent(token, { stack: binding.stack, factsHash: binding.factsHash }))
            .toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
    });

    it('accepts consumption at 4m55s', () => {
        const service = ImageUpdateObservationService.getInstance();
        const token = service.issue(binding);
        vi.advanceTimersByTime(295_000);
        expect(() => service.consume(token, binding)).not.toThrow();
    });

    it.each([300_000, 301_000])('rejects consumption at token age %i ms', (age) => {
        const service = ImageUpdateObservationService.getInstance();
        const token = service.issue(binding);
        service.verify(token, binding);
        vi.advanceTimersByTime(age);
        expect(() => service.consume(token, binding)).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
    });

    it.each([
        { stack: 'other' },
        { requestNonce: 'c'.repeat(32) },
        { observationRevision: 2 },
        { factsHash: 'd'.repeat(64) },
    ])('rejects changed binding %j without consuming the original', (change) => {
        const service = ImageUpdateObservationService.getInstance();
        const token = service.issue(binding);
        expect(() => service.consume(token, { ...binding, ...change })).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
        expect(() => service.consume(token, binding)).not.toThrow();
    });

    it('invalidates observations on target restart even with the same signing secret', () => {
        const token = ImageUpdateObservationService.getInstance().issue(binding);
        ImageUpdateObservationService.resetForTests();
        expect(() => ImageUpdateObservationService.getInstance().consume(token, binding))
            .toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
    });

    it('rejects tampered signatures and malformed tokens', () => {
        const service = ImageUpdateObservationService.getInstance();
        const token = service.issue(binding);
        const [header, payload] = token.split('.');
        expect(() => service.consume(`${header}.${payload}.${'x'.repeat(43)}`, binding))
            .toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
        expect(() => service.consume('invalid', binding)).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
    });

    it('uses a distinct audience and emits only binding metadata', () => {
        const token = ImageUpdateObservationService.getInstance().issue(binding);
        const payload = jwt.verify(token, secret, {
            audience: 'image-update-observation', algorithms: ['HS256'],
        });
        expect(payload).toEqual({
            ...binding,
            targetSessionId: expect.any(String),
            jti: expect.any(String),
            iat: 1767225600,
            exp: 1767225900,
            aud: 'image-update-observation',
        });
    });

    it('fails closed at replay capacity and reclaims only expired entries', () => {
        const service = ImageUpdateObservationService.getInstance();
        service.setReplayStoreCapacityForTests(1);
        const first = service.issue(binding);
        const second = service.issue(binding);
        service.consume(first, binding);
        expect(() => service.consume(second, binding)).toThrow('IMAGE_UPDATE_OBSERVATION_CAPACITY');
        expect(() => service.consume(first, binding)).toThrow('IMAGE_UPDATE_OBSERVATION_STALE');
        vi.advanceTimersByTime(300_000);
        expect(() => service.consume(service.issue(binding), binding)).not.toThrow();
    });
});

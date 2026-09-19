import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { DatabaseService } from './DatabaseService';

const AUDIENCE = 'image-update-observation';
const TTL_SECONDS = 300;

export interface ImageUpdateObservationBinding {
    contractVersion: 1;
    requestNonce: string;
    stack: string;
    observationRevision: number;
    factsHash: string;
}

export class ImageUpdateObservationError extends Error {
    constructor(
        readonly code: 'IMAGE_UPDATE_OBSERVATION_STALE' | 'IMAGE_UPDATE_OBSERVATION_CAPACITY',
        readonly status: 409 | 503,
    ) {
        super(code);
        this.name = 'ImageUpdateObservationError';
    }
}

export class ImageUpdateObservationService {
    private static instance: ImageUpdateObservationService | null = null;
    private readonly targetSessionId = crypto.randomBytes(16).toString('hex');
    private readonly consumedJtis = new Map<string, number>();
    private maxConsumedJtis = 10_000;

    static getInstance(): ImageUpdateObservationService {
        if (!this.instance) this.instance = new ImageUpdateObservationService();
        return this.instance;
    }

    static resetForTests(): void {
        this.instance = null;
    }

    setReplayStoreCapacityForTests(capacity: number): void {
        this.maxConsumedJtis = capacity;
        this.consumedJtis.clear();
    }

    private getSecret(): string {
        const secret = DatabaseService.getInstance().getGlobalSettings().auth_jwt_secret;
        if (!secret) throw new Error('auth_jwt_secret is not configured');
        return secret;
    }

    issue(binding: ImageUpdateObservationBinding): string {
        return jwt.sign({ ...binding, targetSessionId: this.targetSessionId }, this.getSecret(), {
            algorithm: 'HS256', audience: AUDIENCE, expiresIn: TTL_SECONDS,
            jwtid: crypto.randomBytes(16).toString('hex'),
        });
    }

    private readVerified(token: string): { binding: ImageUpdateObservationBinding; jti: string; expiresAt: number } {
        const secret = this.getSecret();
        let payload: jwt.JwtPayload | string;
        try {
            if (typeof token !== 'string' || token.length > 4096) throw new Error('Invalid observation length');
            payload = jwt.verify(token, secret, { algorithms: ['HS256'], audience: AUDIENCE });
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            throw new ImageUpdateObservationError('IMAGE_UPDATE_OBSERVATION_STALE', 409);
        }
        if (typeof payload === 'string' || payload.contractVersion !== 1
            || payload.targetSessionId !== this.targetSessionId
            || typeof payload.requestNonce !== 'string' || !/^[a-f0-9]{32,128}$/.test(payload.requestNonce)
            || typeof payload.stack !== 'string' || !payload.stack
            || typeof payload.observationRevision !== 'number' || !Number.isSafeInteger(payload.observationRevision)
            || payload.observationRevision < 1
            || typeof payload.factsHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.factsHash)
            || typeof payload.jti !== 'string' || !/^[a-f0-9]{32}$/.test(payload.jti)
            || typeof payload.exp !== 'number' || typeof payload.iat !== 'number'
            || payload.iat > Math.floor(Date.now() / 1000)
            || payload.exp <= payload.iat || payload.exp - payload.iat > TTL_SECONDS
            || this.consumedJtis.has(payload.jti)) {
            throw new ImageUpdateObservationError('IMAGE_UPDATE_OBSERVATION_STALE', 409);
        }
        return {
            binding: {
                contractVersion: 1, requestNonce: payload.requestNonce, stack: payload.stack,
                observationRevision: payload.observationRevision, factsHash: payload.factsHash,
            },
            jti: payload.jti, expiresAt: payload.exp * 1000,
        };
    }

    verify(token: string, binding: ImageUpdateObservationBinding): { jti: string; expiresAt: number } {
        const verified = this.readVerified(token);
        const actual = verified.binding;
        if (binding.contractVersion !== actual.contractVersion || binding.requestNonce !== actual.requestNonce
            || binding.stack !== actual.stack || binding.observationRevision !== actual.observationRevision
            || binding.factsHash !== actual.factsHash) {
            throw new ImageUpdateObservationError('IMAGE_UPDATE_OBSERVATION_STALE', 409);
        }
        return { jti: verified.jti, expiresAt: verified.expiresAt };
    }

    verifyCurrent(token: string, expected: { stack: string }): ImageUpdateObservationBinding {
        const { binding } = this.readVerified(token);
        if (binding.stack !== expected.stack) {
            throw new ImageUpdateObservationError('IMAGE_UPDATE_OBSERVATION_STALE', 409);
        }
        return binding;
    }

    /** Compare fresh local facts under the stack lock, immediately before mutation. */
    consumeCurrent(token: string, expected: { stack: string; factsHash: string }): void {
        const binding = this.verifyCurrent(token, expected);
        if (binding.factsHash !== expected.factsHash) {
            throw new ImageUpdateObservationError('IMAGE_UPDATE_OBSERVATION_STALE', 409);
        }
        this.consume(token, binding);
    }

    consume(token: string, binding: ImageUpdateObservationBinding): void {
        const verified = this.verify(token, binding);
        const now = Date.now();
        for (const [jti, expiresAt] of this.consumedJtis) {
            if (expiresAt <= now) this.consumedJtis.delete(jti);
        }
        if (this.consumedJtis.size >= this.maxConsumedJtis) {
            throw new ImageUpdateObservationError('IMAGE_UPDATE_OBSERVATION_CAPACITY', 503);
        }
        this.consumedJtis.set(verified.jti, verified.expiresAt);
    }
}

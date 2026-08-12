/**
 * Unit tests for PilotAgent auth fallback event handling using a stub WebSocket.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const { wsInstances, mockAttachSwitchboard } = vi.hoisted(() => ({
    wsInstances: [] as Array<{
        emit: (event: string, ...args: unknown[]) => boolean;
        readyState: number;
        close: ReturnType<typeof vi.fn>;
        terminate: ReturnType<typeof vi.fn>;
        on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    }>,
    mockAttachSwitchboard: vi.fn(() => ({
        handleJsonFrame: vi.fn(() => false),
        handleBinaryFrame: vi.fn(() => false),
        cleanup: vi.fn(),
        tcpStreamCount: vi.fn(() => 0),
        openReverseStream: vi.fn(() => null),
    })),
}));

vi.mock('../mesh/tcpStreamSwitchboard', () => ({
    attachTcpStreamSwitchboard: mockAttachSwitchboard,
    resolveByComposeLabels: vi.fn(),
}));

vi.mock('ws', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter } = require('events') as typeof import('events');
    class MockWebSocket extends EventEmitter {
        readyState = 0;
        close = vi.fn();
        terminate = vi.fn();
        constructor(..._args: unknown[]) {
            super();
            wsInstances.push(this as never);
        }
    }
    return { default: MockWebSocket };
});

let tmpDir: string;
let PilotAgent: typeof import('../pilot/agent').PilotAgent;
let readPersistedToken: typeof import('../pilot/agent').readPersistedToken;
let persistToken: typeof import('../pilot/agent').persistToken;
let clearPersistedToken: typeof import('../pilot/agent').clearPersistedToken;
let isFreshEnrollToken: typeof import('../pilot/agent').isFreshEnrollToken;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({
        PilotAgent,
        readPersistedToken,
        persistToken,
        clearPersistedToken,
        isFreshEnrollToken,
    } = await import('../pilot/agent'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

function mintFreshEnroll(): string {
    return jwt.sign({ scope: 'pilot_enroll', nodeId: 1 }, 'unit-test-secret', { expiresIn: '15m' });
}

function mintExpiredEnroll(): string {
    // Explicit exp: negative expiresIn is unreliable in jsonwebtoken.
    return jwt.sign(
        { scope: 'pilot_enroll', nodeId: 1, exp: Math.floor(Date.now() / 1000) - 120 },
        'unit-test-secret',
    );
}

function emitUpgradeReject(
    ws: (typeof wsInstances)[number],
    status: number,
    reason?: string,
): void {
    const headers: Record<string, string> = {};
    if (reason) headers['x-sencho-pilot-reject'] = reason;
    ws.emit('unexpected-response', {}, {
        statusCode: status,
        headers,
        resume: vi.fn(),
    });
}

describe('isFreshEnrollToken', () => {
    it('accepts an unexpired pilot_enroll JWT', () => {
        expect(isFreshEnrollToken(mintFreshEnroll())).toBe(true);
    });

    it('rejects an expired pilot_enroll JWT', () => {
        expect(isFreshEnrollToken(mintExpiredEnroll())).toBe(false);
    });

    it('rejects a non-JWT string', () => {
        expect(isFreshEnrollToken('not-a-jwt')).toBe(false);
    });
});

describe('PilotAgent auth fallback (stub WebSocket)', () => {
    beforeEach(() => {
        wsInstances.length = 0;
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
        vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        clearPersistedToken();
    });

    it('swaps to a fresh enroll token after HTTP 401 and leaves pilot.jwt on disk', () => {
        persistToken('stale-on-disk');
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'stale-token',
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();

        const firstWs = wsInstances[0]!;
        emitUpgradeReject(firstWs, 401, 'invalid_token');

        expect(readPersistedToken()).toBe('stale-on-disk');
        expect((agent as unknown as { token: string }).token).toBe(enroll);
        // scheduleReconnect doubles backoff after scheduling the imminent retry.
        expect((agent as unknown as { backoff: number }).backoff).toBe(2_000);
    });

    it('swaps to the enroll token after HTTP 404 on upgrade', () => {
        persistToken('stale-on-disk');
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'stale-token',
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        emitUpgradeReject(wsInstances[0]!, 404, 'unknown_node');

        expect(readPersistedToken()).toBe('stale-on-disk');
        expect((agent as unknown as { token: string }).token).toBe(enroll);
    });

    it('does not swap when the enroll token is expired', () => {
        persistToken('stale-on-disk');
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'stale-token',
            enrollToken: mintExpiredEnroll(),
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        emitUpgradeReject(wsInstances[0]!, 401, 'invalid_token');

        expect(readPersistedToken()).toBe('stale-on-disk');
        expect((agent as unknown as { token: string }).token).toBe('stale-token');
    });

    it('does not swap on a clean close even with a fresh enroll token', () => {
        persistToken('good-on-disk');
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'good-token',
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        wsInstances[0]!.emit('close', 1000, Buffer.from(''));

        expect(readPersistedToken()).toBe('good-on-disk');
        expect((agent as unknown as { token: string }).token).toBe('good-token');
    });

    it('does not swap when already connecting with the enroll token', () => {
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: enroll,
            enrollToken: enroll,
            enrolling: true,
        });

        (agent as unknown as { connect: () => void }).connect();
        emitUpgradeReject(wsInstances[0]!, 401, 'enrollment_used');

        // Failed enroll dial with no prior tunnelToken leaves token as enroll.
        expect((agent as unknown as { token: string }).token).toBe(enroll);
    });

    it('restores the in-memory tunnel token when enroll fallback also 401s', () => {
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'tunnel-in-memory',
            enrollToken: enroll,
            enrolling: false,
        });
        // Simulate persist failure: no file on disk.
        clearPersistedToken();

        (agent as unknown as { connect: () => void }).connect();
        emitUpgradeReject(wsInstances[0]!, 401);
        expect((agent as unknown as { token: string }).token).toBe(enroll);

        // Advance into the reconnect attempt with the enroll token.
        vi.runOnlyPendingTimers();
        expect(wsInstances.length).toBe(2);
        emitUpgradeReject(wsInstances[1]!, 401, 'enrollment_used');

        expect((agent as unknown as { token: string }).token).toBe('tunnel-in-memory');
        expect(readPersistedToken()).toBeNull();
    });

    it('restores the tunnel token when the enroll dial drops without a 401/404', () => {
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'tunnel-in-memory',
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        emitUpgradeReject(wsInstances[0]!, 401);
        expect((agent as unknown as { token: string }).token).toBe(enroll);

        vi.runOnlyPendingTimers();
        // Clean close / network drop while dialing enroll (no rejectInfo).
        wsInstances[1]!.emit('close', 1006, Buffer.from(''));

        expect((agent as unknown as { token: string }).token).toBe('tunnel-in-memory');
    });

    it('still swaps when the reject reason is enrollment_used (header is diagnostic only)', () => {
        persistToken('stale-on-disk');
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'stale-token',
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        emitUpgradeReject(wsInstances[0]!, 401, 'enrollment_used');

        expect(readPersistedToken()).toBe('stale-on-disk');
        expect((agent as unknown as { token: string }).token).toBe(enroll);
    });

    it('does not swap on hub 403', () => {
        persistToken('good-on-disk');
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'good-token',
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        emitUpgradeReject(wsInstances[0]!, 403, 'bad_scope');

        expect(readPersistedToken()).toBe('good-on-disk');
        expect((agent as unknown as { token: string }).token).toBe('good-token');
    });

    it('does not double-schedule reconnect when a stale socket closes after the next connect', () => {
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'tunnel-token',
            enrollToken: mintFreshEnroll(),
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        const firstWs = wsInstances[0]!;
        emitUpgradeReject(firstWs, 401);
        const afterFirst = wsInstances.length;

        vi.runOnlyPendingTimers();
        expect(wsInstances.length).toBe(afterFirst + 1);

        // Late close from the first socket must be a no-op for reconnect.
        firstWs.emit('close', 1006, Buffer.from(''));
        const beforeAdvance = wsInstances.length;
        vi.runOnlyPendingTimers();
        expect(wsInstances.length).toBe(beforeAdvance);
    });

    it('keeps the tunnel token on opaque 401 when enroll is fresh (fallback still swaps in memory)', () => {
        persistToken('stale-on-disk');
        const enroll = mintFreshEnroll();
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'stale-token',
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        // No X-Sencho-Pilot-Reject header (proxy / older hub).
        emitUpgradeReject(wsInstances[0]!, 401);

        expect(readPersistedToken()).toBe('stale-on-disk');
        expect((agent as unknown as { token: string }).token).toBe(enroll);
        expect((agent as unknown as { backoff: number }).backoff).toBe(2_000);
    });
});

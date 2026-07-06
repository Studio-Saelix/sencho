/**
 * Unit tests for PilotAgent auth fallback event handling using a stub WebSocket.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const { wsInstances, mockAttachSwitchboard } = vi.hoisted(() => ({
    wsInstances: [] as Array<{
        emit: (event: string, ...args: unknown[]) => boolean;
        readyState: number;
        close: ReturnType<typeof vi.fn>;
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
        constructor(..._args: unknown[]) {
            super();
            wsInstances.push(this);
        }
    }
    return { default: MockWebSocket };
});

let tmpDir: string;
let PilotAgent: typeof import('../pilot/agent').PilotAgent;
let readPersistedToken: typeof import('../pilot/agent').readPersistedToken;
let persistToken: typeof import('../pilot/agent').persistToken;
let clearPersistedToken: typeof import('../pilot/agent').clearPersistedToken;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ PilotAgent, readPersistedToken, persistToken, clearPersistedToken } = await import('../pilot/agent'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('PilotAgent auth fallback (stub WebSocket)', () => {
    beforeEach(() => {
        wsInstances.length = 0;
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
        vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        clearPersistedToken();
    });

    it('swaps to the enroll token and clears pilot.jwt after HTTP 401 on upgrade', () => {
        persistToken('stale-on-disk');
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'stale-token',
            enrollToken: 'fresh-enroll-token',
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();

        const firstWs = wsInstances[0]!;
        // Real ws (no unexpected-response listener): abortHandshake emits error then close.
        firstWs.emit('error', new Error('Unexpected server response: 401'));
        firstWs.emit('close', 1006, Buffer.from(''));

        expect(readPersistedToken()).toBeNull();
        expect((agent as unknown as { token: string }).token).toBe('fresh-enroll-token');
        // scheduleReconnect doubles backoff after scheduling the imminent retry.
        expect((agent as unknown as { backoff: number }).backoff).toBe(2_000);
    });

    it('swaps to the enroll token after HTTP 404 on upgrade', () => {
        persistToken('stale-on-disk');
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'stale-token',
            enrollToken: 'fresh-enroll-token',
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();

        const firstWs = wsInstances[0]!;
        firstWs.emit('error', new Error('Unexpected server response: 404'));
        firstWs.emit('close', 1006, Buffer.from(''));

        expect(readPersistedToken()).toBeNull();
        expect((agent as unknown as { token: string }).token).toBe('fresh-enroll-token');
    });

    it('does not swap when already connecting with the enroll token', () => {
        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 1,
            initialToken: 'only-enroll-token',
            enrollToken: 'only-enroll-token',
            enrolling: true,
        });

        (agent as unknown as { connect: () => void }).connect();

        const firstWs = wsInstances[0]!;
        firstWs.emit('error', new Error('Unexpected server response: 401'));
        firstWs.emit('close', 1006, Buffer.from(''));

        expect((agent as unknown as { token: string }).token).toBe('only-enroll-token');
    });
});

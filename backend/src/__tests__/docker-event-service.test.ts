/**
 * Unit tests for DockerEventService.
 *
 * Mocks the Docker client stream via a small helper that exposes push() and
 * error() hooks so tests can drive the stream deterministically. Focuses on:
 *   - classification of kill / die / oom / health_status
 *   - the 500ms grace window for out-of-order die events
 *   - rate limiting and overflow summary
 *   - reconciliation on connect (baseline vs gap exits)
 *   - mass-event detection on reconnect
 *   - reconnect backoff + one-time warning/info alerts
 *   - malformed payload tolerance
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
    mockDispatchAlert,
    mockBroadcastEvent,
    mockGetGlobalSettings,
    mockGetEvents,
    mockListContainers,
    mockInspect,
    mockGetContainer,
    mockGetDocker,
    mockIsOwnContainer,
} = vi.hoisted(() => ({
    mockDispatchAlert: vi.fn().mockResolvedValue(undefined),
    mockBroadcastEvent: vi.fn(),
    mockGetGlobalSettings: vi.fn().mockReturnValue({ global_crash: '1' }),
    mockGetEvents: vi.fn(),
    mockListContainers: vi.fn().mockResolvedValue([]),
    mockInspect: vi.fn().mockResolvedValue({}),
    mockGetContainer: vi.fn(),
    mockGetDocker: vi.fn(),
    mockIsOwnContainer: vi.fn().mockReturnValue(false),
}));

vi.mock('../services/NotificationService', () => ({
    NotificationService: {
        getInstance: () => ({
            dispatchAlert: mockDispatchAlert,
            broadcastEvent: mockBroadcastEvent,
        }),
    },
}));

vi.mock('../services/DatabaseService', () => ({
    DatabaseService: {
        getInstance: () => ({ getGlobalSettings: mockGetGlobalSettings }),
    },
}));

vi.mock('../services/NodeRegistry', () => ({
    NodeRegistry: {
        getInstance: () => ({ getDocker: mockGetDocker }),
    },
}));

vi.mock('../services/SelfIdentityService', () => ({
    default: {
        getInstance: () => ({
            isOwnContainer: mockIsOwnContainer,
        }),
    },
}));

// ── Fake Docker stream helper ──────────────────────────────────────────

interface FakeStream extends EventEmitter {
    destroyed: boolean;
    destroy: () => void;
    push: (event: Record<string, unknown>) => void;
    pushRaw: (raw: string) => void;
    error: (err: Error) => void;
}

function makeStream(): FakeStream {
    const ee = new EventEmitter() as FakeStream;
    ee.destroyed = false;
    ee.destroy = () => { ee.destroyed = true; };
    ee.push = (event) => ee.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    ee.pushRaw = (raw) => ee.emit('data', Buffer.from(raw));
    ee.error = (err) => ee.emit('error', err);
    return ee;
}

// ── Setup ──────────────────────────────────────────────────────────────

import { DockerEventService } from '../services/DockerEventService';

let stream: FakeStream;
let service: DockerEventService;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetGlobalSettings.mockReturnValue({ global_crash: '1' });
    mockIsOwnContainer.mockReset();
    mockIsOwnContainer.mockReturnValue(false);

    stream = makeStream();
    mockGetEvents.mockImplementation(async () => stream);
    mockListContainers.mockResolvedValue([]);
    mockGetContainer.mockImplementation((id: string) => ({
        inspect: () => mockInspect(id),
    }));
    mockGetDocker.mockReturnValue({
        getEvents: mockGetEvents,
        listContainers: mockListContainers,
        getContainer: mockGetContainer,
    });
});

afterEach(() => {
    service?.shutdown();
    vi.useRealTimers();
});

// ── Classification via event stream ────────────────────────────────────

describe('DockerEventService - die classification', () => {
    it('emits crash alert on die with non-zero exit code and no prior kill', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c1', Attributes: { exitCode: '1', name: 'web' } },
            time: 1700000000,
        });
        await vi.advanceTimersByTimeAsync(600); // past the 500ms grace window

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Container Crash Detected'),
            expect.objectContaining({ containerName: 'web' }),
        );
    });

    it('stamps a crash signal and clears it on a later clean exit', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // Crash: non-zero exit, no prior kill.
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-clean', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(service.getContainerState('c-clean')?.crashedAt).toBeTypeOf('number');

        // A subsequent clean exit (code 0) must wipe the stale crash signal.
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-clean', Attributes: { exitCode: '0', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(service.getContainerState('c-clean')?.crashedAt).toBeUndefined();
    });

    it('does not stamp a crash for a die that was superseded by a start', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // Establish tracked state so the later start is recorded.
        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'c-race', Attributes: { name: 'web' } },
        });
        // Crash, then restart strictly later but still within the 500ms grace
        // window before the die is classified.
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-race', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(100);
        stream.push({
            Type: 'container',
            Action: 'start',
            Actor: { ID: 'c-race', Attributes: { name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(service.getContainerState('c-race')?.crashedAt).toBeUndefined();
    });

    it('keeps stack and container routing for non-self compose crashes', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: {
                ID: 'app-id',
                Attributes: {
                    exitCode: '1',
                    name: 'web',
                    'com.docker.compose.project': 'web-stack',
                },
            },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Container Crash Detected'),
            expect.objectContaining({ stackName: 'web-stack', containerName: 'web' }),
        );
    });

    it('routes self-container crashes as system-only notifications', async () => {
        mockIsOwnContainer.mockImplementation((idOrName: string) =>
            idOrName === 'self-id' || idOrName === 'sencho',
        );
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: {
                ID: 'self-id',
                Attributes: {
                    exitCode: '1',
                    name: 'sencho',
                    'com.docker.compose.project': 'sencho',
                },
            },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Container Crash Detected'),
            { actor: 'system:docker-events' },
        );
    });

    it('does not emit when die follows a recent kill (intentional)', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'kill',
            Actor: { ID: 'c1', Attributes: { signal: '15' } },
            time: 1700000000,
        });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c1', Attributes: { exitCode: '1', name: 'web' } },
            time: 1700000001,
        });
        await vi.advanceTimersByTimeAsync(600);

        const crashCall = mockDispatchAlert.mock.calls.find(c =>
            typeof c[2] === 'string' && c[2].includes('Crash'));
        expect(crashCall).toBeUndefined();
    });

    it('reclassifies as intentional when kill arrives within the 500ms grace window', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // die first, kill 200ms later
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c2', Attributes: { exitCode: '1', name: 'svc' } },
            time: 1700000000,
        });
        await vi.advanceTimersByTimeAsync(200);
        stream.push({
            Type: 'container',
            Action: 'kill',
            Actor: { ID: 'c2', Attributes: { signal: '15' } },
            time: 1700000001,
        });
        await vi.advanceTimersByTimeAsync(400); // total > 500ms

        const crashCall = mockDispatchAlert.mock.calls.find(c =>
            typeof c[2] === 'string' && c[2].includes('Crash'));
        expect(crashCall).toBeUndefined();
    });

    it('emits OOM alert when oom precedes die', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({ Type: 'container', Action: 'oom', Actor: { ID: 'c3', Attributes: { name: 'hog' } } });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c3', Attributes: { exitCode: '137', name: 'hog' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('OOM Kill'),
            expect.objectContaining({ containerName: 'hog' }),
        );
    });

    it('does not emit when exit code is 0 (clean exit)', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c4', Attributes: { exitCode: '0', name: 'oneshot' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).not.toHaveBeenCalled();
    });

    it('emits unhealthy alert on health_status: unhealthy', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'c5', Attributes: { name: 'api' } },
        });
        await vi.runOnlyPendingTimersAsync();

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Healthcheck failed'),
            expect.objectContaining({ containerName: 'api' }),
        );
    });

    it('routes self-container unhealthy alerts as system-only notifications', async () => {
        mockIsOwnContainer.mockImplementation((idOrName: string) =>
            idOrName === 'self-id' || idOrName === 'sencho',
        );
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: {
                ID: 'self-id',
                Attributes: {
                    name: 'sencho',
                    'com.docker.compose.project': 'sencho',
                },
            },
        });

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Healthcheck failed'),
            { actor: 'system:docker-events' },
        );
    });

    it('does not emit when global_crash is disabled', async () => {
        mockGetGlobalSettings.mockReturnValue({ global_crash: '0' });
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c6', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).not.toHaveBeenCalled();
    });

    it('clears crash dedup when container starts again', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // First crash
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c7', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Start event clears dedup
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c7' } });

        // Second crash should fire again
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c7', Attributes: { exitCode: '2', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });
});

// ── Rate limiting ──────────────────────────────────────────────────────

describe('DockerEventService - rate limiting', () => {
    it('batches overflow crashes into a single summary alert', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // Push 22 die events (limit is 20).
        for (let i = 0; i < 22; i++) {
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: { ID: `c-${i}`, Attributes: { exitCode: '1', name: `n-${i}` } },
            });
        }
        await vi.advanceTimersByTimeAsync(600);

        const crashCalls = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('Crash'));
        expect(crashCalls).toHaveLength(20);

        // After the rate window, a summary warning fires.
        await vi.advanceTimersByTimeAsync(61_000);
        const summaryCalls = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('additional containers crashed'));
        expect(summaryCalls).toHaveLength(1);
        expect(summaryCalls[0][2]).toContain('2 additional');
    });
});

// ── Malformed payloads ─────────────────────────────────────────────────

describe('DockerEventService - malformed payloads', () => {
    it('tolerates a bad JSON line without tearing down the stream', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.pushRaw('not json\n');
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'ok', Attributes: { exitCode: '1', name: 'ok' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Container Crash Detected'),
            expect.objectContaining({ containerName: 'ok' }),
        );
    });
});

// ── Reconciliation ─────────────────────────────────────────────────────

describe('DockerEventService - reconciliation', () => {
    it('on first boot, records pre-existing exited containers as baseline and does not alert', async () => {
        mockListContainers.mockResolvedValue([
            { Id: 'pre-1', State: 'exited' },
            { Id: 'pre-2', State: 'exited' },
            { Id: 'run-1', State: 'running' },
        ]);

        service = new DockerEventService(1, 'local');
        await service.start();

        expect(mockDispatchAlert).not.toHaveBeenCalled();
    });

    it('emits mass-event summary on reconnect when >20% of containers newly exited', async () => {
        // First connect: 10 running containers as baseline.
        const running = Array.from({ length: 10 }, (_, i) => ({
            Id: `c-${i}`,
            State: 'running',
        }));
        mockListContainers.mockResolvedValueOnce(running);

        service = new DockerEventService(1, 'local');
        await service.start();

        // Simulate stream drop.
        stream.error(new Error('connection reset'));
        stream = makeStream();
        mockGetEvents.mockImplementation(async () => stream);

        // On reconnect: 5 of them now exited (>20%).
        const mixed = running.map((c, i) => ({
            Id: c.Id,
            State: i < 5 ? 'exited' : 'running',
        }));
        mockListContainers.mockResolvedValueOnce(mixed);

        // Drain reconnect backoff + reconciliation.
        await vi.advanceTimersByTimeAsync(2_000);
        // Flush microtasks spawned by the async reconnect + reconcile chain
        // without running the recurring prune interval.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const massCall = mockDispatchAlert.mock.calls.find(c =>
            typeof c[2] === 'string' && c[2].includes('daemon interruption'));
        expect(massCall).toBeDefined();
    });

    it('classifies individual gap exits on reconnect when below mass threshold', async () => {
        // Baseline: 10 containers running.
        const baseline = Array.from({ length: 10 }, (_, i) => ({
            Id: `c-${i}`,
            State: 'running',
        }));
        mockListContainers.mockResolvedValueOnce(baseline);

        service = new DockerEventService(1, 'local');
        await service.start();

        // Drop + one new exit (10%, below 20% threshold).
        stream.error(new Error('bad'));
        stream = makeStream();
        mockGetEvents.mockImplementation(async () => stream);

        const postReconnect = baseline.map((c, i) => ({
            Id: c.Id,
            State: i === 0 ? 'exited' : 'running',
        }));
        mockListContainers.mockResolvedValueOnce(postReconnect);

        mockInspect.mockResolvedValueOnce({
            Name: '/crashed-app',
            State: { ExitCode: 9, OOMKilled: false },
            Config: { Labels: { 'com.docker.compose.project': 'my-stack' } },
        });

        await vi.advanceTimersByTimeAsync(2_000);
        // Flush microtasks spawned by the async reconnect + reconcile chain
        // without running the recurring prune interval.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const crashCall = mockDispatchAlert.mock.calls.find(c =>
            typeof c[2] === 'string' && c[2].includes('crashed-app'));
        expect(crashCall).toBeDefined();
        expect(crashCall?.[3]).toMatchObject({ stackName: 'my-stack' });
    });
});

// ── Reconnect lifecycle ────────────────────────────────────────────────

describe('DockerEventService - reconnect', () => {
    it('emits one-time warning on first disconnect and info on reconnect', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.error(new Error('connection reset'));

        // Reconnect succeeds immediately after backoff.
        stream = makeStream();
        mockGetEvents.mockImplementation(async () => stream);

        await vi.advanceTimersByTimeAsync(2_000);
        // Flush microtasks spawned by the async reconnect + reconcile chain
        // without running the recurring prune interval.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const warn = mockDispatchAlert.mock.calls.find(c => c[0] === 'warning');
        const info = mockDispatchAlert.mock.calls.find(c => c[0] === 'info');
        expect(warn?.[2]).toContain('Lost connection');
        expect(info?.[2]).toContain('Reconnected');
    });

    it('shutdown cancels pending reconnect', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.error(new Error('broken'));
        mockGetEvents.mockClear();
        service.shutdown();

        // Advance time well past the first backoff window; no new connect should run.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mockGetEvents).not.toHaveBeenCalled();
    });
});

// ── Hardening: gap isolation / OOM fallback / concurrent dies ─────────

describe('DockerEventService - hardening', () => {
    it('isolates failures inside classifyGap so one bad inspect does not abort the batch', async () => {
        // 1 exit out of 10 (10%) stays below the 20% mass-event threshold, so
        // the gap classifier inspects the container individually. That inspect
        // fails; the service must isolate the failure and still classify a
        // subsequent die as a crash.
        const baseline = Array.from({ length: 10 }, (_, i) => ({
            Id: `c-${i}`,
            State: 'running',
        }));
        mockListContainers.mockResolvedValueOnce(baseline);

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.error(new Error('broken'));
        stream = makeStream();
        mockGetEvents.mockImplementation(async () => stream);

        const postReconnect = baseline.map((c, i) => ({
            Id: c.Id,
            State: i < 1 ? 'exited' : 'running',
        }));
        mockListContainers.mockResolvedValueOnce(postReconnect);
        mockInspect.mockRejectedValueOnce(new Error('gone'));

        await vi.advanceTimersByTimeAsync(2_000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        mockDispatchAlert.mockClear();
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'post-recovery', Attributes: { exitCode: '1', name: 'app' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Container Crash Detected'),
            expect.objectContaining({ containerName: 'app' }),
        );
    });

    it('classifies exit code 137 as OOM when container inspect reports OOMKilled (no oom event)', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // Inspect fallback: no prior `oom` event, but the container's
        // State.OOMKilled is true.
        mockInspect.mockResolvedValueOnce({
            State: { OOMKilled: true, ExitCode: 137 },
        });

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'cgroup-killed', Attributes: { exitCode: '137', name: 'hog' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        // Allow the awaited inspect in classifyDie to resolve.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const oomCall = mockDispatchAlert.mock.calls.find(c =>
            typeof c[2] === 'string' && c[2].includes('OOM Kill'));
        const crashCall = mockDispatchAlert.mock.calls.find(c =>
            typeof c[2] === 'string' && c[2].includes('Crash Detected'));
        expect(oomCall).toBeDefined();
        expect(crashCall).toBeUndefined();
    });

    it('falls back to crash when exit 137 die inspect fails', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        mockInspect.mockRejectedValueOnce(new Error('no such container'));

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'gone', Attributes: { exitCode: '137', name: 'ephemeral' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Inspect failed, so classification stays as the original 'crash'.
        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Container Crash Detected'),
            expect.objectContaining({ containerName: 'ephemeral' }),
        );
    });

    it('collapses duplicate die events for the same container within the grace window', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // Two dies for the same container within 500ms: the second cancels
        // the first pending timer and reschedules. Exactly one crash alert
        // must fire, using the later exit code.
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'dup', Attributes: { exitCode: '1', name: 'dup' } },
        });
        await vi.advanceTimersByTimeAsync(100);
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'dup', Attributes: { exitCode: '2', name: 'dup' } },
        });
        await vi.advanceTimersByTimeAsync(700);

        const crashCalls = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('Crash Detected'));
        expect(crashCalls).toHaveLength(1);
        expect(crashCalls[0][2]).toContain('Code: 2');
    });
});

// ── State-invalidate broadcasts ────────────────────────────────────────

describe('DockerEventService - state-invalidate broadcasts', () => {
    it('broadcasts state-invalidate on container start', async () => {
        service = new DockerEventService(7, 'node-7');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'start',
            Actor: { ID: 'aaa', Attributes: { 'com.docker.compose.project': 'web' } },
            time: 1,
        });
        await vi.advanceTimersByTimeAsync(1);

        expect(mockBroadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'state-invalidate',
            scope: 'stack',
            nodeId: 7,
            stackName: 'web',
            containerId: 'aaa',
            action: 'start',
        }));
    });

    it('does not broadcast stack state-invalidate for Sencho self-container events', async () => {
        mockIsOwnContainer.mockImplementation((idOrName: string) =>
            idOrName === 'self-id' || idOrName === 'sencho',
        );
        service = new DockerEventService(7, 'node-7');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'start',
            Actor: {
                ID: 'self-id',
                Attributes: {
                    name: 'sencho',
                    'com.docker.compose.project': 'sencho',
                },
            },
            time: 1,
        });
        await vi.advanceTimersByTimeAsync(1);

        expect(mockBroadcastEvent).not.toHaveBeenCalled();
    });

    it('broadcasts state-invalidate on health_status:unhealthy', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'bbb', Attributes: { 'com.docker.compose.project': 'api' } },
            time: 1,
        });
        await vi.advanceTimersByTimeAsync(1);

        const states = mockBroadcastEvent.mock.calls.filter(c =>
            (c[0] as { type?: string }).type === 'state-invalidate');
        expect(states.length).toBeGreaterThan(0);
        expect(states[0][0]).toMatchObject({ action: 'health_status', stackName: 'api' });
    });

    it('does not broadcast state-invalidate on non-state actions like exec_create', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'exec_create: /bin/sh',
            Actor: { ID: 'ccc' },
            time: 1,
        });
        await vi.advanceTimersByTimeAsync(1);

        expect(mockBroadcastEvent).not.toHaveBeenCalled();
    });
});

// ── Diagnostics ────────────────────────────────────────────────────────

describe('DockerEventService - getStatus', () => {
    it('reports connected after start', async () => {
        service = new DockerEventService(42, 'my-node');
        await service.start();

        const status = service.getStatus();
        expect(status.nodeId).toBe(42);
        expect(status.nodeName).toBe('my-node');
        expect(status.status).toBe('connected');
    });
});

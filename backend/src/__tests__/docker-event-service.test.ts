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
    mockDispatchAlert: vi.fn().mockResolvedValue({ persisted: true }),
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
import { CacheService } from '../services/CacheService';

let stream: FakeStream;
let service: DockerEventService;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDispatchAlert.mockReset();
    mockDispatchAlert.mockResolvedValue({ persisted: true });
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

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

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
            'Container Crash Detected: web exited unexpectedly (Code: 1).',
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
        // A short run that is already back is a recovered blip, not a crash to report.
        expect(mockDispatchAlert).not.toHaveBeenCalled();
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
            // A self-container alert stays system-only: it names no stack, so no
            // routing key can apply, and it carries the node that raised it.
            expect.objectContaining({ actor: 'system:docker-events' }),
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
        await flushMicrotasks();

        expect(mockDispatchAlert).toHaveBeenCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('Healthcheck failed'),
            expect.objectContaining({ actor: 'system:docker-events' }),
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

    it('alerts once for a restart loop that keeps crash-looping', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // Docker emits start on every restart-policy restart; each lap is a
        // fraction of the recovery threshold, so it stays one incident.
        for (let lap = 0; lap < 3; lap++) {
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: { ID: 'c-loop', Attributes: { exitCode: '1', name: 'web' } },
            });
            await vi.advanceTimersByTimeAsync(600);
            stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-loop', Attributes: { name: 'web' } } });
            await vi.advanceTimersByTimeAsync(2_000);
        }

        const crashCalls = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('Crash'));
        expect(crashCalls).toHaveLength(1);
    });

    it('alerts again when a container crashed after a stable run', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-rec', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // It recovered and ran for the full threshold before dying again, so
        // this is a new incident rather than another lap.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-rec', Attributes: { name: 'web' } } });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-rec', Attributes: { exitCode: '2', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('alerts once when a stable-run crash die is redelivered unchanged', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const die = (id: string, atSeconds: number, exitCode = '1') => ({
            Type: 'container',
            Action: 'die',
            Actor: { ID: id, Attributes: { exitCode, name: 'web' } },
            time: atSeconds,
        });

        // First crash establishes the loop window.
        stream.push(die('c-dup', 1_000));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // It recovered and ran the full threshold, so this crash is a new
        // incident and earns an alert.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-dup', Attributes: { name: 'web' } }, time: 1_001 });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push(die('c-dup', 1_302));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);

        // Docker redelivers the identical die event. Same run, same incident:
        // its recovery evidence was consumed by the dispatched alert.
        stream.push(die('c-dup', 1_302));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);

        // A later distinct start that also runs the threshold is a new incident.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-dup', Attributes: { name: 'web' } }, time: 2_000 });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push(die('c-dup', 2_302));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(3);
    });

    it('alerts once when a stable-run OOM die is redelivered unchanged', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();
        mockInspect.mockResolvedValue({ State: { OOMKilled: true, ExitCode: 137 } });

        const oomDie = (atSeconds: number) => ({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-oom-dup', Attributes: { exitCode: '137', name: 'hog' } },
            time: atSeconds,
        });
        const oomAlerts = () => mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('OOM Kill')).length;

        stream.push(oomDie(1_000));
        await vi.advanceTimersByTimeAsync(600);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(oomAlerts()).toBe(1);

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-oom-dup', Attributes: { name: 'hog' } }, time: 1_001 });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push(oomDie(1_302));
        await vi.advanceTimersByTimeAsync(600);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(oomAlerts()).toBe(2);

        stream.push(oomDie(1_302));
        await vi.advanceTimersByTimeAsync(600);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(oomAlerts()).toBe(2);
    });

    it('does not alert twice when an identical die overlaps an in-flight OOM inspect', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        let resolveInspect!: (value: unknown) => void;
        mockInspect.mockImplementation(() => new Promise(resolve => { resolveInspect = resolve; }));

        const oomDie = {
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-oom-overlap', Attributes: { exitCode: '137', name: 'hog' } },
            time: 1_302,
        };

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-oom-overlap', Attributes: { name: 'hog' } }, time: 1_000 });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push(oomDie);
        // The 500 ms grace window elapsed and classification is parked on the
        // OOM inspect, before it can stamp the incident.
        await vi.advanceTimersByTimeAsync(600);

        // The same die is redelivered while that inspect is still in flight.
        stream.push(oomDie);
        await vi.advanceTimersByTimeAsync(600);

        resolveInspect({ State: { OOMKilled: true, ExitCode: 137 } });
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();

        const oomAlerts = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('OOM Kill'));
        expect(oomAlerts).toHaveLength(1);
        expect(mockInspect).toHaveBeenCalledTimes(1);
    });

    it('collapses two distinct dies from one run that overlap in flight', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const resolvers: Array<(value: unknown) => void> = [];
        mockInspect.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));

        const oomDie = (atSeconds: number) => ({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-oom-ab', Attributes: { exitCode: '137', name: 'hog' } },
            time: atSeconds,
        });

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-oom-ab', Attributes: { name: 'hog' } }, time: 1_000 });
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        stream.push(oomDie(1_302));
        await vi.advanceTimersByTimeAsync(600);
        // A distinct die starts while the first inspect is still parked.
        stream.push(oomDie(1_303));
        await vi.advanceTimersByTimeAsync(600);
        // The first die is redelivered while both are in flight.
        stream.push(oomDie(1_302));
        await vi.advanceTimersByTimeAsync(600);

        expect(mockInspect).toHaveBeenCalledTimes(2);
        for (const resolve of resolvers) resolve({ State: { OOMKilled: true, ExitCode: 137 } });
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();

        // Both dies belong to the same run (one start); whichever finishes
        // first stamps the incident and the other stays deduped.
        const oomAlerts = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('OOM Kill'));
        expect(oomAlerts).toHaveLength(1);
        expect(mockInspect).toHaveBeenCalledTimes(2);
    });

    it('alerts once when a second lap with an ordinary exit overlaps an in-flight OOM inspect', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        let resolveInspect!: (value: unknown) => void;
        mockInspect.mockImplementation(() => new Promise(resolve => { resolveInspect = resolve; }));

        const crashAlerts = () => mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && (c[2].includes('Crash') || c[2].includes('OOM Kill'))).length;

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-lap', Attributes: { name: 'web' } }, time: 1_000 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-lap', Attributes: { exitCode: '137', name: 'web' } },
            time: 1_002,
        });
        // The 500 ms grace window elapsed and the first lap is parked on its
        // OOM inspect, before it can stamp the incident.
        await vi.advanceTimersByTimeAsync(600);

        // The container restarts and dies again while that inspect is pending,
        // on the ordinary crash path (no await of its own).
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-lap', Attributes: { name: 'web' } }, time: 1_003 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-lap', Attributes: { exitCode: '1', name: 'web' } },
            time: 1_005,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(1);

        // The parked lap revalidates against the stamp the second one wrote.
        resolveInspect({ State: { OOMKilled: true, ExitCode: 137 } });
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
        expect(crashAlerts()).toBe(1);
    });

    it.each([
        { label: 'the earlier inspect finishes first', finishSecondFirst: false },
        { label: 'the later inspect finishes first', finishSecondFirst: true },
    ])('alerts once when a second OOM lap overlaps an in-flight OOM inspect ($label)', async ({ finishSecondFirst }) => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const resolvers: Array<(value: unknown) => void> = [];
        mockInspect.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));

        const oomDie = (atSeconds: number) => ({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-lap-oom', Attributes: { exitCode: '137', name: 'hog' } },
            time: atSeconds,
        });
        const crashAlerts = () => mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && (c[2].includes('Crash') || c[2].includes('OOM Kill'))).length;

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-lap-oom', Attributes: { name: 'hog' } }, time: 1_000 });
        stream.push(oomDie(1_002));
        await vi.advanceTimersByTimeAsync(600);
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-lap-oom', Attributes: { name: 'hog' } }, time: 1_003 });
        stream.push(oomDie(1_005));
        await vi.advanceTimersByTimeAsync(600);
        expect(resolvers).toHaveLength(2);

        const order = finishSecondFirst ? [resolvers[1], resolvers[0]] : resolvers;
        for (const resolve of order) {
            resolve({ State: { OOMKilled: true, ExitCode: 137 } });
            await vi.advanceTimersByTimeAsync(0);
            await flushMicrotasks();
        }

        expect(crashAlerts()).toBe(1);
    });

    it.each([
        { label: 'an ordinary exit with second timestamps', exitCode: '1', clock: 'time' },
        { label: 'an inspected OOM exit with second timestamps', exitCode: '137', clock: 'time' },
        { label: 'an ordinary exit with nanosecond timestamps', exitCode: '1', clock: 'timeNano' },
        { label: 'an inspected OOM exit with nanosecond timestamps', exitCode: '137', clock: 'timeNano' },
    ])('keeps an older incident closed when its start and die are replayed ($label)', async ({ exitCode, clock }) => {
        service = new DockerEventService(1, 'local');
        await service.start();
        mockInspect.mockResolvedValue({ State: { OOMKilled: true, ExitCode: 137 } });

        const stamp = (atSeconds: number) => (clock === 'time'
            ? { time: atSeconds }
            : { timeNano: atSeconds * 1_000_000_000 });
        const start = (atSeconds: number) => ({
            Type: 'container',
            Action: 'start',
            Actor: { ID: 'c-replay', Attributes: { name: 'web' } },
            ...stamp(atSeconds),
        });
        const die = (atSeconds: number) => ({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-replay', Attributes: { exitCode, name: 'web' } },
            ...stamp(atSeconds),
        });
        const crashAlerts = () => mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && (c[2].includes('Crash') || c[2].includes('OOM Kill'))).length;

        // Two separate recovered incidents, each after a stable run.
        stream.push(start(1_000));
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push(die(1_302));
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(1);

        stream.push(start(2_000));
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push(die(2_302));
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(2);
        const inspected = mockInspect.mock.calls.length;

        // A delayed redelivery of the older pair must neither reopen that
        // incident nor rewind the current run's start evidence.
        stream.push(start(1_000));
        stream.push(die(1_302));
        await vi.advanceTimersByTimeAsync(600);
        await flushMicrotasks();

        expect(crashAlerts()).toBe(2);
        expect(mockInspect.mock.calls.length).toBe(inspected);
        const state = (service as unknown as {
            containerState: Map<string, { lastStartAt?: number }>;
        }).containerState.get('c-replay');
        expect(state?.lastStartAt).toBe(2_000_000);
    });

    it('keeps a stable-run alert eligible when the dispatch was rate-suppressed', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const targetAlerts = () => mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('Crash Detected') && c[2].includes('quiet')).length;

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-suppressed', Attributes: { name: 'quiet' } }, time: 1_000 });
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        // Exhaust the shared one-minute window with unrelated crashes.
        for (let i = 0; i < 20; i++) {
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: { ID: `noise-${i}`, Attributes: { exitCode: '1', name: `noise-${i}` } },
            });
            await vi.advanceTimersByTimeAsync(600);
        }
        expect(targetAlerts()).toBe(0);
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-suppressed', Attributes: { exitCode: '1', name: 'quiet' } },
            time: 1_302,
        });
        await vi.advanceTimersByTimeAsync(600);
        // Rate-suppressed, so nothing is dispatched or consumed.
        expect(targetAlerts()).toBe(0);

        // Next window: the same die is still eligible because the suppressed
        // dispatch did not consume its recovery evidence.
        await vi.advanceTimersByTimeAsync(61_000);
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-suppressed', Attributes: { exitCode: '1', name: 'quiet' } },
            time: 1_302,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(targetAlerts()).toBe(1);
    });

    it('measures uptime from a restart that lands inside the die grace window', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        // Nothing tracked yet, so classifyDie creates the state 500 ms after the
        // die and the restart-policy start arrives first. That start is still the
        // uptime baseline, or a container that genuinely recovered stays muted.
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-race', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(100);
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-race', Attributes: { name: 'web' } } });
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-race', Attributes: { exitCode: '2', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('treats exactly the recovery threshold as a stable run and one tick under as a loop', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const crash = (id: string, exitCode: string) => ({
            Type: 'container',
            Action: 'die',
            Actor: { ID: id, Attributes: { exitCode, name: 'web' } },
        });

        // Boundary: exactly 5 minutes of uptime alerts.
        stream.push(crash('c-exact', '1'));
        await vi.advanceTimersByTimeAsync(600);
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-exact', Attributes: { name: 'web' } } });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        stream.push(crash('c-exact', '1'));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);

        // One tick under stays inside the loop's dedup window.
        stream.push(crash('c-under', '1'));
        await vi.advanceTimersByTimeAsync(600);
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-under', Attributes: { name: 'web' } } });
        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
        stream.push(crash('c-under', '1'));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(3);
    });

    it('alerts a stable-run crash when the restart-policy restart beats the classifier', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const containerEvent = (action: string, atMs: number, attributes: Record<string, string> = {}) => ({
            Type: 'container',
            Action: action,
            Actor: { ID: 'c-policy', Attributes: { exitCode: '1', name: 'web', ...attributes } },
            timeNano: atMs * 1_000_000,
        });

        // First crash establishes the loop's alert window.
        stream.push(containerEvent('die', 1_000_000));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Docker restarts a policy container about 100 ms after a die, inside
        // the 500 ms grace window.
        stream.push(containerEvent('start', 1_000_175));
        await vi.advanceTimersByTimeAsync(0);

        // It ran 320 s and crashed, and the restart again lands before the
        // deferred classification: a stable run earns a new incident regardless.
        await vi.advanceTimersByTimeAsync(320_000);
        stream.push(containerEvent('die', 1_320_175));
        await vi.advanceTimersByTimeAsync(175);
        stream.push(containerEvent('start', 1_320_350));
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('keeps the new stable-run incident closed when its die is redelivered after the restart', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const containerEvent = (action: string, atMs: number) => ({
            Type: 'container',
            Action: action,
            Actor: { ID: 'c-policy-dup', Attributes: { exitCode: '1', name: 'web' } },
            timeNano: atMs * 1_000_000,
        });

        stream.push(containerEvent('die', 1_000_000));
        await vi.advanceTimersByTimeAsync(600);
        stream.push(containerEvent('start', 1_000_175));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(320_000);
        stream.push(containerEvent('die', 1_320_175));
        await vi.advanceTimersByTimeAsync(175);
        stream.push(containerEvent('start', 1_320_350));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);

        // Docker redelivers the identical die after the restart. The new
        // incident was already alerted, so its recovery evidence is consumed.
        stream.push(containerEvent('die', 1_320_175));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('alerts a stable-run OOM when the restart-policy restart beats the classifier', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const containerEvent = (action: string, atMs: number) => ({
            Type: 'container',
            Action: action,
            Actor: { ID: 'c-policy-oom', Attributes: { exitCode: '137', name: 'hog' } },
            timeNano: atMs * 1_000_000,
        });

        stream.push(containerEvent('die', 1_000_000));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        stream.push(containerEvent('start', 1_000_175));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(320_000);
        stream.push(containerEvent('oom', 1_320_100));
        stream.push(containerEvent('die', 1_320_175));
        await vi.advanceTimersByTimeAsync(175);
        stream.push(containerEvent('start', 1_320_350));
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
        expect(mockDispatchAlert).toHaveBeenLastCalledWith(
            'error',
            'monitor_alert',
            expect.stringContaining('OOM Kill'),
            expect.objectContaining({ containerName: 'hog' }),
        );
    });

    it('alerts a loop again after the window when every restart beats the classifier', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const containerEvent = (action: string, atMs: number, exitCode = '1') => ({
            Type: 'container',
            Action: action,
            Actor: { ID: 'c-policy-hour', Attributes: { exitCode, name: 'web' } },
            timeNano: atMs * 1_000_000,
        });

        // A 20 s lap: longer than Docker's 10 s backoff reset, so the policy
        // restart is always ~100 ms after the die and lands inside the grace.
        stream.push(containerEvent('start', 1_000_000, '0'));
        stream.push(containerEvent('die', 1_020_000));
        await vi.advanceTimersByTimeAsync(175);
        stream.push(containerEvent('start', 1_020_175, '0'));
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Keep the container tracked through the hour: health events are not
        // alerts, and prune would otherwise drop the state and the run log.
        for (let i = 0; i < 13; i++) {
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            stream.push(containerEvent('health_status: healthy', 1_020_175, '0'));
        }

        // The window has elapsed, so the next lap alerts again rather than being
        // dropped as superseded by its own restart-policy start.
        stream.push(containerEvent('die', 1_040_175));
        await vi.advanceTimersByTimeAsync(175);
        stream.push(containerEvent('start', 1_040_350, '0'));
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('alerts a looping container once more after the dedup window expires', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-hour', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Keep looping through the hour (a start and a short die each lap) and
        // stay silent for every lap inside the window.
        for (let lap = 0; lap < 10; lap++) {
            stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-hour', Attributes: { name: 'web' } } });
            await vi.advanceTimersByTimeAsync(2_000);
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: { ID: 'c-hour', Attributes: { exitCode: '1', name: 'web' } },
            });
            await vi.advanceTimersByTimeAsync(600);
        }
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Still looping (start each lap) an hour later: the window has expired,
        // so the loop surfaces again once rather than never.
        await vi.advanceTimersByTimeAsync(61 * 60_000);
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-hour', Attributes: { name: 'web' } } });
        await vi.advanceTimersByTimeAsync(2_000);
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-hour', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);

        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('keeps the Auto-Heal crash signal through a restart and stamps it on a deduped crash', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-heal', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(service.getContainerState('c-heal')?.crashedAt).toBeTypeOf('number');

        // Restart clears the heal signal, as Auto-Heal timing expects today.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-heal', Attributes: { name: 'web' } } });
        expect(service.getContainerState('c-heal')?.crashedAt).toBeUndefined();

        // The next lap is deduped for alerts but still stamps the heal signal.
        await vi.advanceTimersByTimeAsync(1_000);
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-heal', Attributes: { exitCode: '1', name: 'web' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(service.getContainerState('c-heal')?.crashedAt).toBeTypeOf('number');
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    });
});

// ── Crash incident ordering, persistence, reconnect, equal timestamps ──

describe('DockerEventService - crash incident identity', () => {
    const crashAlerts = () => mockDispatchAlert.mock.calls.filter(c =>
        typeof c[2] === 'string' && (c[2].includes('Crash Detected') || c[2].includes('OOM Kill'))).length;

    it('does not reopen a loop when a stable predecessor completes after its newer short lap', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        let resolveOldInspect!: (value: unknown) => void;
        mockInspect.mockImplementation(() => new Promise(resolve => { resolveOldInspect = resolve; }));

        // Stable run 1000 -> die 1302, parked on the OOM inspect.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-pred', Attributes: { name: 'web' } }, time: 1_000 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-pred', Attributes: { exitCode: '137', name: 'web' } },
            time: 1_302,
        });
        await vi.advanceTimersByTimeAsync(600);

        // The next lap is short: it belongs to the same incident and alerts first.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-pred', Attributes: { name: 'web' } }, time: 1_303 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-pred', Attributes: { exitCode: '1', name: 'web' } },
            time: 1_305,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(1);

        // Completing the older, now-superseded classification must stay closed.
        resolveOldInspect({ State: { OOMKilled: false, ExitCode: 137 } });
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
        await flushMicrotasks();
        expect(crashAlerts()).toBe(1);
    });

    it('keeps a genuinely recovered newer incident when an older stable one finishes late', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        const resolvers: Array<(value: unknown) => void> = [];
        mockInspect.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));

        // Incident A: stable run 1000 -> die 1302, inspect parked.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-order', Attributes: { name: 'web' } }, time: 1_000 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-order', Attributes: { exitCode: '137', name: 'web' } },
            time: 1_302,
        });
        await vi.advanceTimersByTimeAsync(600);

        // Incident B: a genuine recovery, stable run 1303 -> die 1604.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-order', Attributes: { name: 'web' } }, time: 1_303 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-order', Attributes: { exitCode: '137', name: 'web' } },
            time: 1_604,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(resolvers).toHaveLength(2);

        // The newer incident completes first and alerts.
        resolvers[1]({ State: { OOMKilled: true, ExitCode: 137 } });
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
        await flushMicrotasks();
        expect(crashAlerts()).toBe(1);

        // The older stable incident still alerts, but must not rewind the
        // evidence that belongs to the newer one.
        resolvers[0]({ State: { OOMKilled: true, ExitCode: 137 } });
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
        await flushMicrotasks();
        expect(crashAlerts()).toBe(2);

        // Replaying the newer die must not re-alert after the rewound evidence.
        mockInspect.mockResolvedValue({ State: { OOMKilled: true, ExitCode: 137 } });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-order', Attributes: { exitCode: '137', name: 'web' } },
            time: 1_604,
        });
        await vi.advanceTimersByTimeAsync(600);
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
        await flushMicrotasks();
        expect(crashAlerts()).toBe(2);
    });

    it.each([
        { label: 'an ordinary crash', exitCode: '1', oom: false },
        { label: 'a direct OOM kill', exitCode: '137', oom: true },
        { label: 'an inspected OOM kill', exitCode: '137', oom: false, inspectOom: true },
    ])('retries after a failed history write ($label)', async ({ exitCode, oom, inspectOom }) => {
        service = new DockerEventService(1, 'local');
        await service.start();
        if (inspectOom) {
            mockInspect.mockResolvedValue({ State: { OOMKilled: true, ExitCode: 137 } });
        }
        mockDispatchAlert.mockResolvedValueOnce({ persisted: false });

        const die = (id: string, atSeconds: number) => {
            if (oom) {
                stream.push({ Type: 'container', Action: 'oom', Actor: { ID: id, Attributes: { name: 'app' } } });
            }
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: { ID: id, Attributes: { exitCode, name: 'app' } },
                time: atSeconds,
            });
        };

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-persist', Attributes: { name: 'app' } }, time: 1_000 });
        die('c-persist', 1_002);
        await vi.advanceTimersByTimeAsync(600);
        for (let i = 0; i < 6; i++) await Promise.resolve();
        // The first write failed, so it dispatched but did not consume the loop.
        expect(crashAlerts()).toBe(1);

        // The next restart-policy lap retries the alert instead of staying muted.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-persist', Attributes: { name: 'app' } }, time: 1_003 });
        die('c-persist', 1_005);
        await vi.advanceTimersByTimeAsync(600);
        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(crashAlerts()).toBe(2);
    });

    it('drops an overlapping crash delivery while a successful write is in flight', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        let resolveFirst!: (value: unknown) => void;
        mockDispatchAlert.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-overlap-write', Attributes: { name: 'app' } }, time: 1_000 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-overlap-write', Attributes: { exitCode: '1', name: 'app' } },
            time: 1_002,
        });
        await vi.advanceTimersByTimeAsync(600);

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-overlap-write', Attributes: { name: 'app' } }, time: 1_003 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-overlap-write', Attributes: { exitCode: '1', name: 'app' } },
            time: 1_005,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        resolveFirst({ persisted: true });
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    });

    it('reconciles a gap exit against an incident that already alerted', async () => {
        const baseline = Array.from({ length: 10 }, (_, i) => ({ Id: `g-${i}`, State: 'running' }));
        mockListContainers.mockResolvedValueOnce(baseline);

        service = new DockerEventService(1, 'local');
        await service.start();

        // Alert for the escape from a stable run, then the container restarts
        // and the stream drops before its next die is seen.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'g-0', Attributes: { name: 'app' } }, time: 1_000 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'g-0', Attributes: { exitCode: '1', name: 'app' } },
            time: 1_302,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(1);
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'g-0', Attributes: { name: 'app' } }, time: 1_303 });

        stream.error(new Error('stream dropped'));
        stream = makeStream();
        mockGetEvents.mockImplementation(async () => stream);
        mockListContainers.mockResolvedValueOnce(baseline.map((c, i) => (
            i === 0 ? { Id: c.Id, State: 'exited' } : c
        )));
        mockInspect.mockResolvedValueOnce({
            Name: '/app',
            State: {
                ExitCode: 1,
                OOMKilled: false,
                StartedAt: new Date(1_303_000).toISOString(),
                FinishedAt: new Date(1_304_000).toISOString(),
            },
            Config: { Labels: { 'com.docker.compose.project': 'stack' } },
        });

        await vi.advanceTimersByTimeAsync(2_000);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(crashAlerts()).toBe(1);
    });

    it('dedupes a die redelivered after a gap alert for the same run', async () => {
        const baseline = Array.from({ length: 10 }, (_, i) => ({ Id: `h-${i}`, State: 'running' }));
        mockListContainers.mockResolvedValueOnce(baseline);

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.error(new Error('stream dropped'));
        stream = makeStream();
        mockGetEvents.mockImplementation(async () => stream);
        mockListContainers.mockResolvedValueOnce(baseline.map((c, i) => (
            i === 0 ? { Id: c.Id, State: 'exited' } : c
        )));
        mockInspect.mockResolvedValueOnce({
            Name: '/app',
            State: {
                ExitCode: 1,
                OOMKilled: false,
                StartedAt: new Date(1_303_000).toISOString(),
                FinishedAt: new Date(1_304_000).toISOString(),
            },
            Config: { Labels: { 'com.docker.compose.project': 'stack' } },
        });

        await vi.advanceTimersByTimeAsync(2_000);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(crashAlerts()).toBe(1);

        // The die for that same run is delivered after the gap alert.
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'h-0', Attributes: { exitCode: '1', name: 'app' } },
            time: 1_304,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(1);
    });

    it('still alerts a gap exit that ran the full recovery threshold', async () => {
        const baseline = Array.from({ length: 10 }, (_, i) => ({ Id: `k-${i}`, State: 'running' }));
        mockListContainers.mockResolvedValueOnce(baseline);

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'k-0', Attributes: { name: 'app' } }, time: 1_000 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'k-0', Attributes: { exitCode: '1', name: 'app' } },
            time: 1_302,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(1);

        // The container recovered, ran six minutes, then exited during a gap.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'k-0', Attributes: { name: 'app' } }, time: 1_303 });
        stream.error(new Error('stream dropped'));
        stream = makeStream();
        mockGetEvents.mockImplementation(async () => stream);
        mockListContainers.mockResolvedValueOnce(baseline.map((c, i) => (
            i === 0 ? { Id: c.Id, State: 'exited' } : c
        )));
        mockInspect.mockResolvedValueOnce({
            Name: '/app',
            State: {
                ExitCode: 1,
                OOMKilled: false,
                StartedAt: new Date(1_303_000).toISOString(),
                FinishedAt: new Date(1_664_000).toISOString(),
            },
            Config: { Labels: { 'com.docker.compose.project': 'stack' } },
        });

        await vi.advanceTimersByTimeAsync(2_000);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(crashAlerts()).toBe(2);
    });

    it('attributes a gap exit to the stable run Docker already restarted', async () => {
        const baseline = Array.from({ length: 10 }, (_, i) => ({ Id: `m-${i}`, State: 'running' }));
        mockListContainers.mockResolvedValueOnce(baseline);

        service = new DockerEventService(1, 'local');
        await service.start();

        // The run lasted past the recovery threshold; the stream dropped before
        // the die and Docker had already restarted the container on reconnect.
        stream.push({
            Type: 'container',
            Action: 'start',
            Actor: { ID: 'm-0', Attributes: { name: 'app' } },
            timeNano: 1_000_000_000_000,
        });
        stream.error(new Error('stream dropped'));
        stream = makeStream();
        mockGetEvents.mockImplementation(async () => stream);
        mockListContainers.mockResolvedValueOnce(baseline.map((c, i) => (
            i === 0 ? { Id: c.Id, State: 'exited' } : c
        )));
        mockInspect.mockResolvedValueOnce({
            Name: '/app',
            State: {
                ExitCode: 1,
                OOMKilled: false,
                StartedAt: new Date(1_321_000).toISOString(), // the restart
                FinishedAt: new Date(1_320_000).toISOString(), // the stable run's die
            },
            Config: { Labels: { 'com.docker.compose.project': 'stack' } },
        });

        await vi.advanceTimersByTimeAsync(2_000);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(crashAlerts()).toBe(1);
    });

    it('clears transient crash state on a genuine restart that shares the coarse timestamp', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-equal', Attributes: { name: 'web' } }, time: 1_000 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-equal', Attributes: { exitCode: '1', name: 'web' } },
            time: 1_000,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(1);
        expect(service.getContainerState('c-equal')?.crashedAt).toBeTypeOf('number');

        // Same second-resolution timestamp, but the previous run died, so this
        // is a genuine new run and must clear the crash signal.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-equal', Attributes: { name: 'web' } }, time: 1_000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(service.getContainerState('c-equal')?.crashedAt).toBeUndefined();
    });

    it('does not keep stale kill evidence across an equal-timestamp restart', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-kill-equal', Attributes: { name: 'web' } }, time: 1_000 });
        stream.push({ Type: 'container', Action: 'kill', Actor: { ID: 'c-kill-equal', Attributes: {} }, time: 1_000 });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-kill-equal', Attributes: { exitCode: '1', name: 'web' } },
            time: 1_000,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(0);

        // A genuine restart at the same second clears the kill evidence, so the
        // next node crash is not misclassified as intentional.
        stream.push({ Type: 'container', Action: 'start', Actor: { ID: 'c-kill-equal', Attributes: { name: 'web' } }, time: 1_000 });
        await vi.advanceTimersByTimeAsync(0);
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'c-kill-equal', Attributes: { exitCode: '1', name: 'web' } },
            time: 1_002,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(crashAlerts()).toBe(1);
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
            typeof c[2] === 'string' && c[2].includes('rate-limited'));
        expect(summaryCalls).toHaveLength(1);
        expect(summaryCalls[0][2]).toBe(
            '2 additional container crash alerts were rate-limited in the last minute.',
        );
    });
});

// ── Health alert transition / dedup / rate sharing ─────────────────────

describe('DockerEventService - health alert gates', () => {
    it('emits once for duplicate unhealthy while already unhealthy and keeps unhealthySince', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: {
                ID: 'h1',
                Attributes: { name: 'api', 'com.docker.compose.project': 'web' },
            },
        });
        await flushMicrotasks();
        const first = service.getContainerState('h1');
        expect(first?.healthStatus).toBe('unhealthy');
        expect(first?.unhealthySince).toBeTypeOf('number');
        const since = first!.unhealthySince!;

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h1', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();

        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
        expect(service.getContainerState('h1')?.unhealthySince).toBe(since);
        expect(service.getContainerState('h1')?.healthStatus).toBe('unhealthy');
    });

    it('suppresses a second flap while the first health dispatch is still pending', async () => {
        let resolveFirst!: (value: { persisted: boolean }) => void;
        mockDispatchAlert.mockImplementationOnce(
            () => new Promise<{ persisted: boolean }>((resolve) => { resolveFirst = resolve; }),
        );

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h2', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'h2', Attributes: { name: 'api' } },
        });
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h2', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        resolveFirst({ persisted: true });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    });

    it('retries a deferred flap when the in-flight dispatch fails to persist', async () => {
        let resolveFirst!: (value: { persisted: boolean }) => void;
        mockDispatchAlert
            .mockImplementationOnce(
                () => new Promise<{ persisted: boolean }>((resolve) => { resolveFirst = resolve; }),
            )
            .mockResolvedValue({ persisted: true });

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h2b', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'h2b', Attributes: { name: 'api' } },
        });
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h2b', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        resolveFirst({ persisted: false });
        await flushMicrotasks();
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('does not advance health dedup when persisted is false, allowing a later transition', async () => {
        mockDispatchAlert
            .mockResolvedValueOnce({ persisted: false })
            .mockResolvedValue({ persisted: true });

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h3', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'h3', Attributes: { name: 'api' } },
        });
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h3', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('keeps health dedup across the 10-minute prune window and re-emits after 60 minutes', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h4', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Recover so lastActivity ages without fresh unhealthy events; prune
        // may drop containerState after 10m but health dedup must survive.
        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'h4', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();

        await vi.advanceTimersByTimeAsync(11 * 60_000);

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h4', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50 * 60_000);

        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'h4', Attributes: { name: 'api' } },
        });
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h4', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('does not let crash and health dedup suppress one another', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: { ID: 'h5', Attributes: { exitCode: '1', name: 'api' } },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        stream.push({
            Type: 'container',
            Action: 'start',
            Actor: { ID: 'h5', Attributes: { name: 'api' } },
        });
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h5', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
        expect(mockDispatchAlert.mock.calls[1][2]).toContain('Healthcheck failed');
    });

    it('does not consume rate tokens for deduped duplicate health events', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h6', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();

        for (let i = 0; i < 5; i++) {
            stream.push({
                Type: 'container',
                Action: 'health_status: healthy',
                Actor: { ID: 'h6', Attributes: { name: 'api' } },
            });
            stream.push({
                Type: 'container',
                Action: 'health_status: unhealthy',
                Actor: { ID: 'h6', Attributes: { name: 'api' } },
            });
            await flushMicrotasks();
        }
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 19; i++) {
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: { ID: `crash-${i}`, Attributes: { exitCode: '1', name: `n-${i}` } },
            });
        }
        await vi.advanceTimersByTimeAsync(600);
        const crashCalls = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('Crash'));
        expect(crashCalls).toHaveLength(19);
    });

    it('emits an accurate health-only rate-limit roll-up', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        for (let i = 0; i < 22; i++) {
            stream.push({
                Type: 'container',
                Action: 'health_status: unhealthy',
                Actor: { ID: `hh-${i}`, Attributes: { name: `svc-${i}` } },
            });
            await flushMicrotasks();
        }

        const healthCalls = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('Healthcheck failed'));
        expect(healthCalls).toHaveLength(20);

        await vi.advanceTimersByTimeAsync(61_000);
        const summaryCalls = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('rate-limited'));
        expect(summaryCalls).toHaveLength(1);
        expect(summaryCalls[0][2]).toBe(
            '2 additional container health alerts were rate-limited in the last minute.',
        );
    });

    it('emits an accurate mixed crash and health rate-limit roll-up', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        for (let i = 0; i < 10; i++) {
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: { ID: `mc-${i}`, Attributes: { exitCode: '1', name: `c-${i}` } },
            });
        }
        await vi.advanceTimersByTimeAsync(600);

        for (let i = 0; i < 10; i++) {
            stream.push({
                Type: 'container',
                Action: 'health_status: unhealthy',
                Actor: { ID: `mh-${i}`, Attributes: { name: `h-${i}` } },
            });
            await flushMicrotasks();
        }

        for (let i = 10; i < 12; i++) {
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: { ID: `mc-${i}`, Attributes: { exitCode: '1', name: `c-${i}` } },
            });
        }
        await vi.advanceTimersByTimeAsync(600);

        for (let i = 10; i < 13; i++) {
            stream.push({
                Type: 'container',
                Action: 'health_status: unhealthy',
                Actor: { ID: `mh-${i}`, Attributes: { name: `h-${i}` } },
            });
            await flushMicrotasks();
        }

        await vi.advanceTimersByTimeAsync(61_000);
        const summaryCalls = mockDispatchAlert.mock.calls.filter(c =>
            typeof c[2] === 'string' && c[2].includes('rate-limited'));
        expect(summaryCalls).toHaveLength(1);
        expect(summaryCalls[0][2]).toBe(
            '5 additional container alerts were rate-limited in the last minute (2 crash, 3 health).',
        );
    });

    it('keeps Auto-Heal health state when global_crash is off', async () => {
        mockGetGlobalSettings.mockReturnValue({ global_crash: '0' });
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'h7', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();

        expect(mockDispatchAlert).not.toHaveBeenCalled();
        expect(service.getContainerState('h7')).toMatchObject({
            healthStatus: 'unhealthy',
        });
        expect(service.getContainerState('h7')?.unhealthySince).toBeTypeOf('number');
    });

    it('does not refund a rate token into the next fixed window', async () => {
        let resolvePersist!: (value: { persisted: boolean }) => void;
        mockDispatchAlert.mockImplementation(
            () =>
                new Promise<{ persisted: boolean }>((resolve) => {
                    resolvePersist = resolve;
                }),
        );

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'cross-window', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Cross the fixed window, then consume a token in the new window so
        // refund would inflate W2's count if it ignored the issuing window.
        await vi.advanceTimersByTimeAsync(60_000);
        mockDispatchAlert.mockResolvedValue({ persisted: true });
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: {
                ID: 'cw-roll',
                Attributes: { exitCode: '1', name: 'roll' },
            },
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(
            mockDispatchAlert.mock.calls.filter(
                (c) => typeof c[2] === 'string' && c[2].includes('Crash Detected'),
            ),
        ).toHaveLength(1);

        // Fail the original health persist: old code refunds into W2 (count 1→0).
        resolvePersist({ persisted: false });
        await flushMicrotasks();

        // Fill the rest of W2 to the 20-alert cap (19 more crashes).
        for (let i = 0; i < 19; i++) {
            stream.push({
                Type: 'container',
                Action: 'die',
                Actor: {
                    ID: `cw-${i}`,
                    Attributes: { exitCode: '1', name: `svc-${i}` },
                },
            });
        }
        await vi.advanceTimersByTimeAsync(600);

        // Cap must still hold: a cross-window refund would have allowed a 21st.
        stream.push({
            Type: 'container',
            Action: 'die',
            Actor: {
                ID: 'cw-overflow',
                Attributes: { exitCode: '1', name: 'overflow' },
            },
        });
        await vi.advanceTimersByTimeAsync(600);

        const crashCalls = mockDispatchAlert.mock.calls.filter(
            (c) => typeof c[2] === 'string' && c[2].includes('Crash Detected'),
        );
        expect(crashCalls).toHaveLength(20);
    });

    it('clears pending health retry when the container recovers before persist fails', async () => {
        let resolvePersist!: (value: { persisted: boolean }) => void;
        mockDispatchAlert.mockImplementation(
            () =>
                new Promise<{ persisted: boolean }>((resolve) => {
                    resolvePersist = resolve;
                }),
        );

        service = new DockerEventService(1, 'local');
        await service.start();

        // First unhealthy starts an in-flight dispatch.
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'recover-pending', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Flap while in flight: recover then re-fail so a pending-retry marker is set.
        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'recover-pending', Attributes: { name: 'api' } },
        });
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'recover-pending', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Recover again before the first persist settles; marker must be dropped.
        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'recover-pending', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();

        resolvePersist({ persisted: false });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Later unrelated persist failure must not spuriously retry from a stale marker.
        mockDispatchAlert.mockResolvedValueOnce({ persisted: false });
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'recover-pending', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('does not dispatch deferred health retry after shutdown', async () => {
        let resolvePersist!: (value: { persisted: boolean }) => void;
        mockDispatchAlert.mockImplementation(
            () =>
                new Promise<{ persisted: boolean }>((resolve) => {
                    resolvePersist = resolve;
                }),
        );

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'shutdown-pending', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        service.shutdown();
        resolvePersist({ persisted: false });
        await flushMicrotasks();

        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    });

    it('clears health alert bookkeeping on destroy', async () => {
        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'destroy-dedup', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        stream.push({
            Type: 'container',
            Action: 'destroy',
            Actor: { ID: 'destroy-dedup', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'destroy-dedup', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    });

    it('does not retry a deferred health alert after destroy', async () => {
        let resolvePersist!: (value: { persisted: boolean }) => void;
        mockDispatchAlert.mockImplementation(
            () =>
                new Promise<{ persisted: boolean }>((resolve) => {
                    resolvePersist = resolve;
                }),
        );

        service = new DockerEventService(1, 'local');
        await service.start();

        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'destroy-pending', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

        // Set a pending-retry marker while the first dispatch is in flight.
        stream.push({
            Type: 'container',
            Action: 'health_status: healthy',
            Actor: { ID: 'destroy-pending', Attributes: { name: 'api' } },
        });
        stream.push({
            Type: 'container',
            Action: 'health_status: unhealthy',
            Actor: { ID: 'destroy-pending', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();

        stream.push({
            Type: 'container',
            Action: 'destroy',
            Actor: { ID: 'destroy-pending', Attributes: { name: 'api' } },
        });
        await flushMicrotasks();

        resolvePersist({ persisted: false });
        await flushMicrotasks();
        expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
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
        expect(warn?.[2]).toBe('Lost connection to Docker daemon; monitoring paused.');
        expect(info?.[2]).toBe('Reconnected to Docker daemon.');
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
    let invalidateSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        invalidateSpy = vi.spyOn(CacheService.getInstance(), 'invalidate');
    });

    afterEach(() => {
        invalidateSpy.mockRestore();
    });

    it('broadcasts state-invalidate and drops the statuses cache on container start', async () => {
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
        // The UI refetch this broadcast triggers must recompute, not hit a
        // cache entry made stale by the event. Only the statuses key is
        // touched; the full invalidateNodeCaches helper is not used here.
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
        expect(invalidateSpy).toHaveBeenCalledWith('stack-statuses:7');
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
        expect(invalidateSpy).not.toHaveBeenCalled();
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
        expect(invalidateSpy).toHaveBeenCalledWith('stack-statuses:1');
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
        expect(invalidateSpy).not.toHaveBeenCalled();
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

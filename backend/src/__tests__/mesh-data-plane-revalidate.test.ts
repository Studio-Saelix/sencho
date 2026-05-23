import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { MeshActivityEvent, MeshDataPlaneStatus } from '../services/MeshService';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DockerController: typeof import('../services/DockerController').default;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let MESH_RECREATE_THROTTLE_MS: number;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService, MESH_RECREATE_THROTTLE_MS } = await import('../services/MeshService'));
    ({ default: DockerController } = await import('../services/DockerController'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

type MutableSvc = {
    activity: MeshActivityEvent[];
    senchoIp: string | null;
    meshSubnet: string;
    networkSetupError: string | null;
    dataPlaneStatus: MeshDataPlaneStatus;
    dataPlaneRevalidateInFlight: boolean;
    dataPlaneRevalidateTimer?: NodeJS.Timeout;
    lastRecreateAttemptAt: number;
    started: boolean;
};

let prevHostnameEnv: string | undefined;

beforeEach(() => {
    prevHostnameEnv = process.env.HOSTNAME;
    // Mirror the production recipe (`docker run --hostname sencho ...`) so
    // the revalidator's attachment check resolves via container-name match
    // against `Containers.<id>.Name`. The 12-char container-ID prefix path
    // is exercised by tests that drop the `name` field.
    process.env.HOSTNAME = 'sencho';
    const svc = MeshService.getInstance() as unknown as MutableSvc;
    svc.activity = [];
    svc.senchoIp = '172.30.0.2';
    svc.meshSubnet = '172.30.0.0/24';
    svc.networkSetupError = null;
    svc.dataPlaneStatus = {
        ok: true,
        reason: 'ok',
        message: null,
        subnet: '172.30.0.0/24',
    };
    svc.dataPlaneRevalidateInFlight = false;
    svc.lastRecreateAttemptAt = 0;
    DatabaseService.getInstance().updateGlobalSetting('mesh_auto_recreate', '0');
});

afterEach(() => {
    if (prevHostnameEnv === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = prevHostnameEnv;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

type FakeController = {
    createNetwork: ReturnType<typeof vi.fn>;
    inspectNetwork: ReturnType<typeof vi.fn>;
    connectContainerToNetwork: ReturnType<typeof vi.fn>;
};

function mockDocker(overrides: Partial<FakeController> = {}): FakeController {
    const fake: FakeController = {
        createNetwork: vi.fn().mockResolvedValue(undefined),
        inspectNetwork: vi.fn(),
        connectContainerToNetwork: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
    vi.spyOn(DockerController, 'getInstance').mockReturnValue(
        fake as unknown as ReturnType<typeof DockerController.getInstance>,
    );
    return fake;
}

function networkPresent(subnet: string, attached: Array<string | { id: string; name: string }>): {
    IPAM: { Config: Array<{ Subnet: string; IPRange?: string }> };
    Containers: Record<string, { Name: string }>;
} {
    const containers: Record<string, { Name: string }> = {};
    for (const entry of attached) {
        if (typeof entry === 'string') {
            containers[entry] = { Name: '/workload' };
        } else {
            containers[entry.id] = { Name: `/${entry.name}` };
        }
    }
    return {
        IPAM: { Config: [{ Subnet: subnet, IPRange: '172.30.0.128/25' }] },
        Containers: containers,
    };
}

function lastTransition(svc: import('../services/MeshService').MeshService): MeshActivityEvent | undefined {
    const all = (svc as unknown as MutableSvc).activity;
    return all
        .filter((e) => e.type === 'mesh.enable' || e.type === 'mesh.disable')
        .filter((e) => typeof e.details?.prevReason === 'string')
        .slice(-1)[0];
}

describe('MeshService.revalidateDataPlane — short-circuits', () => {
    it('skips when boot has not finished (not_started)', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneStatus = { ok: false, reason: 'not_started', message: 'init', subnet: '' };
        const fake = mockDocker();
        await MeshService.getInstance().revalidateDataPlane();
        expect(fake.inspectNetwork).not.toHaveBeenCalled();
        expect(svc.dataPlaneStatus.reason).toBe('not_started');
    });

    it('skips in dev mode (not_in_docker)', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneStatus = { ok: false, reason: 'not_in_docker', message: 'dev', subnet: '172.30.0.0/24' };
        const fake = mockDocker();
        await MeshService.getInstance().revalidateDataPlane();
        expect(fake.inspectNetwork).not.toHaveBeenCalled();
        expect(svc.dataPlaneStatus.reason).toBe('not_in_docker');
    });

    it('skips when env config error (subnet_invalid)', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneStatus = { ok: false, reason: 'subnet_invalid', message: 'bad cidr', subnet: 'nope' };
        const fake = mockDocker();
        await MeshService.getInstance().revalidateDataPlane();
        expect(fake.inspectNetwork).not.toHaveBeenCalled();
        expect(svc.dataPlaneStatus.reason).toBe('subnet_invalid');
    });

    it('skips when a revalidate is already in flight (re-entry guard)', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneRevalidateInFlight = true;
        const fake = mockDocker();
        await MeshService.getInstance().revalidateDataPlane();
        expect(fake.inspectNetwork).not.toHaveBeenCalled();
    });
});

describe('MeshService.revalidateDataPlane — happy paths', () => {
    it('is a silent no-op when network and attachment are both healthy', async () => {
        const fake = mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue(
                networkPresent('172.30.0.0/24', [{ id: 'aaaa11112222333344445555', name: 'sencho' }]),
            ),
        });
        const svc = MeshService.getInstance();
        const before = (svc as unknown as MutableSvc).activity.length;
        await svc.revalidateDataPlane();
        expect(fake.inspectNetwork).toHaveBeenCalledTimes(1);
        expect(svc.getDataPlaneStatus().reason).toBe('ok');
        // No transition entry appended — idempotent on stable state.
        expect((svc as unknown as MutableSvc).activity.length).toBe(before);
    });

    it('matches the self-attachment check by full container-ID prefix when no Name is set', async () => {
        const fake = mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue({
                IPAM: { Config: [{ Subnet: '172.30.0.0/24', IPRange: '172.30.0.128/25' }] },
                // Mimic the Docker default HOSTNAME=<12-char short id> setup
                // by writing a containers entry with NO Name but an ID that
                // begins with our HOSTNAME-equivalent 12-char prefix.
                Containers: { '5dd0ce69ef50abcdefabcdef12345678abcdef1234567890abcd12345678': { Name: '' } },
            }),
        });
        process.env.HOSTNAME = '5dd0ce69ef50';
        const svc = MeshService.getInstance();
        await svc.revalidateDataPlane();
        expect(fake.inspectNetwork).toHaveBeenCalledTimes(1);
        expect(svc.getDataPlaneStatus().reason).toBe('ok');
    });

    it('preserves status as `unknown` when HOSTNAME is a short hex prefix and no Name match', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        // HOSTNAME='ab' is short AND hex: it could plausibly be a
        // container-ID prefix, but length < 12 makes the prefix path
        // unsafe. Name does not match. We genuinely cannot identify
        // ourselves; preserve prior status.
        process.env.HOSTNAME = 'ab';
        mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue({
                IPAM: { Config: [{ Subnet: '172.30.0.0/24', IPRange: '172.30.0.128/25' }] },
                Containers: { 'ff00112233445566ffffffffff': { Name: '/something-else' } },
            }),
        });
        await MeshService.getInstance().revalidateDataPlane();
        // Prior status preserved (ok), no transition to attach_failed.
        expect(svc.dataPlaneStatus.reason).toBe('ok');
    });

    it('classifies as `detached` when HOSTNAME is non-hex (operator-set) and no Name match', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        // HOSTNAME='sencho' is non-hex. It cannot collide with any
        // container ID regardless of length, so Name is the only path
        // and a Name miss means we are definitely not attached.
        process.env.HOSTNAME = 'sencho';
        mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue(
                networkPresent('172.30.0.0/24', [{ id: 'ffffeeeeddddccccaaa', name: 'someoneelse' }]),
            ),
        });
        await MeshService.getInstance().revalidateDataPlane();
        expect(svc.dataPlaneStatus.reason).toBe('attach_failed');
    });

    it('recovers from subnet_mismatch when operator removed the conflicting network', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneStatus = {
            ok: false,
            reason: 'subnet_mismatch',
            message: 'old conflict',
            subnet: '172.30.0.0/24',
        };
        svc.networkSetupError = 'old conflict';
        mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue(
                networkPresent('172.30.0.0/24', [{ id: 'aaaabbbbccccdddd', name: 'sencho' }]),
            ),
        });
        await MeshService.getInstance().revalidateDataPlane();
        expect(svc.dataPlaneStatus.reason).toBe('ok');
        expect(svc.dataPlaneStatus.ok).toBe(true);
        // Transition into ok clears the legacy raw-error string so the two
        // status surfaces (typed discriminator + raw string) stay coherent.
        expect(svc.networkSetupError).toBeNull();
        const t = lastTransition(MeshService.getInstance());
        expect(t?.type).toBe('mesh.enable');
        expect(t?.details?.prevReason).toBe('subnet_mismatch');
        expect(t?.details?.nextReason).toBe('ok');
    });

    it('recovers from subnet_overlap when operator removed the conflicting network', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneStatus = {
            ok: false,
            reason: 'subnet_overlap',
            message: 'overlap',
            subnet: '172.30.0.0/24',
        };
        mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue(
                networkPresent('172.30.0.0/24', [{ id: 'abcdef012345678901', name: 'sencho' }]),
            ),
        });
        await MeshService.getInstance().revalidateDataPlane();
        expect(svc.dataPlaneStatus.reason).toBe('ok');
    });
});

describe('MeshService.revalidateDataPlane — failure transitions', () => {
    it('flips to not_found when sencho_mesh has been removed', async () => {
        mockDocker({
            // inspectNetwork resolves null via the 404 path inside the snapshot helper.
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
        });
        const svc = MeshService.getInstance();
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await svc.revalidateDataPlane();
        const status = svc.getDataPlaneStatus();
        expect(status.ok).toBe(false);
        expect(status.reason).toBe('not_found');
        expect(status.subnet).toBe('172.30.0.0/24');
        expect(status.message).toMatch(/is not present/i);
        // Mirrored to console.warn so docker logs surfaces the transition.
        expect(consoleWarn).toHaveBeenCalled();
        const t = lastTransition(svc);
        expect(t?.type).toBe('mesh.disable');
        expect(t?.details?.prevReason).toBe('ok');
        expect(t?.details?.nextReason).toBe('not_found');
    });

    it('flips to subnet_mismatch when the network was externally recreated at a different subnet', async () => {
        mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue(
                networkPresent('10.42.0.0/24', [{ id: 'someotherid12345', name: 'sencho' }]),
            ),
        });
        const svc = MeshService.getInstance();
        await svc.revalidateDataPlane();
        const status = svc.getDataPlaneStatus();
        expect(status.reason).toBe('subnet_mismatch');
        expect(status.message).toMatch(/172\.30\.0\.0\/24/);
        expect(status.message).toMatch(/10\.42\.0\.0\/24/);
    });

    it('flips to attach_failed when network is present but Sencho is no longer attached', async () => {
        mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue(
                // Attached containers: someone else, not Sencho.
                networkPresent('172.30.0.0/24', [{ id: 'other-id', name: 'other-container' }]),
            ),
        });
        const svc = MeshService.getInstance();
        await svc.revalidateDataPlane();
        const status = svc.getDataPlaneStatus();
        expect(status.reason).toBe('attach_failed');
        expect(status.message).toMatch(/no longer attached/i);
    });

    it('flips from attach_failed to not_found when the network is then removed', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneStatus = {
            ok: false,
            reason: 'attach_failed',
            message: 'Sencho is no longer attached',
            subnet: '172.30.0.0/24',
        };
        mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
        });
        await MeshService.getInstance().revalidateDataPlane();
        expect(svc.dataPlaneStatus.reason).toBe('not_found');
    });

    it('flips from subnet_mismatch to not_found when the conflicting network is then removed', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneStatus = {
            ok: false,
            reason: 'subnet_mismatch',
            message: 'mismatch',
            subnet: '172.30.0.0/24',
        };
        mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
        });
        await MeshService.getInstance().revalidateDataPlane();
        expect(svc.dataPlaneStatus.reason).toBe('not_found');
    });

    it('flips from not_found to subnet_mismatch when an external recreate lands at a different subnet', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        svc.dataPlaneStatus = {
            ok: false,
            reason: 'not_found',
            message: 'removed',
            subnet: '172.30.0.0/24',
        };
        mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue(
                networkPresent('10.43.0.0/24', [{ id: 'newone', name: 'someoneelse' }]),
            ),
        });
        await MeshService.getInstance().revalidateDataPlane();
        expect(svc.dataPlaneStatus.reason).toBe('subnet_mismatch');
        expect(svc.dataPlaneStatus.subnet).toBe('172.30.0.0/24'); // our configured subnet, unchanged
        expect(svc.dataPlaneStatus.message).toMatch(/10\.43\.0\.0\/24/);
    });

    it('refreshes the message + observed subnet on a SECOND subnet_mismatch observation against a different external subnet', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        // First mismatch lands at 10.42.0.0/24.
        mockDocker({
            inspectNetwork: vi.fn().mockResolvedValue(
                networkPresent('10.42.0.0/24', [{ id: 'newone', name: 'unrelated' }]),
            ),
        });
        await MeshService.getInstance().revalidateDataPlane();
        expect(svc.dataPlaneStatus.reason).toBe('subnet_mismatch');
        expect(svc.dataPlaneStatus.message).toMatch(/10\.42\.0\.0\/24/);
        const firstMessage = svc.dataPlaneStatus.message;
        const transitionsAfterFirst = svc.activity
            .filter((e) => e.details && typeof e.details.prevReason === 'string').length;

        // Second mismatch lands at 10.43.0.0/24. Reason stays
        // `subnet_mismatch`, but the message must be refreshed so
        // /api/health reports the current subnet, not the stale one.
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            createNetwork: vi.fn(),
            inspectNetwork: vi.fn().mockResolvedValue(
                networkPresent('10.43.0.0/24', [{ id: 'newone2', name: 'unrelated' }]),
            ),
            connectContainerToNetwork: vi.fn(),
        } as unknown as ReturnType<typeof DockerController.getInstance>);
        await MeshService.getInstance().revalidateDataPlane();
        expect(svc.dataPlaneStatus.reason).toBe('subnet_mismatch');
        expect(svc.dataPlaneStatus.message).not.toBe(firstMessage);
        expect(svc.dataPlaneStatus.message).toMatch(/10\.43\.0\.0\/24/);

        // Log surface stays quiet: reason did not change, so no second
        // activity entry beyond the first transition.
        const transitionsAfterSecond = svc.activity
            .filter((e) => e.details && typeof e.details.prevReason === 'string').length;
        expect(transitionsAfterSecond).toBe(transitionsAfterFirst);
    });

    it('preserves the prior status on a transient Docker error (no flap)', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('connect ECONNREFUSED'), { statusCode: 500 }),
            ),
        });
        await MeshService.getInstance().revalidateDataPlane();
        // Daemon transient: status stays at ok, no transition appended.
        expect(svc.dataPlaneStatus.reason).toBe('ok');
        expect(lastTransition(MeshService.getInstance())).toBeUndefined();
    });
});

describe('MeshService.transitionDataPlane — idempotency', () => {
    it('records a single transition entry across two ticks observing the same not_found state', async () => {
        const svc = MeshService.getInstance();
        mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
        });
        const before = (svc as unknown as MutableSvc).activity.length;
        await svc.revalidateDataPlane();
        await svc.revalidateDataPlane();
        const after = (svc as unknown as MutableSvc).activity.length;
        // Two ticks, but only the first one triggers the ok -> not_found
        // transition. The second tick sees prev.reason === next.reason and
        // no-ops in transitionDataPlane.
        // (Auto-recreate is OFF in this test so the only growth source is
        // the transition itself.)
        expect(after - before).toBe(1);
    });
});

describe('MeshService.attemptInPlaceRecreate — auto-recreate off (default)', () => {
    it('does NOT call createNetwork when the setting is off', async () => {
        const fake = mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
        });
        const svc = MeshService.getInstance();
        await svc.revalidateDataPlane();
        expect(svc.getDataPlaneStatus().reason).toBe('not_found');
        expect(fake.createNetwork).not.toHaveBeenCalled();
    });
});

describe('MeshService.attemptInPlaceRecreate — auto-recreate on', () => {
    beforeEach(() => {
        DatabaseService.getInstance().updateGlobalSetting('mesh_auto_recreate', '1');
    });

    it('recreates the network at the same subnet and re-attaches Sencho on success', async () => {
        const fake = mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
        });
        const svc = MeshService.getInstance();
        await svc.revalidateDataPlane();
        // First the revalidator surfaced the bad state...
        expect(fake.createNetwork).toHaveBeenCalledTimes(1);
        expect(fake.createNetwork).toHaveBeenCalledWith(expect.objectContaining({
            Name: 'sencho_mesh',
            IPAM: { Config: [expect.objectContaining({ Subnet: '172.30.0.0/24' })] },
        }));
        expect(fake.connectContainerToNetwork).toHaveBeenCalledTimes(1);
        // Final status flips back to ok.
        expect(svc.getDataPlaneStatus().reason).toBe('ok');
        // And the previously chosen senchoIp is preserved end-to-end:
        // ensureSelfAttached MUST NOT clear it on the recovery branch.
        expect((svc as unknown as MutableSvc).senchoIp).toBe('172.30.0.2');
    });

    it('records subnet_overlap (and does NOT drift) when createNetwork rejects with overlap', async () => {
        const fake = mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
            createNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('Pool overlaps with other one on this address space'), { statusCode: 500 }),
            ),
        });
        const svc = MeshService.getInstance();
        await svc.revalidateDataPlane();
        expect(fake.createNetwork).toHaveBeenCalledTimes(1);
        const status = svc.getDataPlaneStatus();
        expect(status.reason).toBe('subnet_overlap');
        // The chosen subnet has NOT changed; auto-recreate never iterates
        // candidates because that would invalidate existing override files.
        expect(status.subnet).toBe('172.30.0.0/24');
    });

    it('does NOT flap subnet_overlap back to not_found during the recreate throttle window', async () => {
        const fake = mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
            createNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('Pool overlaps with other one on this address space'), { statusCode: 500 }),
            ),
        });
        const svc = MeshService.getInstance();
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
        // Tick 1: failure-classifies as subnet_overlap.
        await svc.revalidateDataPlane();
        expect(svc.getDataPlaneStatus().reason).toBe('subnet_overlap');
        // Tick 2 (10s later): network still missing, but the recreate
        // throttle is still active. The operator-actionable reason
        // (subnet_overlap) must NOT be downgraded to the generic
        // not_found. The createNetwork call must NOT be retried either.
        nowSpy.mockReturnValue(2_000_000 + 10_000);
        await svc.revalidateDataPlane();
        expect(svc.getDataPlaneStatus().reason).toBe('subnet_overlap');
        expect(fake.createNetwork).toHaveBeenCalledTimes(1);
        // Throttle elapses; tick retries the recreate and re-classifies.
        nowSpy.mockReturnValue(2_000_000 + MESH_RECREATE_THROTTLE_MS + 1);
        await svc.revalidateDataPlane();
        expect(fake.createNetwork).toHaveBeenCalledTimes(2);
    });

    it('throttles repeat recreate attempts within MESH_RECREATE_THROTTLE_MS', async () => {
        const fake = mockDocker({
            inspectNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('no such network'), { statusCode: 404 }),
            ),
            createNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('Pool overlaps with other one on this address space'), { statusCode: 500 }),
            ),
        });
        const svc = MeshService.getInstance();
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        await svc.revalidateDataPlane();
        await svc.revalidateDataPlane();
        await svc.revalidateDataPlane();
        // Three ticks, but only ONE createNetwork because the throttle
        // window blocks the second and third attempts.
        expect(fake.createNetwork).toHaveBeenCalledTimes(1);
        // Advance past the throttle window and confirm the next tick is
        // willing to try again.
        nowSpy.mockReturnValue(1_000_000 + MESH_RECREATE_THROTTLE_MS + 1);
        await svc.revalidateDataPlane();
        expect(fake.createNetwork).toHaveBeenCalledTimes(2);
    });
});

describe('MeshService.dataPlaneRevalidateTimer — lifecycle', () => {
    it('start() schedules the timer, stop() clears it', async () => {
        const svc = MeshService.getInstance() as unknown as MutableSvc;
        // The shared singleton may have been start()-ed already by another
        // suite; clear any previous timer and reset 'started' so we can
        // exercise start/stop cleanly without crossing real I/O paths.
        if (svc.dataPlaneRevalidateTimer) {
            clearInterval(svc.dataPlaneRevalidateTimer);
            svc.dataPlaneRevalidateTimer = undefined;
        }
        // Drive the lifecycle by stubbing the singleton's slow boot work so
        // start() returns quickly. We only care about the timer wiring.
        const inst = MeshService.getInstance();
        const ms = inst as unknown as Record<string, unknown>;
        ms.setupMeshNetwork = vi.fn().mockResolvedValue(undefined);
        ms.refreshAliasCache = vi.fn().mockResolvedValue(undefined);
        ms.syncForwarderListeners = vi.fn().mockResolvedValue(undefined);
        ms.regenerateAllOverrides = vi.fn().mockResolvedValue(undefined);
        ms.proactiveBridgeFanout = vi.fn().mockReturnValue(undefined);
        ms.startBridgeReconcileLoop = vi.fn().mockReturnValue(undefined);
        ms.stopBridgeReconcileLoop = vi.fn().mockReturnValue(undefined);
        svc.started = false;
        await inst.start();
        expect(svc.dataPlaneRevalidateTimer).toBeDefined();
        await inst.stop();
        expect(svc.dataPlaneRevalidateTimer).toBeUndefined();
    });
});

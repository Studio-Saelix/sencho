import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { MeshActivityEvent, MeshDataPlaneStatus } from '../services/MeshService';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DockerController: typeof import('../services/DockerController').default;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ default: DockerController } = await import('../services/DockerController'));
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
};

let prevSubnetEnv: string | undefined;
let prevHostnameEnv: string | undefined;

beforeEach(() => {
    prevSubnetEnv = process.env.SENCHO_MESH_SUBNET;
    prevHostnameEnv = process.env.HOSTNAME;
    const svc = MeshService.getInstance() as unknown as MutableSvc;
    svc.activity = [];
    svc.senchoIp = null;
    svc.meshSubnet = '172.30.0.0/24';
    svc.networkSetupError = null;
    svc.dataPlaneStatus = {
        ok: false,
        reason: 'not_started',
        message: 'mesh data plane has not initialized yet',
        subnet: '',
    };
});

afterEach(() => {
    if (prevSubnetEnv === undefined) delete process.env.SENCHO_MESH_SUBNET;
    else process.env.SENCHO_MESH_SUBNET = prevSubnetEnv;
    if (prevHostnameEnv === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = prevHostnameEnv;
    vi.restoreAllMocks();
});

function callSetup(svc: import('../services/MeshService').MeshService): Promise<void> {
    return (svc as unknown as { setupMeshNetwork: () => Promise<void> }).setupMeshNetwork();
}

function lastDisable(svc: import('../services/MeshService').MeshService): MeshActivityEvent | undefined {
    const all = (svc as unknown as MutableSvc).activity;
    return all.filter((e) => e.type === 'mesh.disable').slice(-1)[0];
}

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

describe('MeshService.setupMeshNetwork failure classification', () => {
    it('classifies an invalid CIDR as subnet_invalid', async () => {
        process.env.SENCHO_MESH_SUBNET = 'not-a-cidr';
        process.env.HOSTNAME = 'sencho';
        mockDocker();
        const svc = MeshService.getInstance();
        await callSetup(svc);
        const status = svc.getDataPlaneStatus();
        expect(status.ok).toBe(false);
        expect(status.reason).toBe('subnet_invalid');
        expect(status.subnet).toBe('not-a-cidr');
        const entry = lastDisable(svc);
        expect(entry?.level).toBe('error');
        expect(entry?.details?.reason).toBe('subnet_invalid');
    });

    it('classifies a Docker pool-overlap error as subnet_overlap', async () => {
        process.env.SENCHO_MESH_SUBNET = '10.42.0.0/24';
        process.env.HOSTNAME = 'sencho';
        mockDocker({
            createNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('Pool overlaps with other one on this address space'), { statusCode: 500 }),
            ),
        });
        const svc = MeshService.getInstance();
        await callSetup(svc);
        const status = svc.getDataPlaneStatus();
        expect(status.reason).toBe('subnet_overlap');
        expect(status.subnet).toBe('10.42.0.0/24');
        expect(status.message).toMatch(/overlap/i);
        const entry = lastDisable(svc);
        expect(entry?.level).toBe('error');
        expect(entry?.details?.reason).toBe('subnet_overlap');
    });

    it('classifies an existing-network mismatch as subnet_mismatch', async () => {
        process.env.SENCHO_MESH_SUBNET = '10.42.0.0/24';
        process.env.HOSTNAME = 'sencho';
        mockDocker({
            createNetwork: vi.fn().mockRejectedValue({ statusCode: 409, message: 'network already exists' }),
            inspectNetwork: vi.fn().mockResolvedValue({ IPAM: { Config: [{ Subnet: '172.30.0.0/24' }] } }),
        });
        const svc = MeshService.getInstance();
        await callSetup(svc);
        const status = svc.getDataPlaneStatus();
        expect(status.reason).toBe('subnet_mismatch');
        expect(status.message).toMatch(/exists with subnet/i);
    });

    it('classifies an address-already-in-use attach error as ip_in_use', async () => {
        process.env.SENCHO_MESH_SUBNET = '10.42.0.0/24';
        process.env.HOSTNAME = 'sencho';
        mockDocker({
            connectContainerToNetwork: vi.fn().mockRejectedValue(new Error('Address already in use')),
        });
        const svc = MeshService.getInstance();
        await callSetup(svc);
        expect(svc.getDataPlaneStatus().reason).toBe('ip_in_use');
        expect(lastDisable(svc)?.level).toBe('error');
    });

    it('classifies a generic attach failure as attach_failed', async () => {
        process.env.SENCHO_MESH_SUBNET = '10.42.0.0/24';
        process.env.HOSTNAME = 'sencho';
        mockDocker({
            connectContainerToNetwork: vi.fn().mockRejectedValue(new Error('Docker daemon explosion')),
        });
        const svc = MeshService.getInstance();
        await callSetup(svc);
        expect(svc.getDataPlaneStatus().reason).toBe('attach_failed');
    });

    it('records the HOSTNAME-unset path as not_in_docker at level warn', async () => {
        process.env.SENCHO_MESH_SUBNET = '10.42.0.0/24';
        delete process.env.HOSTNAME;
        mockDocker();
        const svc = MeshService.getInstance();
        await callSetup(svc);
        const status = svc.getDataPlaneStatus();
        expect(status.ok).toBe(false);
        expect(status.reason).toBe('not_in_docker');
        const entry = lastDisable(svc);
        expect(entry?.level).toBe('warn');
        expect(entry?.details?.reason).toBe('not_in_docker');
    });

    it('records the 404-on-inspect path as not_in_docker at level warn', async () => {
        process.env.SENCHO_MESH_SUBNET = '10.42.0.0/24';
        process.env.HOSTNAME = 'laptop-hostname';
        mockDocker({
            connectContainerToNetwork: vi.fn().mockRejectedValue({ statusCode: 404, message: 'no such container' }),
        });
        const svc = MeshService.getInstance();
        await callSetup(svc);
        const status = svc.getDataPlaneStatus();
        expect(status.reason).toBe('not_in_docker');
        expect(lastDisable(svc)?.level).toBe('warn');
    });

    it('records success as ok', async () => {
        process.env.SENCHO_MESH_SUBNET = '10.42.0.0/24';
        process.env.HOSTNAME = 'sencho';
        mockDocker();
        const svc = MeshService.getInstance();
        await callSetup(svc);
        const status = svc.getDataPlaneStatus();
        expect(status.ok).toBe(true);
        expect(status.reason).toBe('ok');
        expect(status.subnet).toBe('10.42.0.0/24');
        expect(status.message).toBeNull();
    });

    it('preserves the legacy networkSetupError getter on failure', async () => {
        process.env.SENCHO_MESH_SUBNET = '10.42.0.0/24';
        process.env.HOSTNAME = 'sencho';
        mockDocker({
            createNetwork: vi.fn().mockRejectedValue(
                Object.assign(new Error('Pool overlaps with other one on this address space'), { statusCode: 500 }),
            ),
        });
        const svc = MeshService.getInstance();
        await callSetup(svc);
        expect(svc.getNetworkSetupError()).toMatch(/overlap/i);
    });
});

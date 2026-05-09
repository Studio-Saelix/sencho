import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { getSenchoIpFromSubnet } from '../services/MeshService';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM mesh_stacks').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
    const svc = MeshService.getInstance() as unknown as {
        aliasCache: Map<string, unknown>;
        aliasByPort: Map<number, unknown>;
        activity: unknown[];
        activeStreams: Map<number, unknown>;
        routeErrorMap: Map<string, unknown>;
        routeLatencyMap: Map<string, unknown>;
        senchoIp: string | null;
        meshSubnet: string;
        networkSetupError: string | null;
    };
    svc.aliasCache = new Map();
    svc.aliasByPort = new Map();
    svc.activity = [];
    svc.activeStreams = new Map();
    svc.routeErrorMap = new Map();
    svc.routeLatencyMap = new Map();
    svc.senchoIp = '172.30.0.2';
    svc.meshSubnet = '172.30.0.0/24';
    svc.networkSetupError = null;
    vi.restoreAllMocks();
});

describe('MeshService.optInStack', () => {
    it('writes a mesh_stacks row and rejects duplicate ports', async () => {
        const svc = MeshService.getInstance();

        vi.spyOn(svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
            .mockResolvedValue([{ service: 'db', ports: [5432] }]);
        vi.spyOn(svc as unknown as { regenerateOverridesForNode: (n: number) => Promise<void> }, 'regenerateOverridesForNode')
            .mockResolvedValue(undefined);

        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        await svc.optInStack(localNodeId, 'api', 'tester');
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(true);

        await expect(svc.optInStack(localNodeId, 'shadow', 'tester'))
            .rejects.toThrow(/port 5432 is already claimed/);
    });

    it('opt-out removes the row and the override', async () => {
        const svc = MeshService.getInstance();
        vi.spyOn(svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
            .mockResolvedValue([{ service: 'db', ports: [5432] }]);
        vi.spyOn(svc as unknown as { regenerateOverridesForNode: (n: number) => Promise<void> }, 'regenerateOverridesForNode')
            .mockResolvedValue(undefined);
        vi.spyOn(svc as unknown as { removeStackOverride: (n: number, s: string) => Promise<void> }, 'removeStackOverride')
            .mockResolvedValue(undefined);

        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        await svc.optInStack(localNodeId, 'api', 'tester');
        await svc.optOutStack(localNodeId, 'api', 'tester');
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(false);
    });

    it('rejects an invalid stack name (path traversal attempt)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        await expect(svc.optInStack(localNodeId, '../../etc/passwd', 'tester'))
            .rejects.toThrow(/invalid stack name/);
        expect(db.isMeshStackEnabled(localNodeId, '../../etc/passwd')).toBe(false);
    });

    it('forwarder binds every alias port across the fleet, not just local-owned ports', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const remoteNodeId = db.addNode({
            name: 'remote-pilot', type: 'remote', mode: 'pilot_agent',
            compose_dir: '/tmp', is_default: false, api_url: '', api_token: '',
        });

        // Seed local- and remote-owned aliases directly into
        // aliasByPort so we exercise syncForwarderListeners without a
        // live remote Sencho. The model: every meshed node binds every
        // alias port because meshed containers' extra_hosts:host-gateway
        // entries land on the SOURCE node's gateway, so the source node
        // is where the inbound TCP connection is intercepted.
        const aliasByPort = (svc as unknown as { aliasByPort: Map<number, unknown> }).aliasByPort;
        aliasByPort.set(9000, {
            host: 'echo.local-stack.Local.sencho',
            nodeId: localNodeId, nodeName: 'Local',
            stackName: 'local-stack', serviceName: 'echo', port: 9000,
        });
        aliasByPort.set(9001, {
            host: 'echo.remote-stack.remote-pilot.sencho',
            nodeId: remoteNodeId, nodeName: 'remote-pilot',
            stackName: 'remote-stack', serviceName: 'echo', port: 9001,
        });

        // Stub the forwarder so the test never touches a real net.Server.
        const listened: number[] = [];
        const fwd = (svc as unknown as {
            forwarder: { listen: (p: number) => Promise<void>; unlisten: (p: number) => Promise<void>; getListenerPorts: () => number[] };
        }).forwarder;
        const realListen = fwd.listen.bind(fwd);
        const realUnlisten = fwd.unlisten.bind(fwd);
        const realGetListenerPorts = fwd.getListenerPorts.bind(fwd);
        fwd.listen = async (p: number) => { listened.push(p); };
        fwd.unlisten = async () => { /* no-op */ };
        fwd.getListenerPorts = () => [...listened];

        try {
            await (svc as unknown as { syncForwarderListeners: () => Promise<void> }).syncForwarderListeners();
            expect(listened.sort()).toEqual([9000, 9001]);
        } finally {
            fwd.listen = realListen;
            fwd.unlisten = realUnlisten;
            fwd.getListenerPorts = realGetListenerPorts;
            aliasByPort.clear();
            db.deleteNode(remoteNodeId);
        }
    });
});

describe('MeshService activity log', () => {
    it('keeps the most recent events under the 1000-cap', () => {
        const svc = MeshService.getInstance();
        for (let i = 0; i < 1100; i++) {
            svc.logActivity({ source: 'mesh', level: 'info', type: 'opt_in', message: `evt-${i}` });
        }
        const all = svc.getActivity({ limit: 2000 });
        expect(all.length).toBe(1000);
        expect(all[0].message).toBe('evt-100');
        expect(all[all.length - 1].message).toBe('evt-1099');
    });

    it('filters by alias / source / level', () => {
        const svc = MeshService.getInstance();
        svc.logActivity({ source: 'mesh', level: 'info', type: 'opt_in', alias: 'a.b.c.sencho', message: 'a' });
        svc.logActivity({ source: 'pilot', level: 'error', type: 'tunnel.fail', alias: 'a.b.c.sencho', message: 'b' });
        svc.logActivity({ source: 'mesh', level: 'info', type: 'route.resolve.ok', alias: 'x.y.z.sencho', message: 'c' });

        expect(svc.getActivity({ alias: 'a.b.c.sencho' }).length).toBe(2);
        expect(svc.getActivity({ source: 'pilot' }).length).toBe(1);
        expect(svc.getActivity({ level: 'error' }).length).toBe(1);
    });

    it('subscribeActivity fires for new events and unsubscribes cleanly', () => {
        const svc = MeshService.getInstance();
        const seen: string[] = [];
        const unsubscribe = svc.subscribeActivity((e) => seen.push(e.message));
        svc.logActivity({ source: 'mesh', level: 'info', type: 'mesh.enable', message: 'one' });
        unsubscribe();
        svc.logActivity({ source: 'mesh', level: 'info', type: 'mesh.disable', message: 'two' });
        expect(seen).toEqual(['one']);
    });
});

describe('MeshService.testUpstream tunnel-down path', () => {
    it('returns ok:false where=pilot_tunnel when no tunnel is registered', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const remoteNodeId = db.addNode({
            name: 'opsix', type: 'remote', is_default: false,
            compose_dir: '/tmp', api_url: 'https://opsix.example',
            api_token: 'tok', mode: 'pilot_agent',
        });

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['db.api.opsix.sencho', {
                host: 'db.api.opsix.sencho',
                nodeId: remoteNodeId,
                nodeName: 'opsix',
                stackName: 'api',
                serviceName: 'db',
                port: 5432,
            }],
        ]);
        db.insertMeshStack(remoteNodeId, 'api', 'tester');

        const result = await svc.testUpstream('db.api.opsix.sencho', localNodeId);
        expect(result.ok).toBe(false);
        expect(result.where).toBe('pilot_tunnel');
        expect(result.code).toBe('tunnel_down');
    });

    it('returns ok:false where=agent_resolve when target stack is not opted in', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['db.api.opsix.sencho', {
                host: 'db.api.opsix.sencho',
                nodeId: localNodeId,
                nodeName: 'opsix',
                stackName: 'api',
                serviceName: 'db',
                port: 5432,
            }],
        ]);

        const result = await svc.testUpstream('db.api.opsix.sencho', localNodeId);
        expect(result.ok).toBe(false);
        expect(result.where).toBe('agent_resolve');
        expect(result.code).toBe('denied');
    });

    it('returns ok:false where=sidecar when alias is unknown', async () => {
        const svc = MeshService.getInstance();
        const localNodeId = DatabaseService.getInstance().getNodes()[0].id;

        const result = await svc.testUpstream('nonexistent.sencho', localNodeId);
        expect(result.ok).toBe(false);
        expect(result.where).toBe('no_route');
        expect(result.code).toBe('no_route');
    });
});

describe('getSenchoIpFromSubnet', () => {
    it('returns network+2 for the default /24', () => {
        expect(getSenchoIpFromSubnet('172.30.0.0/24')).toBe('172.30.0.2');
    });

    it('handles a custom /24 in a different range', () => {
        expect(getSenchoIpFromSubnet('10.42.7.0/24')).toBe('10.42.7.2');
    });

    it('handles a /16', () => {
        expect(getSenchoIpFromSubnet('172.30.0.0/16')).toBe('172.30.0.2');
    });

    it('masks the input IP to the network address before adding 2', () => {
        // 172.30.0.50/24 → network 172.30.0.0 → +2 = 172.30.0.2
        expect(getSenchoIpFromSubnet('172.30.0.50/24')).toBe('172.30.0.2');
    });

    it('rejects a malformed CIDR', () => {
        expect(() => getSenchoIpFromSubnet('not-a-cidr')).toThrow(/Invalid mesh subnet/);
        expect(() => getSenchoIpFromSubnet('172.30.0.0')).toThrow(/Invalid mesh subnet/);
    });

    it('rejects prefixes too narrow to host two addresses', () => {
        expect(() => getSenchoIpFromSubnet('172.30.0.0/31')).toThrow(/Invalid mesh subnet/);
    });

    it('rejects out-of-range octets', () => {
        expect(() => getSenchoIpFromSubnet('172.30.0.999/24')).toThrow(/Invalid mesh subnet/);
    });
});

describe('MeshService.ensureMeshNetwork', () => {
    it('refuses to continue when sencho_mesh exists with a different subnet', async () => {
        const svc = MeshService.getInstance();
        const dcModule = await import('../services/DockerController');
        const fakeController = {
            createNetwork: vi.fn().mockRejectedValue({ statusCode: 409, message: 'network already exists' }),
            inspectNetwork: vi.fn().mockResolvedValue({ IPAM: { Config: [{ Subnet: '10.99.0.0/24' }] } }),
        };
        vi.spyOn(dcModule.default, 'getInstance').mockReturnValue(fakeController as unknown as ReturnType<typeof dcModule.default.getInstance>);

        await expect(
            (svc as unknown as { ensureMeshNetwork: (s: string) => Promise<void> }).ensureMeshNetwork('172.30.0.0/24'),
        ).rejects.toThrow(/exists with subnet 10\.99\.0\.0\/24/);
    });

    it('treats 409 with matching subnet as idempotent success', async () => {
        const svc = MeshService.getInstance();
        const dcModule = await import('../services/DockerController');
        const fakeController = {
            createNetwork: vi.fn().mockRejectedValue({ statusCode: 409, message: 'network already exists' }),
            inspectNetwork: vi.fn().mockResolvedValue({ IPAM: { Config: [{ Subnet: '172.30.0.0/24' }] } }),
        };
        vi.spyOn(dcModule.default, 'getInstance').mockReturnValue(fakeController as unknown as ReturnType<typeof dcModule.default.getInstance>);

        await expect(
            (svc as unknown as { ensureMeshNetwork: (s: string) => Promise<void> }).ensureMeshNetwork('172.30.0.0/24'),
        ).resolves.toBeUndefined();
    });
});

describe('MeshService.optInStack rollback', () => {
    it('rolls back the DB row when the just-inserted stack fails to push its override', async () => {
        const svc = MeshService.getInstance();
        vi.spyOn(svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
            .mockResolvedValue([{ service: 'db', ports: [5432] }]);
        vi.spyOn(svc, 'pushOverrideToNode')
            .mockRejectedValue(new Error('simulated remote pilot offline'));
        vi.spyOn(svc as unknown as { triggerRedeploy: (n: number, s: string, a: string) => void }, 'triggerRedeploy')
            .mockImplementation(() => { /* noop */ });

        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        await expect(svc.optInStack(localNodeId, 'api', 'tester'))
            .rejects.toThrow(/simulated remote pilot offline/);
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(false);
    });
});

describe('MeshService.optInStack guard rails (network setup)', () => {
    it('rejects opt-in when senchoIp is null (mesh data plane unavailable)', async () => {
        const svc = MeshService.getInstance();
        (svc as unknown as { senchoIp: string | null }).senchoIp = null;
        (svc as unknown as { networkSetupError: string | null }).networkSetupError = 'sencho_mesh subnet mismatch';

        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        await expect(svc.optInStack(localNodeId, 'api', 'tester'))
            .rejects.toThrow(/sencho_mesh subnet mismatch/);
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(false);
    });

    it('rejects opt-in when a service exposes the reserved Sencho API port', async () => {
        const svc = MeshService.getInstance();
        vi.spyOn(svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
            .mockResolvedValue([{ service: 'web', ports: [1852] }]);
        vi.spyOn(svc as unknown as { regenerateOverridesForNode: (n: number) => Promise<void> }, 'regenerateOverridesForNode')
            .mockResolvedValue(undefined);

        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        await expect(svc.optInStack(localNodeId, 'api', 'tester'))
            .rejects.toThrow(/port 1852 is reserved/);
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(false);
    });
});

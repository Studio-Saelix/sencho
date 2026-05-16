import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fsSync from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { getSenchoIpFromSubnet, MeshError, type MeshTarget, type MeshTcpStreamLike } from '../services/MeshService';

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
        selfCentralNodeId: number | null;
        proxyTunnelSelfCentralNodeId: number | null;
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
    svc.selfCentralNodeId = null;
    svc.proxyTunnelSelfCentralNodeId = null;
    delete process.env.SENCHO_ENROLL_TOKEN;
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

    it('rejects opt-in when every service declared empty ports (no routable target)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        vi.spyOn(svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
            .mockResolvedValue([
                { service: 'web', ports: [] },
                { service: 'db', ports: [] },
            ]);
        vi.spyOn(svc as unknown as { regenerateOverridesForNode: (n: number) => Promise<void> }, 'regenerateOverridesForNode')
            .mockResolvedValue(undefined);

        await expect(svc.optInStack(localNodeId, 'silent', 'tester'))
            .rejects.toThrow(/no service ports to mesh/);
        // Pre-fix this wrote a row with no aliases and the stack appeared
        // "online but doesn't route". Verify the row was not written.
        expect(db.isMeshStackEnabled(localNodeId, 'silent')).toBe(false);
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

    it('probes a proxy-mode remote via PilotTunnelManager.ensureBridge (bridge dialed on demand)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const remoteNodeId = db.addNode({
            name: 'edge', type: 'remote', is_default: false,
            compose_dir: '/tmp', api_url: 'https://edge.example',
            api_token: 'tok', mode: 'proxy',
        });

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['db.api.edge.sencho', {
                host: 'db.api.edge.sencho',
                nodeId: remoteNodeId,
                nodeName: 'edge',
                stackName: 'api',
                serviceName: 'db',
                port: 5432,
            }],
        ]);
        db.insertMeshStack(remoteNodeId, 'api', 'tester');

        const { PilotTunnelManager } = await import('../services/PilotTunnelManager');
        const fakeStream = new EventEmitter() as EventEmitter & { destroy: () => void };
        fakeStream.destroy = vi.fn();
        const fakeBridge = {
            openTcpStream: vi.fn().mockReturnValue(fakeStream),
            getActiveStreamCount: () => 0,
            close: vi.fn(),
        };
        vi.spyOn(PilotTunnelManager.getInstance(), 'ensureBridge')
            .mockResolvedValue(fakeBridge as unknown as Awaited<ReturnType<typeof PilotTunnelManager.prototype.ensureBridge>>);

        const probe = svc.testUpstream('db.api.edge.sencho', localNodeId);
        // Emit `open` so the probe resolves cleanly.
        setImmediate(() => fakeStream.emit('open'));
        const result = await probe;

        expect(fakeBridge.openTcpStream).toHaveBeenCalledWith({ stack: 'api', service: 'db', port: 5432 });
        expect(result.ok).toBe(true);

        db.deleteNode(remoteNodeId);
    });

    it('returns ok:false where=pilot_tunnel when ensureBridge yields null (no reachable bridge)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const remoteNodeId = db.addNode({
            name: 'edge2', type: 'remote', is_default: false,
            compose_dir: '/tmp', api_url: 'https://edge2.example',
            api_token: 'tok', mode: 'proxy',
        });

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['db.api.edge2.sencho', {
                host: 'db.api.edge2.sencho',
                nodeId: remoteNodeId,
                nodeName: 'edge2',
                stackName: 'api',
                serviceName: 'db',
                port: 5432,
            }],
        ]);
        db.insertMeshStack(remoteNodeId, 'api', 'tester');

        const { PilotTunnelManager } = await import('../services/PilotTunnelManager');
        vi.spyOn(PilotTunnelManager.getInstance(), 'ensureBridge').mockResolvedValue(null);

        const result = await svc.testUpstream('db.api.edge2.sencho', localNodeId);
        expect(result.ok).toBe(false);
        expect(result.where).toBe('pilot_tunnel');
        expect(result.code).toBe('tunnel_down');

        db.deleteNode(remoteNodeId);
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

describe('MeshService.regenerateAllOverrides (F6: boot-time regen)', () => {
    it('pushes every mesh_stacks row across the fleet and returns a summary', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const remoteNodeId = db.addNode({
            name: 'remote-pilot', type: 'remote', mode: 'pilot_agent',
            compose_dir: '/tmp', is_default: false, api_url: '', api_token: '',
        });

        db.insertMeshStack(localNodeId, 'audit-mesh-prod', 'tester');
        db.insertMeshStack(remoteNodeId, 'audit-mesh-pilot', 'tester');

        const pushSpy = vi.spyOn(svc, 'pushOverrideToNode').mockResolvedValue(undefined);

        try {
            const summary = await svc.regenerateAllOverrides();

            expect(summary.skipped).toBe(false);
            expect(summary.regenerated).toBe(2);
            expect(summary.failures).toEqual([]);

            expect(pushSpy).toHaveBeenCalledTimes(2);
            expect(pushSpy).toHaveBeenCalledWith(localNodeId, 'audit-mesh-prod');
            expect(pushSpy).toHaveBeenCalledWith(remoteNodeId, 'audit-mesh-pilot');

            const activity = svc.getActivity({ limit: 100 });
            expect(activity.some((e) =>
                e.message === 'mesh override regen complete: 2 succeeded, 0 failed across 0 node(s)',
            )).toBe(true);
        } finally {
            db.deleteNode(remoteNodeId);
        }
    });

    it('skips entirely with a reason when senchoIp is null (network setup failed)', async () => {
        const svc = MeshService.getInstance();
        (svc as unknown as { senchoIp: string | null }).senchoIp = null;
        (svc as unknown as { networkSetupError: string | null }).networkSetupError = 'sencho_mesh subnet mismatch';

        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        db.insertMeshStack(localNodeId, 'audit-mesh-prod', 'tester');

        const pushSpy = vi.spyOn(svc, 'pushOverrideToNode').mockResolvedValue(undefined);

        const summary = await svc.regenerateAllOverrides();

        expect(summary.skipped).toBe(true);
        expect(summary.reason).toBe('sencho_mesh subnet mismatch');
        expect(summary.regenerated).toBe(0);
        expect(pushSpy).not.toHaveBeenCalled();

        const activity = svc.getActivity({ limit: 100 });
        expect(activity.some((e) =>
            e.level === 'warn' && /data plane unavailable/.test(e.message),
        )).toBe(true);
    });

    it('records per-stack failures in the summary and aggregates by node', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        db.insertMeshStack(localNodeId, 'audit-mesh-prod', 'tester');

        vi.spyOn(svc, 'pushOverrideToNode').mockRejectedValue(new Error('remote node offline'));

        const summary = await svc.regenerateAllOverrides();

        expect(summary.skipped).toBe(false);
        expect(summary.regenerated).toBe(0);
        expect(summary.failures).toEqual([{
            nodeId: localNodeId,
            stackName: 'audit-mesh-prod',
            message: 'remote node offline',
        }]);

        const activity = svc.getActivity({ limit: 100 });
        expect(activity.some((e) =>
            e.level === 'warn' && /mesh override regen failed for audit-mesh-prod/.test(e.message),
        )).toBe(true);
        expect(activity.some((e) =>
            /mesh override regen complete: 0 succeeded, 1 failed across 1 node\(s\)/.test(e.message),
        )).toBe(true);
    });

    it('continues past version-skew 404 push failures and reports them in the summary', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const remoteNodeId = db.addNode({
            name: 'remote-old-pilot', type: 'remote', mode: 'pilot_agent',
            compose_dir: '/tmp', is_default: false, api_url: '', api_token: '',
        });

        db.insertMeshStack(localNodeId, 'audit-mesh-prod', 'tester');
        db.insertMeshStack(remoteNodeId, 'audit-mesh-pilot', 'tester');

        vi.spyOn(svc, 'pushOverrideToNode').mockImplementation(async (nodeId: number) => {
            if (nodeId === remoteNodeId) {
                throw new MeshError('push_failed', 'node remote-old-pilot does not support mesh override push (upgrade required)');
            }
        });

        try {
            const summary = await svc.regenerateAllOverrides();

            expect(summary.regenerated).toBe(1);
            expect(summary.failures).toHaveLength(1);
            expect(summary.failures[0].nodeId).toBe(remoteNodeId);
            expect(summary.failures[0].stackName).toBe('audit-mesh-pilot');
            expect(summary.failures[0].message).toMatch(/upgrade required/);
        } finally {
            db.deleteNode(remoteNodeId);
        }
    });

    it('completes both flows without throwing when regen and opt-in are scheduled concurrently', async () => {
        // The race is benign by design: both writes target the same alias list
        // with the same `senchoIp`, so even if regen reads `mesh_stacks` mid-
        // opt-in and pushes a concurrent override for the new stack, the
        // resulting on-disk file is identical. This test locks the no-throw
        // contract; it does not attempt to force a specific interleave because
        // `regenerateAllOverrides` snapshots the table synchronously before
        // its first await, so under the JS event loop the two flows always
        // resolve cleanly without a real read-after-write window.
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        db.insertMeshStack(localNodeId, 'existing-stack', 'tester');

        vi.spyOn(svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
            .mockResolvedValue([{ service: 'web', ports: [8080] }]);
        const pushSpy = vi.spyOn(svc, 'pushOverrideToNode').mockResolvedValue(undefined);
        vi.spyOn(svc as unknown as { triggerRedeploy: (n: number, s: string, a: string) => void }, 'triggerRedeploy')
            .mockImplementation(() => { /* noop */ });
        vi.spyOn(svc as unknown as { regenerateOverridesForNode: (n: number, skip?: string) => Promise<void> }, 'regenerateOverridesForNode')
            .mockResolvedValue(undefined);

        const [summary] = await Promise.all([
            svc.regenerateAllOverrides(),
            svc.optInStack(localNodeId, 'concurrent-stack', 'tester'),
        ]);

        expect(summary.regenerated).toBeGreaterThanOrEqual(1);
        expect(db.isMeshStackEnabled(localNodeId, 'concurrent-stack')).toBe(true);

        const existingCalls = pushSpy.mock.calls.filter((c) => c[1] === 'existing-stack');
        expect(existingCalls.length).toBeGreaterThanOrEqual(1);
        const concurrentCalls = pushSpy.mock.calls.filter((c) => c[1] === 'concurrent-stack');
        expect(concurrentCalls.length).toBeGreaterThanOrEqual(1);
    });
});

describe('MeshService.getDeclaredStackServiceNames (BUG-1)', () => {
    function writeStackFile(stack: string, contents: string): void {
        const composeDir = process.env.COMPOSE_DIR as string;
        const dir = path.join(composeDir, stack);
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(path.join(dir, 'compose.yaml'), contents, 'utf8');
    }

    it('returns the keys of the compose services map', async () => {
        const svc = MeshService.getInstance();
        writeStackFile('declared-stack', [
            'services:',
            '  echo:',
            '    image: busybox:latest',
            '    expose: ["9000"]',
            '  prober:',
            '    image: busybox:latest',
        ].join('\n'));

        const names = await svc.getDeclaredStackServiceNames('declared-stack');
        expect(names.sort()).toEqual(['echo', 'prober']);
    });

    it('returns [] when the compose file is missing', async () => {
        const svc = MeshService.getInstance();
        const names = await svc.getDeclaredStackServiceNames('does-not-exist');
        expect(names).toEqual([]);
    });

    it('returns [] for an invalid stack name (path traversal attempt)', async () => {
        const svc = MeshService.getInstance();
        const names = await svc.getDeclaredStackServiceNames('../etc/passwd');
        expect(names).toEqual([]);
    });

    it('returns [] when YAML has no services key', async () => {
        const svc = MeshService.getInstance();
        writeStackFile('no-services', 'version: "3.9"\n');
        const names = await svc.getDeclaredStackServiceNames('no-services');
        expect(names).toEqual([]);
    });
});

describe('MeshService.ensureStackOverride (BUG-1 fix)', () => {
    function writeStackFile(stack: string, contents: string): void {
        const composeDir = process.env.COMPOSE_DIR as string;
        const dir = path.join(composeDir, stack);
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(path.join(dir, 'compose.yaml'), contents, 'utf8');
    }

    it('writes a non-empty services map sourced from the compose file (BUG-1 case)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        writeStackFile('audit-mesh-prod', [
            'services:',
            '  echo:',
            '    image: busybox:latest',
            '  prober:',
            '    image: busybox:latest',
        ].join('\n'));

        // The override generator must derive services from the compose
        // file, not from runtime containers. Spy on
        // inspectLocalStackServices to assert it is NOT consulted by the
        // override-write path (regression guard).
        const inspectSpy = vi.spyOn(svc, 'inspectLocalStackServices').mockResolvedValue([]);
        db.insertMeshStack(localNodeId, 'audit-mesh-prod', 'tester');

        const overridePath = await svc.ensureStackOverride(localNodeId, 'audit-mesh-prod');
        expect(overridePath).not.toBeNull();
        const yaml = fsSync.readFileSync(overridePath as string, 'utf8');
        expect(yaml).toContain('echo:');
        expect(yaml).toContain('prober:');
        expect(yaml).toContain('sencho_mesh');
        expect(yaml).not.toMatch(/^services:\s*\{\}/m);
        expect(inspectSpy).not.toHaveBeenCalled();
    });

    it('preserves an existing non-empty override when declared services come back empty', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        // No compose file on disk; getDeclaredStackServiceNames returns [].
        // Pre-seed an existing override file with a populated services map.
        const dataDir = process.env.DATA_DIR as string;
        const overrideDir = path.join(dataDir, 'mesh', 'overrides', String(localNodeId));
        fsSync.mkdirSync(overrideDir, { recursive: true });
        const overrideFile = path.join(overrideDir, 'orphaned-stack.override.yml');
        fsSync.writeFileSync(overrideFile, [
            'services:',
            '  webapp:',
            '    networks:',
            '      - sencho_mesh',
            'networks:',
            '  sencho_mesh:',
            '    external: true',
        ].join('\n'), 'utf8');
        const originalContent = fsSync.readFileSync(overrideFile, 'utf8');

        db.insertMeshStack(localNodeId, 'orphaned-stack', 'tester');

        const result = await svc.ensureStackOverride(localNodeId, 'orphaned-stack');
        expect(result).toBe(overrideFile);

        const after = fsSync.readFileSync(overrideFile, 'utf8');
        expect(after).toBe(originalContent);

        const activity = svc.getActivity({ limit: 100 });
        expect(activity.some((e) =>
            e.type === 'mesh.override.preserved'
            && /orphaned-stack/.test(e.message),
        )).toBe(true);
    });

    it('returns a pushed override file on pilot nodes where isMeshStackEnabled is always false', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        // Simulate the pilot scenario: no mesh_stacks row (isMeshStackEnabled → false),
        // but the override file already exists on disk, pushed by central via D-1.
        const dataDir = process.env.DATA_DIR as string;
        const overrideDir = path.join(dataDir, 'mesh', 'overrides', String(localNodeId));
        fsSync.mkdirSync(overrideDir, { recursive: true });
        const overrideFile = path.join(overrideDir, 'pilot-stack.override.yml');
        fsSync.writeFileSync(overrideFile, [
            'services:',
            '  echo:',
            '    networks:',
            '      - sencho_mesh',
            '    extra_hosts:',
            '      - echo.pilot-stack.pilot.sencho:172.30.0.2',
            'networks:',
            '  sencho_mesh:',
            '    external: true',
        ].join('\n'), 'utf8');

        // No mesh_stacks row → isMeshStackEnabled returns false.
        const result = await svc.ensureStackOverride(localNodeId, 'pilot-stack');
        expect(result).toBe(overrideFile);

        // Cleanup.
        fsSync.unlinkSync(overrideFile);
    });

    it('returns null for pilot nodes when no pushed override file exists', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        // No mesh_stacks row, no file on disk.
        const result = await svc.ensureStackOverride(localNodeId, 'no-such-stack');
        expect(result).toBeNull();
    });
});

describe('MeshService tunnel-up regen (BUG-2)', () => {
    it('triggers regenerateOverridesForNode for the firing nodeId once tunnel comes up', async () => {
        const svc = MeshService.getInstance();
        const ptm = (await import('../services/PilotTunnelManager')).PilotTunnelManager.getInstance() as unknown as EventEmitter;

        const regenSpy = vi.spyOn(
            svc as unknown as { regenerateOverridesForNode: (n: number) => Promise<void> },
            'regenerateOverridesForNode',
        ).mockResolvedValue(undefined);

        // Drive start() while stubbing the heavy bits. setupMeshNetwork
        // is what actually creates the bridge network; refreshAliasCache
        // and syncForwarderListeners would touch real Dockerode and net
        // state. regenerateAllOverrides we stub so the test only
        // exercises the tunnel-up listener.
        const internals = svc as unknown as {
            started: boolean;
            setupMeshNetwork: () => Promise<void>;
            refreshAliasCache: () => Promise<void>;
            syncForwarderListeners: () => Promise<void>;
            regenerateAllOverrides: () => Promise<unknown>;
            aliasRefreshTimer: NodeJS.Timeout | undefined;
        };
        internals.started = false;
        const origNetwork = internals.setupMeshNetwork.bind(svc);
        const origRefresh = internals.refreshAliasCache.bind(svc);
        const origSync = internals.syncForwarderListeners.bind(svc);
        const origRegenAll = internals.regenerateAllOverrides.bind(svc);
        internals.setupMeshNetwork = vi.fn().mockResolvedValue(undefined);
        internals.refreshAliasCache = vi.fn().mockResolvedValue(undefined);
        internals.syncForwarderListeners = vi.fn().mockResolvedValue(undefined);
        internals.regenerateAllOverrides = vi.fn().mockResolvedValue({ regenerated: 0, failures: [], skipped: false });

        try {
            await svc.start();
            ptm.emit('tunnel-up', 14);
            // Give the void-promise chain a tick to invoke the spy.
            await new Promise((r) => setImmediate(r));

            expect(regenSpy).toHaveBeenCalledWith(14);

            const activity = svc.getActivity({ limit: 50 });
            expect(activity.some((e) =>
                e.type === 'tunnel.open' && e.nodeId === 14,
            )).toBe(true);
        } finally {
            internals.setupMeshNetwork = origNetwork;
            internals.refreshAliasCache = origRefresh;
            internals.syncForwarderListeners = origSync;
            internals.regenerateAllOverrides = origRegenAll;
            internals.started = false;
            if (internals.aliasRefreshTimer) {
                clearInterval(internals.aliasRefreshTimer);
                internals.aliasRefreshTimer = undefined;
            }
            // Drain any tunnel-up listeners we registered during start().
            ptm.removeAllListeners('tunnel-up');
            ptm.removeAllListeners('tunnel-down');
        }
    });
});

describe('MeshService.openCrossNode (BUG-4)', () => {
    function makeFakeStream(streamId: number): MeshTcpStreamLike & EventEmitter {
        const ee = new EventEmitter() as MeshTcpStreamLike & EventEmitter & { destroyed: boolean };
        ee.destroyed = false;
        Object.defineProperty(ee, 'streamId', { value: streamId, writable: false });
        ee.write = vi.fn().mockReturnValue(true);
        ee.end = vi.fn();
        ee.destroy = vi.fn(() => { ee.destroyed = true; });
        return ee;
    }

    function makeFakeSocket(): { destroy: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } {
        return {
            destroy: vi.fn(),
            end: vi.fn(),
            on: vi.fn(),
            write: vi.fn(),
        };
    }

    // Install a stub reverseDialer so openCrossNode skips the peer-side
    // bootstrap path (PeerToCentralMeshSessionDialer.ensureSession). The
    // dispatch behavior under test relies on dialMeshTcpStream being called
    // directly; the bootstrap kick would short-circuit before that mock fires.
    const stubDialer = { openMeshTcpStream: vi.fn() };
    beforeEach(() => { MeshService.getInstance().setReverseDialer(stubDialer); });
    afterEach(() => { MeshService.getInstance().setReverseDialer(null); });

    it('emits route.dispatch immediately on cross-node entry', async () => {
        const svc = MeshService.getInstance();
        const target: MeshTarget = {
            nodeId: 14, stack: 'audit-mesh-pilot', service: 'echo',
            port: 9001, alias: 'echo.audit-mesh-pilot.sencho-pilot-test.sencho',
        };
        const fakeStream = makeFakeStream(42);
        vi.spyOn(
            svc as unknown as { dialMeshTcpStream: (t: MeshTarget) => MeshTcpStreamLike | null },
            'dialMeshTcpStream',
        ).mockReturnValue(fakeStream);

        const fakeSrc = makeFakeSocket();
        // openCrossNode is private; cast to call it.
        (svc as unknown as { openCrossNode: (t: MeshTarget, s: unknown) => void })
            .openCrossNode(target, fakeSrc);

        const dispatch = svc.getActivity({ limit: 50 }).find((e) => e.type === 'route.dispatch');
        expect(dispatch).toBeDefined();
        expect(dispatch?.alias).toBe(target.alias);
        expect(dispatch?.nodeId).toBe(14);
        // Clean up the open-timer so the test process exits cleanly.
        fakeStream.emit('close');
    });

    it('emits tunnel.fail after PROBE_TIMEOUT_MS when tcp_open_ack never arrives', async () => {
        vi.useFakeTimers();
        try {
            const svc = MeshService.getInstance();
            const target: MeshTarget = {
                nodeId: 14, stack: 'audit-mesh-pilot', service: 'echo',
                port: 9001, alias: 'echo.audit-mesh-pilot.sencho-pilot-test.sencho',
            };
            const fakeStream = makeFakeStream(43);
            vi.spyOn(
                svc as unknown as { dialMeshTcpStream: (t: MeshTarget) => MeshTcpStreamLike | null },
                'dialMeshTcpStream',
            ).mockReturnValue(fakeStream);

            const fakeSrc = makeFakeSocket();
            (svc as unknown as { openCrossNode: (t: MeshTarget, s: unknown) => void })
                .openCrossNode(target, fakeSrc);

            // Before the timeout, only route.dispatch should be present.
            expect(svc.getActivity({ limit: 50 }).some((e) => e.type === 'route.resolve.ok')).toBe(false);

            await vi.advanceTimersByTimeAsync(5_000);

            const events = svc.getActivity({ limit: 50 });
            const timeoutEvent = events.find((e) =>
                e.type === 'tunnel.fail' && /timed out waiting for tcp_open_ack/.test(e.message),
            );
            expect(timeoutEvent).toBeDefined();
            expect(timeoutEvent?.nodeId).toBe(14);
            expect(timeoutEvent?.alias).toBe(target.alias);
            expect(fakeStream.destroy).toHaveBeenCalled();
            expect(fakeSrc.destroy).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('MeshService pilot handleAccept dispatch', () => {
    function makeEnrollToken(nodeId: number): string {
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ scope: 'pilot_enroll', nodeId })).toString('base64url');
        return `${header}.${payload}.fakesig`;
    }

    it('resolveSelfCentralNodeId extracts nodeId from SENCHO_ENROLL_TOKEN', () => {
        process.env.SENCHO_ENROLL_TOKEN = makeEnrollToken(14);
        const svc = MeshService.getInstance() as unknown as {
            resolveSelfCentralNodeId: () => number;
        };
        expect(svc.resolveSelfCentralNodeId()).toBe(14);
    });

    it('resolveSelfCentralNodeId falls back to local default when token is absent', () => {
        delete process.env.SENCHO_ENROLL_TOKEN;
        const svc = MeshService.getInstance() as unknown as {
            resolveSelfCentralNodeId: () => number;
        };
        const db = DatabaseService.getInstance();
        const defaultId = db.getDefaultNode()?.id ?? 1;
        expect(svc.resolveSelfCentralNodeId()).toBe(defaultId);
    });

    it('resolveSelfCentralNodeId falls back to local default for a malformed token', () => {
        process.env.SENCHO_ENROLL_TOKEN = 'not.a.jwt';
        const svc = MeshService.getInstance() as unknown as {
            resolveSelfCentralNodeId: () => number;
        };
        const db = DatabaseService.getInstance();
        const defaultId = db.getDefaultNode()?.id ?? 1;
        expect(svc.resolveSelfCentralNodeId()).toBe(defaultId);
    });

    it('handleAccept routes same-node alias to openSameNode on a pilot', async () => {
        const svc = MeshService.getInstance();
        const internals = svc as unknown as {
            selfCentralNodeId: number | null;
            aliasByPort: Map<number, unknown>;
            openSameNode: (t: MeshTarget, s: unknown) => Promise<void>;
            openCrossNode: (t: MeshTarget, s: unknown) => void;
        };
        internals.selfCentralNodeId = 14;
        internals.aliasByPort.set(9001, {
            host: 'echo.audit-mesh-pilot.sencho-pilot-test.sencho',
            nodeId: 14,
            nodeName: 'sencho-pilot-test',
            stackName: 'audit-mesh-pilot',
            serviceName: 'echo',
            port: 9001,
        });

        const openSame = vi.spyOn(internals, 'openSameNode').mockResolvedValue(undefined);
        const openCross = vi.spyOn(internals, 'openCrossNode').mockImplementation(() => undefined);
        const fakeSrc = { remoteAddress: '127.0.0.1', destroy: vi.fn() } as unknown as import('net').Socket;

        await svc.handleAccept(9001, fakeSrc);

        expect(openSame).toHaveBeenCalledOnce();
        expect(openCross).not.toHaveBeenCalled();
    });

    it('handleAccept routes cross-node alias to openCrossNode on a pilot', async () => {
        const svc = MeshService.getInstance();
        const internals = svc as unknown as {
            selfCentralNodeId: number | null;
            aliasByPort: Map<number, unknown>;
            openSameNode: (t: MeshTarget, s: unknown) => Promise<void>;
            openCrossNode: (t: MeshTarget, s: unknown) => void;
        };
        internals.selfCentralNodeId = 14;
        internals.aliasByPort.set(9000, {
            host: 'echo.audit-mesh-prod.Local.sencho',
            nodeId: 1,
            nodeName: 'Local',
            stackName: 'audit-mesh-prod',
            serviceName: 'echo',
            port: 9000,
        });

        const openSame = vi.spyOn(internals, 'openSameNode').mockResolvedValue(undefined);
        const openCross = vi.spyOn(internals, 'openCrossNode').mockImplementation(() => undefined);
        const fakeSrc = { remoteAddress: '127.0.0.1', destroy: vi.fn() } as unknown as import('net').Socket;

        await svc.handleAccept(9000, fakeSrc);

        expect(openCross).toHaveBeenCalledOnce();
        expect(openSame).not.toHaveBeenCalled();
    });

    it('handleAccept on a proxy peer uses proxyTunnelSelfCentralNodeId to route cross-node aliases correctly (R1)', async () => {
        // Repro for the R1 bug: a proxy peer receives an overlay carrying
        // central-namespace nodeIds (e.g., Local = 1, this peer = 14). Pre-R1
        // the peer had no selfCentralNodeId source, fell back to its local DB
        // default (always 1), and falsely matched alias.nodeId=1 to its own
        // selfNodeId=1 — dispatching cross-node aliases as same-node.
        const svc = MeshService.getInstance();
        const internals = svc as unknown as {
            proxyTunnelSelfCentralNodeId: number | null;
            selfCentralNodeId: number | null;
            aliasByPort: Map<number, unknown>;
            openSameNode: (t: MeshTarget, s: unknown) => Promise<void>;
            openCrossNode: (t: MeshTarget, s: unknown) => void;
        };
        // Proxy peer: selfCentralNodeId is null (no SENCHO_ENROLL_TOKEN),
        // the proxy-tunnel handler installed central's view of this peer.
        internals.selfCentralNodeId = null;
        svc.setProxyTunnelSelfCentralNodeId(14);
        // Overlay alias for central's own stack (Local = nodeId 1 in
        // central's namespace).
        internals.aliasByPort.set(9000, {
            host: 'echo.audit-mesh-central.Local.sencho',
            nodeId: 1,
            nodeName: 'Local',
            stackName: 'audit-mesh-central',
            serviceName: 'echo',
            port: 9000,
        });

        const openSame = vi.spyOn(internals, 'openSameNode').mockResolvedValue(undefined);
        const openCross = vi.spyOn(internals, 'openCrossNode').mockImplementation(() => undefined);
        const fakeSrc = { remoteAddress: '127.0.0.1', destroy: vi.fn() } as unknown as import('net').Socket;

        await svc.handleAccept(9000, fakeSrc);

        expect(openCross).toHaveBeenCalledOnce();
        expect(openSame).not.toHaveBeenCalled();
    });

    it('handleAccept on a proxy peer routes same-node aliases (matching the proxy-tunnel nodeId) to openSameNode', async () => {
        const svc = MeshService.getInstance();
        const internals = svc as unknown as {
            proxyTunnelSelfCentralNodeId: number | null;
            selfCentralNodeId: number | null;
            aliasByPort: Map<number, unknown>;
            openSameNode: (t: MeshTarget, s: unknown) => Promise<void>;
            openCrossNode: (t: MeshTarget, s: unknown) => void;
        };
        internals.selfCentralNodeId = null;
        svc.setProxyTunnelSelfCentralNodeId(14);
        // Alias for a stack on this peer (nodeId 14 in central's namespace).
        internals.aliasByPort.set(9002, {
            host: 'echo.audit-mesh-proxy.sencho-test-03.sencho',
            nodeId: 14,
            nodeName: 'sencho-test-03',
            stackName: 'audit-mesh-proxy',
            serviceName: 'echo',
            port: 9002,
        });

        const openSame = vi.spyOn(internals, 'openSameNode').mockResolvedValue(undefined);
        const openCross = vi.spyOn(internals, 'openCrossNode').mockImplementation(() => undefined);
        const fakeSrc = { remoteAddress: '127.0.0.1', destroy: vi.fn() } as unknown as import('net').Socket;

        await svc.handleAccept(9002, fakeSrc);

        expect(openSame).toHaveBeenCalledOnce();
        expect(openCross).not.toHaveBeenCalled();
    });
});

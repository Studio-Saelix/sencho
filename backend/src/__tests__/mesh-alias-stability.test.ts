/**
 * Alias and port stability while a node is offline.
 *
 * Before: the 60s alias refresh rebuilt everything from live inspection,
 * and an unreachable node contributed nothing. Its aliases vanished from
 * every override written in that window and its ports became claimable by
 * another stack. Now the refresh keeps each stack's last known services for
 * unreachable nodes, and a stopped stack keeps its ports reserved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { parseLastKnownServices } from '../services/MeshService';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let remoteNodeId: number;

type Inspect = (nodeId: number, stack: string, reach?: { reachable: boolean }) => Promise<Array<{ service: string; ports: number[] }>>;
type Alias = { host: string; nodeId: number; nodeName: string; stackName: string; serviceName: string; port: number };
type Internals = {
    inspectStackServices: Inspect;
    reservedPorts: Map<number, Alias>;
    aliasByPort: Map<number, Alias>;
    aliasCache: Map<string, Alias>;
    senchoIp: string | null;
};

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    remoteNodeId = DatabaseService.getInstance().addNode({
        name: 'edge',
        type: 'remote',
        compose_dir: '',
        is_default: false,
        api_url: 'http://edge.invalid:1852',
        api_token: 'tok',
    });
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    vi.restoreAllMocks();
    const svc = MeshService.getInstance() as unknown as Internals;
    // opt-in refuses before the port check unless the data plane is up.
    svc.senchoIp = '172.30.0.2';
    const db = DatabaseService.getInstance();
    for (const row of db.listMeshStacks()) db.deleteMeshStack(row.node_id, row.stack_name);
    svc.reservedPorts = new Map();
    svc.aliasByPort = new Map();
    svc.aliasCache = new Map();
});

function mockInspect(impl: Inspect): void {
    const svc = MeshService.getInstance() as unknown as Internals;
    vi.spyOn(svc, 'inspectStackServices').mockImplementation(impl);
}

/**
 * Dockerode container fixture. `State` is what separates a live service from
 * one that only exists as an exited container; the real inspector reads it,
 * so these tests must supply it rather than mock the inspector itself.
 */
function container(service: string, state: string, ports: number[] = []): {
    State: string;
    Labels: Record<string, string>;
    Ports: Array<{ PrivatePort: number; Type: string }>;
} {
    return {
        State: state,
        Labels: { 'com.docker.compose.service': service },
        Ports: ports.map((port) => ({ PrivatePort: port, Type: 'tcp' })),
    };
}

type ListContainersOpts = { filters?: { label?: string[] } };

function stackFromFilter(opts: ListContainersOpts): string {
    const label = opts.filters?.label?.[0] ?? '';
    return label.replace('com.docker.compose.project=', '');
}

async function withLocalDocker(
    listContainers: (opts: ListContainersOpts) => Promise<unknown[]>,
): Promise<void> {
    const { default: DockerController } = await import('../services/DockerController');
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
        getDocker: () => ({ listContainers }),
    } as unknown as ReturnType<typeof DockerController.getInstance>);
}

describe('mesh alias stability', () => {
    it('persists the services seen while the node is reachable', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        mockInspect(async () => [{ service: 'db', ports: [5432] }]);

        await MeshService.getInstance().refreshAliasCache();

        const row = db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'pg');
        expect(JSON.parse(row?.last_known_services ?? 'null')).toEqual([{ service: 'db', ports: [5432] }]);
    });

    it('keeps aliases and port reservations of an unreachable node', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        db.setMeshStackLastKnownServices(remoteNodeId, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));
        mockInspect(async (_n, _s, reach) => {
            if (reach) reach.reachable = false;
            return [];
        });

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const hosts = (await svc.listAliases()).map((a) => a.host);
        expect(hosts).toContain('db.pg.edge.sencho');
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe('db.pg.edge.sencho');
    });

    it('drops aliases of a reachable but stopped stack while keeping its ports reserved', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        db.setMeshStackLastKnownServices(remoteNodeId, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));
        mockInspect(async () => []);

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect((await svc.listAliases()).map((a) => a.host)).not.toContain('db.pg.edge.sencho');
        expect((svc as unknown as Internals).reservedPorts.has(5432)).toBe(true);
    });

    it('refuses a new opt-in for a port held only by an offline node', async () => {
        // The behaviour the reservation exists for: the offline node's alias
        // is published (so the port is in aliasByPort) AND its port stays
        // claimed, which is the branch reservedPorts adds on top. Reverting
        // the opt-in check to aliasByPort alone would still reject this one,
        // so the stopped-stack case below is the one that distinguishes them.
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        db.setMeshStackLastKnownServices(remoteNodeId, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));
        mockInspect(async (_n, _s, reach) => {
            if (reach) reach.reachable = false;
            return [];
        });
        await MeshService.getInstance().refreshAliasCache();

        const svc = MeshService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        vi.spyOn(
            svc as unknown as { regenerateOverridesAcrossFleet: (n?: number, s?: string) => Promise<void> },
            'regenerateOverridesAcrossFleet',
        ).mockResolvedValue(undefined);
        mockInspect(async (_n, stack) => (stack === 'api' ? [{ service: 'web', ports: [5432] }] : []));

        await expect(svc.optInStack(localNodeId, 'api', 'tester'))
            .rejects.toThrow(/port 5432 is already claimed by db\.pg\.edge\.sencho/);
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(false);
    });

    it('refuses a new opt-in for a port held only by a stopped stack on a reachable node', async () => {
        // The distinguishing case: the stopped stack publishes no alias, so
        // the port is absent from aliasByPort and only reservedPorts holds it.
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        db.setMeshStackLastKnownServices(remoteNodeId, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));
        mockInspect(async () => []);
        await MeshService.getInstance().refreshAliasCache();

        const svc = MeshService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        vi.spyOn(
            svc as unknown as { regenerateOverridesAcrossFleet: (n?: number, s?: string) => Promise<void> },
            'regenerateOverridesAcrossFleet',
        ).mockResolvedValue(undefined);
        mockInspect(async (_n, stack) => (stack === 'api' ? [{ service: 'web', ports: [5432] }] : []));

        expect((svc as unknown as Internals).aliasByPort.has(5432)).toBe(false);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe('db.pg.edge.sencho');

        await expect(svc.optInStack(localNodeId, 'api', 'tester'))
            .rejects.toThrow(/port 5432 is already claimed by db\.pg\.edge\.sencho/);
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(false);
    });

    it('names the live stack as the owner when a stopped stack holds a port a live one serves', async () => {
        // Ownership coherence: the routable alias is the live stack's, so the
        // collision error has to name that one, not the stopped stack whose
        // last-known snapshot also lists the port.
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'stopped', 'tester');
        db.setMeshStackLastKnownServices(remoteNodeId, 'stopped', JSON.stringify([{ service: 'db', ports: [5432] }]));
        db.insertMeshStack(remoteNodeId, 'live', 'tester');
        mockInspect(async (_n, stack) => (stack === 'live' ? [{ service: 'web', ports: [5432] }] : []));

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const internals = svc as unknown as Internals;
        expect(internals.aliasByPort.get(5432)?.host).toBe('web.live.edge.sencho');
        expect(internals.reservedPorts.get(5432)?.host).toBe('web.live.edge.sencho');

        const localNodeId = db.getNodes()[0].id;
        vi.spyOn(
            svc as unknown as { regenerateOverridesAcrossFleet: (n?: number, s?: string) => Promise<void> },
            'regenerateOverridesAcrossFleet',
        ).mockResolvedValue(undefined);
        mockInspect(async (_n, stack) => (stack === 'api' ? [{ service: 'web', ports: [5432] }] : []));

        await expect(svc.optInStack(localNodeId, 'api', 'tester'))
            .rejects.toThrow(/port 5432 is already claimed by web\.live\.edge\.sencho/);
    });

    it('gives a contested port to the earliest opt-in, regardless of inspection order', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'first', 'tester');
        db.insertMeshStack(remoteNodeId, 'second', 'tester');
        mockInspect(async (_n, stack) => {
            // Resolve the older stack last to prove ordering does not depend on timing.
            if (stack === 'first') await new Promise((r) => setTimeout(r, 20));
            return [{ service: 'web', ports: [8080] }];
        });

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect((svc as unknown as Internals).reservedPorts.get(8080)?.host).toBe('web.first.edge.sencho');
    });
});

/**
 * Docker reports no port bindings for a stopped container. The inspector
 * still sees the service name (it lists all containers), so an exited stack
 * used to look like a successful observation with `ports: []`, which replaced
 * the saved snapshot and released every reservation it held. These tests run
 * the real inspector and assert the snapshot, reservations, and collision
 * behaviour after a stop.
 */
describe('stopped services keep their saved ports', () => {
    it('keeps the saved ports and reservation when the stack is only stopped containers', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const host = `db.pg.${localNode.name}.sencho`;
        db.insertMeshStack(localNode.id, 'pg', 'tester');
        db.setMeshStackLastKnownServices(localNode.id, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));

        await withLocalDocker(async () => [container('db', 'exited')]);

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === 'pg');
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([{ service: 'db', ports: [5432] }]);
        // A stopped service publishes no aliases, but its port stays claimed.
        expect((await svc.listAliases()).map((a) => a.host)).not.toContain(host);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);
    });

    it('keeps a stopped service replayable on a later offline refresh', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const host = `db.pg.${localNode.name}.sencho`;
        db.insertMeshStack(localNode.id, 'pg', 'tester');
        db.setMeshStackLastKnownServices(localNode.id, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));

        await withLocalDocker(async () => [container('db', 'exited')]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        await withLocalDocker(() => Promise.reject(new Error('docker socket unavailable')));
        vi.spyOn(console, 'warn').mockImplementation(() => { /* silence the inspection warn */ });
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === 'pg');
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([{ service: 'db', ports: [5432] }]);
        expect((await svc.listAliases()).map((a) => a.host)).toContain(host);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);
    });

    it('keeps the stopped service ports during a partial stop', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        db.insertMeshStack(localNode.id, 'pg', 'tester');
        db.setMeshStackLastKnownServices(localNode.id, 'pg', JSON.stringify([
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]));

        await withLocalDocker(async () => [
            container('db', 'exited'),
            container('web', 'running', [8080]),
        ]);

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === 'pg');
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        const internals = svc as unknown as Internals;
        expect(internals.reservedPorts.get(5432)?.serviceName).toBe('db');
        expect(internals.reservedPorts.get(8080)?.serviceName).toBe('web');
        expect((await svc.listAliases()).map((a) => a.host)).toEqual([`web.pg.${localNode.name}.sencho`]);
    });

    it('rejects a competing opt-in on a port held by a stopped stack', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        db.insertMeshStack(localNode.id, 'pg', 'tester');
        db.setMeshStackLastKnownServices(localNode.id, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));

        await withLocalDocker(async () => [container('db', 'exited')]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        await withLocalDocker(async (opts) => (
            stackFromFilter(opts) === 'api'
                ? [container('web', 'running', [5432])]
                : [container('db', 'exited')]
        ));
        vi.spyOn(
            svc as unknown as { regenerateOverridesAcrossFleet: (n?: number, s?: string) => Promise<void> },
            'regenerateOverridesAcrossFleet',
        ).mockResolvedValue(undefined);

        await expect(svc.optInStack(localNode.id, 'api', 'tester'))
            .rejects.toThrow(`port 5432 is already claimed by db.pg.${localNode.name}.sencho`);
        expect(db.isMeshStackEnabled(localNode.id, 'api')).toBe(false);
    });

    it('releases a saved port when a running service no longer publishes it', async () => {
        // The other side of the distinction: a live container's empty port
        // list is an answer, not missing information, so the reservation goes.
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        db.insertMeshStack(localNode.id, 'pg', 'tester');
        db.setMeshStackLastKnownServices(localNode.id, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));

        await withLocalDocker(async () => [container('db', 'running')]);

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === 'pg');
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([{ service: 'db', ports: [] }]);
        expect((svc as unknown as Internals).reservedPorts.has(5432)).toBe(false);
    });
});

/**
 * A failed opt-out used to delete the record and reinsert it from scratch,
 * losing the saved services, the actor, the creation time, and the row
 * identity that orders contested-port ownership. Removal now happens first,
 * so a failure leaves the record exactly as it was.
 */
describe('mesh opt-out recovery', () => {
    it('preserves the complete record when remote override removal fails', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'original-actor');
        db.setMeshStackLastKnownServices(remoteNodeId, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));
        const before = db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'pg');
        const svc = MeshService.getInstance();
        vi.spyOn(svc, 'removeOverrideFromNode').mockRejectedValue(new Error('HTTP 500: node offline'));

        await expect(svc.optOutStack(remoteNodeId, 'pg', 'other-actor')).rejects.toThrow('node offline');

        expect(db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'pg')).toEqual(before);
        // The record still holds what the refresh needs while the node is away.
        mockInspect(async (_n, _s, reach) => {
            if (reach) reach.reachable = false;
            return [];
        });
        await svc.refreshAliasCache();
        expect((await svc.listAliases()).map((a) => a.host)).toContain('db.pg.edge.sencho');
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.stackName).toBe('pg');
    });

    it('preserves the complete record when the local override unlink fails', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        db.insertMeshStack(localNode.id, 'local-pg', 'original-actor');
        db.setMeshStackLastKnownServices(localNode.id, 'local-pg', JSON.stringify([{ service: 'db', ports: [5432] }]));
        const before = db.listMeshStacks(localNode.id).find((r) => r.stack_name === 'local-pg');
        vi.spyOn(fs, 'unlink').mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

        await expect(MeshService.getInstance().removeLocalOverride('local-pg')).rejects.toThrow('permission denied');

        expect(db.listMeshStacks(localNode.id).find((r) => r.stack_name === 'local-pg')).toEqual(before);
        await withLocalDocker(() => Promise.reject(new Error('docker socket unavailable')));
        vi.spyOn(console, 'warn').mockImplementation(() => { /* silence the inspection warn */ });
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();
        expect((await svc.listAliases()).map((a) => a.host)).toContain(`db.local-pg.${localNode.name}.sencho`);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.stackName).toBe('local-pg');
    });
});

describe('parseLastKnownServices', () => {
    // A corrupt or hand-edited column must not take the refresh down, and
    // must not silently resurrect nonsense ports. Anything it cannot vouch
    // for comes back as no services.
    it('discards malformed and out-of-range values', () => {
        expect(parseLastKnownServices(null)).toEqual([]);
        expect(parseLastKnownServices(undefined)).toEqual([]);
        expect(parseLastKnownServices('')).toEqual([]);
        expect(parseLastKnownServices('{not json')).toEqual([]);
        expect(parseLastKnownServices('{"service":"db"}')).toEqual([]);
        expect(parseLastKnownServices(JSON.stringify({ service: 'db' }))).toEqual([]);
        expect(parseLastKnownServices(JSON.stringify(['db', 7, null]))).toEqual([]);
        expect(parseLastKnownServices(JSON.stringify([
            { service: 42, ports: [1] },
            { service: 'nope' },
            { service: 'db', ports: 'not-an-array' },
        ]))).toEqual([]);
    });

    it('keeps well-formed entries and drops only the bad ports inside them', () => {
        expect(parseLastKnownServices(JSON.stringify([
            { service: 'db', ports: [5432, 'x', -1, 0, 65536, 8080] },
        ]))).toEqual([{ service: 'db', ports: [5432, 8080] }]);
    });
});

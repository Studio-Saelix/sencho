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
import fsSync from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { parseLastKnownServices } from '../services/MeshService';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let remoteNodeId: number;

type Observed = { service: string; ports: number[]; running?: boolean };
type Inspect = (nodeId: number, stack: string, reach?: { reachable: boolean }) => Promise<Observed[]>;
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
 * Seed the saved snapshot for an existing membership. The snapshot is keyed
 * by row id, so the row has to be read back after insert.
 */
function seedLastKnown(
    nodeId: number,
    stackName: string,
    services: Array<{ service: string; ports: number[] }>,
): void {
    const db = DatabaseService.getInstance();
    const row = db.listMeshStacks(nodeId).find((r) => r.stack_name === stackName);
    if (!row) throw new Error(`missing mesh row for ${stackName}`);
    db.setMeshStackLastKnownServices(row.id, JSON.stringify(services));
}

/**
 * Write a stack file so the refresh reads a real declaration. Only the
 * service names matter here; the override generator has its own coverage for
 * network shape.
 */
function writeRawComposeFile(stack: string, contents: string, fileName = 'compose.yaml'): void {
    const composeDir = process.env.COMPOSE_DIR as string;
    const dir = path.join(composeDir, stack);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, fileName), contents, 'utf8');
}

function writeComposeFile(stack: string, services: string[], fileName = 'compose.yaml'): void {
    writeRawComposeFile(
        stack,
        `services:\n${services.map((svc) => `  ${svc}:\n    image: busybox:latest`).join('\n')}\n`,
        fileName,
    );
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
        seedLastKnown(remoteNodeId, 'pg', [{ service: 'db', ports: [5432] }]);
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
        seedLastKnown(remoteNodeId, 'pg', [{ service: 'db', ports: [5432] }]);
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
        seedLastKnown(remoteNodeId, 'pg', [{ service: 'db', ports: [5432] }]);
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
        seedLastKnown(remoteNodeId, 'pg', [{ service: 'db', ports: [5432] }]);
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
        seedLastKnown(remoteNodeId, 'stopped', [{ service: 'db', ports: [5432] }]);
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
        seedLastKnown(localNode.id, 'pg', [{ service: 'db', ports: [5432] }]);

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
        seedLastKnown(localNode.id, 'pg', [{ service: 'db', ports: [5432] }]);

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
        seedLastKnown(localNode.id, 'pg', [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);

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
        seedLastKnown(localNode.id, 'pg', [{ service: 'db', ports: [5432] }]);

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
        seedLastKnown(localNode.id, 'pg', [{ service: 'db', ports: [5432] }]);

        await withLocalDocker(async () => [container('db', 'running')]);

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === 'pg');
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([{ service: 'db', ports: [] }]);
        expect((svc as unknown as Internals).reservedPorts.has(5432)).toBe(false);
    });
});

/**
 * Docker removes a stack's containers one at a time, so a refresh can see a
 * partial inventory while the stack is still fully declared. Absence from
 * that inventory is not evidence of removal: only the compose file is. These
 * tests drive the real local inspector so the boundary under test is the one
 * that runs in production.
 */
describe('partial container removal keeps still-declared claims', () => {
    it('keeps a declared service claim through a teardown and a later offline refresh', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const stack = 'teardown-stack';
        const host = `db.${stack}.${localNode.name}.sencho`;
        db.insertMeshStack(localNode.id, stack, 'tester');
        seedLastKnown(localNode.id, stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        writeComposeFile(stack, ['db', 'web']);

        // Docker removed db before web: web is the only container left.
        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        let row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === stack);
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'db', ports: [5432] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);

        // Teardown finished: an empty inventory must not drop the carried claim.
        await withLocalDocker(async () => []);
        await svc.refreshAliasCache();

        row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === stack);
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'db', ports: [5432] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);

        // A competing opt-in cannot take the port the still-declared service owns.
        await withLocalDocker(async (opts) => (
            stackFromFilter(opts) === 'api' ? [container('db2', 'running', [5432])] : []
        ));
        vi.spyOn(
            svc as unknown as { regenerateOverridesAcrossFleet: (n?: number, s?: string) => Promise<void> },
            'regenerateOverridesAcrossFleet',
        ).mockResolvedValue(undefined);
        await expect(svc.optInStack(localNode.id, 'api', 'tester'))
            .rejects.toThrow(`port 5432 is already claimed by ${host}`);
        expect(db.isMeshStackEnabled(localNode.id, 'api')).toBe(false);

        // And the claim is still replayable once the node goes away.
        await withLocalDocker(() => Promise.reject(new Error('docker socket unavailable')));
        vi.spyOn(console, 'warn').mockImplementation(() => { /* silence the inspection warn */ });
        await svc.refreshAliasCache();
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);
        expect((await svc.listAliases()).map((a) => a.host)).toContain(host);
    });

    it('releases a saved claim when the service leaves the compose file', async () => {
        // The other side of the distinction: an authored removal is release
        // evidence, so the reservation does not leak forever.
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const stack = 'authored-stack';
        db.insertMeshStack(localNode.id, stack, 'tester');
        seedLastKnown(localNode.id, stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        writeComposeFile(stack, ['web']);

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === stack);
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([{ service: 'web', ports: [8080] }]);
        expect((svc as unknown as Internals).reservedPorts.has(5432)).toBe(false);
    });

    it('releases a saved claim for an exited container the compose file no longer declares', async () => {
        // `listContainers({ all: true })` still lists the exited container, so
        // presence in the inventory is not enough to keep a claim alive for a
        // service the stack no longer owns.
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const stack = 'orphan-stack';
        db.insertMeshStack(localNode.id, stack, 'tester');
        seedLastKnown(localNode.id, stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        writeComposeFile(stack, ['web']);

        await withLocalDocker(async () => [
            container('db', 'exited'),
            container('web', 'running', [8080]),
        ]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === stack);
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([
            { service: 'db', ports: [] },
            { service: 'web', ports: [8080] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.has(5432)).toBe(false);
    });

    it('releases a saved claim when a stopped stack no longer declares the service', async () => {
        // Nothing is running, so the live inventory cannot distinguish a
        // stopped stack from an authored removal. The compose file can.
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const stack = 'authored-stopped-stack';
        db.insertMeshStack(localNode.id, stack, 'tester');
        seedLastKnown(localNode.id, stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        writeComposeFile(stack, ['web']);

        await withLocalDocker(async () => []);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === stack);
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([{ service: 'web', ports: [8080] }]);
        expect((svc as unknown as Internals).reservedPorts.has(5432)).toBe(false);
        expect((svc as unknown as Internals).reservedPorts.get(8080)?.serviceName).toBe('web');
    });

    it('keeps a claim for a service declared only in the hand-authored override', async () => {
        // Compose auto-loads compose.override.yml beside the stack file, so a
        // service declared only there is still part of the project.
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const stack = 'override-stack';
        db.insertMeshStack(localNode.id, stack, 'tester');
        seedLastKnown(localNode.id, stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        writeComposeFile(stack, ['web']);
        writeComposeFile(stack, ['db'], 'compose.override.yml');

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === stack);
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'db', ports: [5432] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.serviceName).toBe('db');
    });

    it('keeps claims when the stack pulls services in via include', async () => {
        // Top-level `include` adds services from files this reader does not
        // follow. A partial declaration must not release anything.
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const stack = 'include-stack';
        db.insertMeshStack(localNode.id, stack, 'tester');
        seedLastKnown(localNode.id, stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        writeRawComposeFile(stack, 'include:\n  - shared.yml\nservices:\n  web:\n    image: busybox:latest\n');

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === stack);
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'db', ports: [5432] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.serviceName).toBe('db');
    });

    it('keeps the saved claim when the compose declaration cannot be read', async () => {
        // No compose file on disk. Unknown is not removal, so the claim stays.
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        const stack = 'unknown-declaration-stack';
        const host = `db.${stack}.${localNode.name}.sencho`;
        db.insertMeshStack(localNode.id, stack, 'tester');
        seedLastKnown(localNode.id, stack, [{ service: 'db', ports: [5432] }]);

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const row = db.listMeshStacks(localNode.id).find((r) => r.stack_name === stack);
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'db', ports: [5432] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);
    });
});

/**
 * The declaration read is the only evidence that releases a saved claim, so
 * it has to be trustworthy. A saved compose file can hold anything an editor
 * wrote, and a discovered chain is not the chain Compose loads when
 * COMPOSE_FILE selects its own. None of those states says a service is gone.
 */
describe('declaration reconciliation trusts only readable compose content', () => {
    function seedClaim(
        stack: string,
        services: Array<{ service: string; ports: number[] }>,
    ): { id: number; name: string } {
        const db = DatabaseService.getInstance();
        const localNode = db.getDefaultNode();
        if (!localNode) throw new Error('missing default node');
        db.insertMeshStack(localNode.id, stack, 'tester');
        seedLastKnown(localNode.id, stack, services);
        return localNode;
    }

    function savedServices(nodeId: number, stack: string): Array<{ service: string; ports: number[] }> {
        const row = DatabaseService.getInstance().listMeshStacks(nodeId).find((r) => r.stack_name === stack);
        return parseLastKnownServices(row?.last_known_services);
    }

    /**
     * A declaration saved as an array or a scalar is not Compose content, so
     * it says nothing about which services the stack used to own. The saved
     * claim stays, and a competing opt-in on its port is still refused.
     */
    async function expectInvalidDeclarationKeepsClaim(stack: string, contents: string): Promise<void> {
        const localNode = seedClaim(stack, [{ service: 'db', ports: [5432] }]);
        const host = `db.${stack}.${localNode.name}.sencho`;
        writeRawComposeFile(stack, contents);

        await withLocalDocker(async () => []);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect(savedServices(localNode.id, stack)).toEqual([{ service: 'db', ports: [5432] }]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);

        await withLocalDocker(async (opts) => (
            stackFromFilter(opts) === 'api' ? [container('taker', 'running', [5432])] : []
        ));
        vi.spyOn(
            svc as unknown as { regenerateOverridesAcrossFleet: (n?: number, s?: string) => Promise<void> },
            'regenerateOverridesAcrossFleet',
        ).mockResolvedValue(undefined);
        await expect(svc.optInStack(localNode.id, 'api', 'tester'))
            .rejects.toThrow(`port 5432 is already claimed by ${host}`);
        expect(DatabaseService.getInstance().isMeshStackEnabled(localNode.id, 'api')).toBe(false);
    }

    it('keeps the saved claim when services is a sequence', async () => {
        await expectInvalidDeclarationKeepsClaim('sequence-declaration-stack', 'services:\n  - web\n');
    });

    it('keeps the saved claim when a service definition is not a mapping', async () => {
        await expectInvalidDeclarationKeepsClaim('scalar-service-stack', 'services:\n  web: busybox\n');
    });

    it('keeps the saved claim when the services value is a scalar', async () => {
        await expectInvalidDeclarationKeepsClaim('scalar-services-stack', 'services: web\n');
    });

    it('keeps a saved claim when COMPOSE_FILE selects the file chain', async () => {
        // compose.yaml declares web, db.yaml declares db, and .env points
        // Compose at both. Reading only the discovered main file would think
        // db was removed and free its port.
        const stack = 'compose-file-chain-stack';
        const localNode = seedClaim(stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        const host = `db.${stack}.${localNode.name}.sencho`;
        writeComposeFile(stack, ['web']);
        writeComposeFile(stack, ['db'], 'db.yaml');
        writeRawComposeFile(stack, 'COMPOSE_FILE=compose.yaml:db.yaml\n', '.env');

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect(savedServices(localNode.id, stack)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'db', ports: [5432] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);
    });

    it('keeps a saved claim when the COMPOSE_FILE selection cannot be read', async () => {
        // The selector refuses this .env, which means Compose's own discovery
        // cannot be trusted either. Unknown keeps the claim.
        const stack = 'compose-file-unknown-stack';
        const localNode = seedClaim(stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        const host = `db.${stack}.${localNode.name}.sencho`;
        writeComposeFile(stack, ['web']);
        writeRawComposeFile(stack, 'COMPOSE_DISABLE_ENV_FILE=maybe\n', '.env');

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect(savedServices(localNode.id, stack)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'db', ports: [5432] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);
    });

    it('still reconciles a Git file list when COMPOSE_FILE is set', async () => {
        // An explicit `-f` list is what Compose loads for a multi-file Git
        // stack, so COMPOSE_FILE does not apply. The second file has to stay
        // readable, and a service gone from every file still releases its port.
        const stack = 'git-file-list-stack';
        const db = DatabaseService.getInstance();
        const localNode = seedClaim(stack, [
            { service: 'db', ports: [5432] },
            { service: 'queue', ports: [6379] },
            { service: 'web', ports: [8080] },
        ]);
        writeComposeFile(stack, ['web']);
        writeComposeFile(stack, ['queue'], 'queue.yaml');
        writeRawComposeFile(stack, 'COMPOSE_FILE=compose.yaml:queue.yaml\n', '.env');
        vi.spyOn(db, 'getGitSource').mockReturnValue({
            applied_deploy_spec: { files: ['compose.yaml', 'queue.yaml'], contextDir: null },
        } as unknown as ReturnType<typeof DatabaseService.prototype.getGitSource>);

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect(savedServices(localNode.id, stack)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'queue', ports: [6379] },
        ]);
        const internals = svc as unknown as Internals;
        expect(internals.reservedPorts.has(5432)).toBe(false);
        expect(internals.reservedPorts.get(6379)?.serviceName).toBe('queue');
    });

    it.each([
        ['networks-only', 'networks:\n  front:\n    driver: bridge\n'],
        ['volumes-only', 'volumes:\n  data:\n'],
    ])('releases an authored removal beside a %s auxiliary layer', async (_label, override) => {
        // A valid auxiliary layer that only adjusts networks or volumes omits
        // `services` on purpose. It contributes no names, and it must not turn
        // the rest of the declaration into an unknown that keeps db forever.
        const stack = 'auxiliary-layer-stack';
        const localNode = seedClaim(stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        writeComposeFile(stack, ['web']);
        writeRawComposeFile(stack, override, 'compose.override.yml');

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect(savedServices(localNode.id, stack)).toEqual([{ service: 'web', ports: [8080] }]);
        const internals = svc as unknown as Internals;
        expect(internals.reservedPorts.has(5432)).toBe(false);
        expect(internals.reservedPorts.get(8080)?.serviceName).toBe('web');
    });

    it('keeps all claims when one layer of the chain is malformed', async () => {
        // The base file still declares web, but the override is invalid. A
        // partial read of the chain cannot release the saved db claim.
        const stack = 'malformed-layer-stack';
        const localNode = seedClaim(stack, [
            { service: 'db', ports: [5432] },
            { service: 'web', ports: [8080] },
        ]);
        const host = `db.${stack}.${localNode.name}.sencho`;
        writeComposeFile(stack, ['web']);
        writeRawComposeFile(stack, 'services:\n  - db\n', 'compose.override.yml');

        await withLocalDocker(async () => [container('web', 'running', [8080])]);
        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect(savedServices(localNode.id, stack)).toEqual([
            { service: 'web', ports: [8080] },
            { service: 'db', ports: [5432] },
        ]);
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe(host);
    });
});

/**
 * Refreshes overlap: the 60 s timer, opt-in/opt-out, and the override-apply
 * paths all call `refreshAliasCache`. A run that started earlier can finish
 * later, and its answer must not overwrite newer durable state or publish an
 * older cache.
 */
describe('overlapping refreshes', () => {
    it('keeps the newest observation when an older refresh finishes last', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        seedLastKnown(remoteNodeId, 'pg', [{ service: 'db', ports: [5432] }]);

        let resolveOlder: ((services: Observed[]) => void) | undefined;
        let calls = 0;
        mockInspect(async () => {
            calls += 1;
            if (calls === 1) {
                return new Promise<Observed[]>((resolve) => { resolveOlder = resolve; });
            }
            return [{ service: 'db', ports: [8080], running: true }];
        });

        const svc = MeshService.getInstance();
        const older = svc.refreshAliasCache();
        await svc.refreshAliasCache();

        let row = db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'pg');
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([{ service: 'db', ports: [8080] }]);
        expect((svc as unknown as Internals).reservedPorts.get(8080)?.serviceName).toBe('db');

        if (!resolveOlder) throw new Error('older inspection was never started');
        resolveOlder([{ service: 'db', ports: [6000], running: true }]);
        await older;

        row = db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'pg');
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([{ service: 'db', ports: [8080] }]);
        expect((svc as unknown as Internals).reservedPorts.get(8080)?.serviceName).toBe('db');
        expect((svc as unknown as Internals).reservedPorts.has(6000)).toBe(false);

        // A later offline refresh replays the newer observation, not the older one.
        mockInspect(async (_n, _s, reach) => {
            if (reach) reach.reachable = false;
            return [];
        });
        await svc.refreshAliasCache();
        expect((svc as unknown as Internals).reservedPorts.get(8080)?.serviceName).toBe('db');
        expect((svc as unknown as Internals).reservedPorts.has(6000)).toBe(false);
    });

    it('does not write a stale observation into a replacement membership', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        seedLastKnown(remoteNodeId, 'pg', [{ service: 'db', ports: [5432] }]);

        let resolveOlder: ((services: Observed[]) => void) | undefined;
        let calls = 0;
        mockInspect(async () => {
            calls += 1;
            if (calls === 1) {
                return new Promise<Observed[]>((resolve) => { resolveOlder = resolve; });
            }
            return [];
        });

        const svc = MeshService.getInstance();
        const older = svc.refreshAliasCache();

        // Opt out and back in while the older inspection is still outstanding:
        // the row id changes, so the delayed answer belongs to a row that no
        // longer exists.
        db.deleteMeshStack(remoteNodeId, 'pg');
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        await svc.refreshAliasCache();

        if (!resolveOlder) throw new Error('older inspection was never started');
        resolveOlder([{ service: 'db', ports: [6000], running: true }]);
        await older;

        const row = db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'pg');
        expect(parseLastKnownServices(row?.last_known_services)).toEqual([]);
        expect((svc as unknown as Internals).reservedPorts.has(6000)).toBe(false);
    });

    it('still publishes the stacks that answered when one inspection throws', async () => {
        // Defensive: the production inspectors absorb their own failures, but
        // one unexpected throw must not take the whole tick and every other
        // stack's snapshot down with it.
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'answers', 'tester');
        db.insertMeshStack(remoteNodeId, 'throws', 'tester');
        mockInspect(async (_n, stack) => {
            if (stack === 'throws') throw new Error('docker daemon unreachable');
            return [{ service: 'web', ports: [8080], running: true }];
        });

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const answered = db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'answers');
        expect(parseLastKnownServices(answered?.last_known_services)).toEqual([{ service: 'web', ports: [8080] }]);
        expect((svc as unknown as Internals).reservedPorts.get(8080)?.stackName).toBe('answers');
        const thrown = db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'throws');
        expect(parseLastKnownServices(thrown?.last_known_services)).toEqual([]);
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
        seedLastKnown(remoteNodeId, 'pg', [{ service: 'db', ports: [5432] }]);
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
        seedLastKnown(localNode.id, 'local-pg', [{ service: 'db', ports: [5432] }]);
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

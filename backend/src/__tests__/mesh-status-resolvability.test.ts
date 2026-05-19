/**
 * `MeshService.getStatus().optedInStacks[i].currentlyResolvable` contract.
 *
 * The Routing tab needs to distinguish two states for an opted-in stack:
 *  - resolvable: the alias cache currently carries at least one alias for
 *    `(nodeId, stackName)` (services are running and inspectable).
 *  - suspended: the `mesh_stacks` row still exists, but the alias cache has
 *    nothing for that pair (stack stopped, ports gone).
 *
 * Reading `this.aliasCache` directly keeps the new field aligned with what
 * `/api/mesh/aliases` reports without paying an extra Dockerode / cross-node
 * inspect on every status poll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { MeshService, type MeshGlobalAlias } from '../services/MeshService';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
beforeAll(async () => { tmpDir = await setupTestDb(); });
afterAll(() => cleanupTestDb(tmpDir));

function uniqueSuffix(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function seedProxyNode(meshEnabled: boolean): number {
    const db = DatabaseService.getInstance();
    const id = db.addNode({
        name: `peer-resolv-${uniqueSuffix()}`,
        type: 'remote',
        mode: 'proxy',
        api_url: `https://peer-${uniqueSuffix()}.example.com`,
        api_token: `tok-${uniqueSuffix()}`,
        compose_dir: '/tmp',
        is_default: false,
    });
    if (meshEnabled) db.setNodeMeshEnabled(id, true);
    return id;
}

function setAliasCache(entries: MeshGlobalAlias[]): void {
    const svc = MeshService.getInstance() as unknown as {
        aliasCache: Map<string, MeshGlobalAlias>;
    };
    svc.aliasCache = new Map(entries.map((a) => [a.host, a]));
}

beforeEach(() => {
    DatabaseService.getInstance().getDb().prepare('DELETE FROM nodes WHERE is_default = 0').run();
    DatabaseService.getInstance().getDb().prepare('DELETE FROM mesh_stacks').run();
    setAliasCache([]);
});

describe('MeshService.getStatus optedInStacks.currentlyResolvable', () => {
    it('reports currentlyResolvable=true when the alias cache has an alias for the stack', async () => {
        const id = seedProxyNode(true);
        const db = DatabaseService.getInstance();
        db.insertMeshStack(id, 'whoami', 'admin');
        setAliasCache([
            { host: 'whoami.whoami.peer.sencho', nodeId: id, nodeName: 'peer', stackName: 'whoami', serviceName: 'whoami', port: 80 },
        ]);

        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.optedInStacks).toEqual([{ stackName: 'whoami', currentlyResolvable: true }]);
    });

    it('reports currentlyResolvable=false when the alias cache is empty for the stack', async () => {
        const id = seedProxyNode(true);
        DatabaseService.getInstance().insertMeshStack(id, 'whoami', 'admin');
        setAliasCache([]);

        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.optedInStacks).toEqual([{ stackName: 'whoami', currentlyResolvable: false }]);
    });

    it('handles a mix of resolvable and suspended opt-ins on the same node', async () => {
        const id = seedProxyNode(true);
        const db = DatabaseService.getInstance();
        db.insertMeshStack(id, 'whoami', 'admin');
        db.insertMeshStack(id, 'paperless', 'admin');
        setAliasCache([
            { host: 'whoami.whoami.peer.sencho', nodeId: id, nodeName: 'peer', stackName: 'whoami', serviceName: 'whoami', port: 80 },
        ]);

        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        const byName = new Map(entry?.optedInStacks.map((s) => [s.stackName, s.currentlyResolvable]) ?? []);
        expect(byName.get('whoami')).toBe(true);
        expect(byName.get('paperless')).toBe(false);
        expect(entry?.optedInStacks).toHaveLength(2);
    });

    it('returns an empty optedInStacks array for a node with no opt-ins (shape regression)', async () => {
        const id = seedProxyNode(true);

        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.optedInStacks).toEqual([]);
    });

    it('does not invent a phantom opt-in from a stale alias whose stack is not in mesh_stacks', async () => {
        // Invariant: `optedInStacks` is derived from the persistent
        // `mesh_stacks` table; the alias cache only adjusts the
        // `currentlyResolvable` flag for existing rows. A stale alias entry
        // (e.g. cached for a stack that was just deleted) must NOT surface as
        // a phantom opt-in.
        const id = seedProxyNode(true);
        // No `insertMeshStack` call — node has no opt-ins.
        setAliasCache([
            { host: 'ghost.ghost.peer.sencho', nodeId: id, nodeName: 'peer', stackName: 'ghost', serviceName: 'ghost', port: 80 },
        ]);

        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.optedInStacks).toEqual([]);
    });

    it('scopes resolvability per node: an alias on node A does not make stack X resolvable on node B', async () => {
        const idA = seedProxyNode(true);
        const idB = seedProxyNode(true);
        const db = DatabaseService.getInstance();
        db.insertMeshStack(idA, 'shared', 'admin');
        db.insertMeshStack(idB, 'shared', 'admin');
        // Alias exists only for node A.
        setAliasCache([
            { host: 'shared.shared.peer-a.sencho', nodeId: idA, nodeName: 'peer-a', stackName: 'shared', serviceName: 'shared', port: 80 },
        ]);

        const statuses = await MeshService.getInstance().getStatus();
        const a = statuses.find((s) => s.nodeId === idA);
        const b = statuses.find((s) => s.nodeId === idB);
        expect(a?.optedInStacks).toEqual([{ stackName: 'shared', currentlyResolvable: true }]);
        expect(b?.optedInStacks).toEqual([{ stackName: 'shared', currentlyResolvable: false }]);
    });
});

/**
 * Unit tests for the remote (proxy) branch of BlueprintService deploy/withdraw.
 *
 * The remote path talks to a sibling Sencho's /api/stacks surface over HTTP
 * (create stack, write compose, write marker, deploy). These tests mock that
 * surface via axios so we can assert the call ordering, the 409-on-create
 * "already exists" tolerance, the failure mapping to status='failed', the
 * name-conflict guard, and the withdraw delete path, without a live remote.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let setupTestDb: typeof import('./helpers/setupTestDb').setupTestDb;
let cleanupTestDb: typeof import('./helpers/setupTestDb').cleanupTestDb;
let counter = 0;

function seedRemoteNode(): { id: number; name: string } {
    counter += 1;
    const name = `bp-remote-${counter}`;
    const id = DatabaseService.getInstance().addNode({
        name,
        type: 'remote',
        mode: 'proxy',
        compose_dir: '/tmp/compose',
        is_default: false,
        api_url: 'https://remote.example.com:1852',
        api_token: 'remote-tok',
    });
    return { id, name };
}

function seedBlueprint(nodeIds: number[]) {
    counter += 1;
    return DatabaseService.getInstance().createBlueprint({
        name: `bp-remote-bp-${counter}`,
        description: null,
        compose_content: 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: nodeIds },
        drift_mode: 'suggest',
        classification: 'stateless',
        classification_reasons: [],
        enabled: true,
        created_by: 'admin',
    });
}

beforeAll(async () => {
    ({ setupTestDb, cleanupTestDb } = await import('./helpers/setupTestDb'));
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ BlueprintService } = await import('../services/BlueprintService'));
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
        apiUrl: 'https://remote.example.com:1852',
        apiToken: 'remote-tok',
    });
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

afterEach(() => vi.restoreAllMocks());

describe('BlueprintService remote deploy', () => {
    it('creates the stack, writes compose then marker, then deploys, in order', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] }); // hasNameConflict: no stacks
        const putSpy = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        const postSpy = vi.spyOn(axios, 'post')
            .mockResolvedValueOnce({ status: 201, data: {} }) // create stack
            .mockResolvedValueOnce({ status: 200, data: {} }); // deploy

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('active');
        expect(postSpy.mock.calls[0][0]).toMatch(/\/api\/stacks$/);
        expect(putSpy.mock.calls[0][0]).toContain('docker-compose.yml');
        expect(putSpy.mock.calls[1][0]).toContain('.blueprint.json');
        expect(postSpy.mock.calls[1][0]).toMatch(/\/deploy$/);

        const dep = DatabaseService.getInstance().getDeployment(bp.id, node.id);
        expect(dep?.status).toBe('active');
        expect(dep?.applied_revision).toBe(bpObj.revision);
    });

    it('treats a 409 on stack create as already-exists and proceeds', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        const putSpy = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        const postSpy = vi.spyOn(axios, 'post')
            .mockResolvedValueOnce({ status: 409, data: { error: 'already exists' } })
            .mockResolvedValueOnce({ status: 200, data: {} });

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('active');
        expect(putSpy).toHaveBeenCalledTimes(2);
        expect(postSpy).toHaveBeenCalledTimes(2);
    });

    it('maps a remote deploy failure to status=failed with the HTTP error', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        vi.spyOn(axios, 'post')
            .mockResolvedValueOnce({ status: 201, data: {} })
            .mockResolvedValueOnce({ status: 500, data: { error: 'boom' } });

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('failed');
        expect(result.error).toContain('HTTP 500');
        const dep = DatabaseService.getInstance().getDeployment(bp.id, node.id);
        expect(dep?.status).toBe('failed');
        expect(dep?.last_error).toContain('HTTP 500');
    });

    it('refuses to deploy when an unmanaged stack of the same name exists on the remote', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        // hasNameConflict lists /api/stacks first, then reads the marker. A 404 marker on an
        // existing stack means it is unmanaged, so the deploy must refuse.
        vi.spyOn(axios, 'get')
            .mockResolvedValueOnce({ status: 200, data: [{ name: bpObj.name }] })
            .mockResolvedValueOnce({ status: 404, data: {} });
        const postSpy = vi.spyOn(axios, 'post');

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('name_conflict');
        expect(postSpy).not.toHaveBeenCalled();
        const dep = DatabaseService.getInstance().getDeployment(bp.id, node.id);
        expect(dep).toBeDefined();
        expect(dep?.status).toBe('name_conflict');
    });

    it('withdraws a remote deployment by deleting the stack and removing the row', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'active',
            applied_revision: bpObj.revision,
        });

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} }); // readMarker → null → proceed
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} }); // remote down (best-effort)
        const delSpy = vi.spyOn(axios, 'delete').mockResolvedValue({ status: 200, data: {} });

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, nodeObj);

        expect(result.status).toBe('withdrawn');
        expect(delSpy.mock.calls[0][0]).toMatch(/\/api\/stacks\//);
        expect(DatabaseService.getInstance().getDeployment(bp.id, node.id)).toBeUndefined();
    });
});

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
    it('applies atomically via the remote apply-local endpoint in a single call', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] }); // hasNameConflict: no stacks
        const putSpy = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { deployed: true } });

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('active');
        // One atomic call to the remote (create + write + deploy run under the
        // remote's lock); no separate file PUTs from the hub.
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect(postSpy.mock.calls[0][0]).toMatch(/\/api\/blueprints\/apply-local$/);
        expect(putSpy).not.toHaveBeenCalled();
        const payload = postSpy.mock.calls[0][1] as { stackName: string; composeContent: string; markerContent: string };
        expect(payload.stackName).toBe(bpObj.name);
        expect(typeof payload.composeContent).toBe('string');
        expect(typeof payload.markerContent).toBe('string');

        const dep = DatabaseService.getInstance().getDeployment(bp.id, node.id);
        expect(dep?.status).toBe('active');
        expect(dep?.applied_revision).toBe(bpObj.revision);
    });

    it('fails closed when the remote lacks apply-local (404); no legacy mutations', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        const putSpy = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        const postSpy = vi.spyOn(axios, 'post')
            .mockResolvedValueOnce({ status: 404, data: {} });

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/apply-local|Upgrade/i);
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect(postSpy.mock.calls[0][0]).toMatch(/\/api\/blueprints\/apply-local$/);
        expect(putSpy).not.toHaveBeenCalled();
        const dep = DatabaseService.getInstance().getDeployment(bp.id, node.id);
        expect(dep?.status).toBe('failed');
    });

    it('maps a remote apply lock-conflict (409) to status=failed', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        const putSpy = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        vi.spyOn(axios, 'post').mockResolvedValue({
            status: 409,
            data: { error: 'web is busy: another operation (update) is already in progress' },
        });

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('failed');
        expect(result.error).toContain('already in progress');
        expect(putSpy).not.toHaveBeenCalled(); // no legacy file writes on conflict
    });

    it('maps a remote apply failure to status=failed with the HTTP error', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 500, data: { error: 'boom' } });

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

    it('withdraws a remote deployment via withdraw-local and removes the row', async () => {
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

        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            status: 200,
            data: { status: 'withdrawn' },
        });
        const delSpy = vi.spyOn(axios, 'delete');

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, nodeObj);

        expect(result.status).toBe('withdrawn');
        expect(postSpy.mock.calls[0][0]).toMatch(/\/api\/blueprints\/withdraw-local$/);
        expect(delSpy).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().getDeployment(bp.id, node.id)).toBeUndefined();
    });

    it('maps remote withdraw-local lock conflict to failed without fallback delete', async () => {
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

        vi.spyOn(axios, 'post').mockResolvedValue({
            status: 409,
            data: {
                error: `${bpObj.name} is busy: another operation (update) is already in progress`,
                code: 'stack_op_in_progress',
            },
        });
        const delSpy = vi.spyOn(axios, 'delete');

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, nodeObj);

        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/already in progress/);
        expect(delSpy).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().getDeployment(bp.id, node.id)?.status).toBe('failed');
    });

    it('fails closed when the remote lacks withdraw-local (404); no legacy delete', async () => {
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

        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 404, data: { error: 'Not Found' } });
        const delSpy = vi.spyOn(axios, 'delete');

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, nodeObj);

        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/withdraw-local|Upgrade/i);
        expect(postSpy.mock.calls[0][0]).toMatch(/\/api\/blueprints\/withdraw-local$/);
        expect(delSpy).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().getDeployment(bp.id, node.id)?.status).toBe('failed');
    });

    it('clears hub role assignments for the withdrawn remote stack tuple', async () => {
        const bcrypt = await import('bcrypt');
        const db = DatabaseService.getInstance();
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = db.getNode(node.id)!;
        const bpObj = db.getBlueprint(bp.id)!;
        db.upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'active',
            applied_revision: bpObj.revision,
        });

        const hash = await bcrypt.hash('password123', 1);
        const userId = db.addUser({
            username: `remote-wd-rbac-${counter}`, password_hash: hash, role: 'viewer',
        });
        db.addRoleAssignment({
            user_id: userId, role: 'deployer', resource_type: 'stack', resource_id: bpObj.name, node_id: node.id,
        });

        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'withdrawn' } });
        const delSpy = vi.spyOn(axios, 'delete');
        const rbacSpy = vi.spyOn(db, 'deleteRoleAssignmentsByStack');

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, nodeObj);

        expect(result.status).toBe('withdrawn');
        expect(delSpy).not.toHaveBeenCalled();
        expect(rbacSpy).toHaveBeenCalledWith(node.id, bpObj.name);
        expect(db.getAllRoleAssignments(userId)
            .some((a) => a.resource_type === 'stack' && a.resource_id === bpObj.name && a.node_id === node.id)).toBe(false);

        db.deleteUser(userId);
    });
});

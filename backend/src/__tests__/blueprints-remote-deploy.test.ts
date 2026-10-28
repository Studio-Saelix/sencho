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
import type { RemoteMetaProbe } from '../services/CapabilityRegistry';

vi.mock('../helpers/registryDeliveryOutbound', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../helpers/registryDeliveryOutbound')>();
    return {
        ...actual,
        prepareOutboundRegistryDeliveryBody: vi.fn(
            (...args: Parameters<typeof actual.prepareOutboundRegistryDeliveryBody>) =>
                actual.prepareOutboundRegistryDeliveryBody(...args),
        ),
    };
});

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let BlueprintOwnershipProbeError: typeof import('../services/BlueprintService').BlueprintOwnershipProbeError;
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
    ({ BlueprintService, BlueprintOwnershipProbeError } = await import('../services/BlueprintService'));
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
        apiUrl: 'https://remote.example.com:1852',
        apiToken: 'remote-tok',
        trustedLoopback: false,
    });
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

afterEach(() => vi.restoreAllMocks());

describe('BlueprintService remote deploy', () => {
    it.each(['verified', 'failed', 'mixed'] as const)('preserves apply success after %s verification without retrying', async mode => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        let release!: () => void;
        const recheck = vi.fn(() => new Promise<{ warning: null }>((resolve, reject) => {
            release = () => mode === 'failed' ? reject(new Error('verification offline')) : resolve({ warning: null });
        }));
        vi.doMock('../services/RemoteImageUpdateService', () => ({
            RemoteImageUpdateService: { getInstance: () => ({ recheckRemoteStack: recheck }) },
        }));
        const { OFFLINE_META } = await import('../services/CapabilityRegistry');
        vi.spyOn(NodeRegistry.getInstance(), 'getNode').mockReturnValue(nodeObj);
        vi.spyOn(NodeRegistry.getInstance(), 'probeRemoteMeta').mockResolvedValue({
            kind: 'ok', meta: { ...OFFLINE_META, online: true, capabilities: mode === 'mixed' ? [] : ['remote-image-inspect-v1'] },
        });

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { deployed: true } });

        let settled = false;
        const outcome = BlueprintService.getInstance().deployToNode(bpObj, nodeObj)
            .then(result => { settled = true; return result; });
        if (mode !== 'mixed') {
            await vi.waitFor(() => expect(recheck).toHaveBeenCalledWith(node.id, bpObj.name, expect.any(AbortSignal)));
            expect(settled).toBe(false);
            release();
        }
        const result = await outcome;
        expect(recheck).toHaveBeenCalledTimes(mode === 'mixed' ? 0 : 1);
        vi.doUnmock('../services/RemoteImageUpdateService');

        expect(result.status).toBe('active');
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect(postSpy.mock.calls[0][0]).toMatch(/\/api\/blueprints\/apply-local$/);
        const dep = DatabaseService.getInstance().getDeployment(bp.id, node.id);
        expect(dep?.status).toBe('active');
    });

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

    it('asks the remote to capture a recovery point when the rollout requests one', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { deployed: true } });

        const result = await BlueprintService.getInstance().deployAuthorizedMaterialization({
            blueprint: bpObj,
            node: nodeObj,
            composeContent: bpObj.compose_content,
            marker: {
                blueprintId: bpObj.id,
                revision: bpObj.revision,
                lastApplied: Date.now(),
                applicationId: 'app-1',
                bindingRevision: 'intent-1',
            },
            auditPath: `/api/blueprints/${bpObj.id}/rollout/app-1`,
            captureRecovery: true,
            recoveryBinding: {
                gitops_generation_id: 'gen-prior',
                gitops_artifact_set_id: 'art-prior',
                gitops_source_acceptance_ref: 'acc-prior',
            },
        });

        expect(result.status).toBe('active');
        const payload = postSpy.mock.calls[0][1] as {
            captureRecovery?: boolean;
            recoveryBinding?: Record<string, unknown>;
        };
        expect(payload.captureRecovery).toBe(true);
        expect(payload.recoveryBinding).toEqual({
            generationId: 'gen-prior',
            artifactSetId: 'art-prior',
            sourceAcceptanceRef: 'acc-prior',
        });

        // A rollout that did not ask for a capture sends neither field.
        postSpy.mockClear();
        await BlueprintService.getInstance().deployAuthorizedMaterialization({
            blueprint: bpObj,
            node: nodeObj,
            composeContent: bpObj.compose_content,
            marker: {
                blueprintId: bpObj.id,
                revision: bpObj.revision,
                lastApplied: Date.now(),
                applicationId: 'app-1',
                bindingRevision: 'intent-1',
            },
            auditPath: `/api/blueprints/${bpObj.id}/rollout/app-1`,
        });
        const plainPayload = postSpy.mock.calls[0][1] as Record<string, unknown>;
        expect(plainPayload.captureRecovery).toBeUndefined();
        expect(plainPayload.recoveryBinding).toBeUndefined();
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

        // hasNameConflict lists /api/stacks first, then reads the marker. The leaf reporting the
        // marker absent on an existing stack means it is unmanaged, so the deploy must refuse.
        // The listing body is the leaf's own shape: the stack names themselves, not objects
        // carrying a name. The marker body carries the leaf's not-found code because that is what
        // the leaf sends for an absent file, and a bare 404 is a node that could not be read
        // rather than an empty one.
        vi.spyOn(axios, 'get')
            .mockResolvedValueOnce({ status: 200, data: [bpObj.name] })
            .mockResolvedValueOnce({ status: 404, data: { error: 'File not found', code: 'NOT_FOUND' } });
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

    it('removes the hub mute rule for the withdrawn stack on that node only', async () => {
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
        const now = Date.now();
        const seed = (name: string, nodeId: number | null) => db.createNotificationSuppressionRule({
            name,
            node_id: nodeId,
            stack_patterns: [bp.name],
            label_ids: null,
            categories: null,
            levels: null,
            applies_to: 'both',
            enabled: true,
            expires_at: null,
            schedule: null,
            created_at: now,
            updated_at: now,
        });
        const onNode = seed(`Mute ${bp.name} on node`, node.id);
        const allNodes = seed(`Mute ${bp.name} everywhere`, null);
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'withdrawn' } });

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, nodeObj);

        expect(result.status).toBe('withdrawn');
        expect(db.getNotificationSuppressionRule(onNode.id)).toBeUndefined();
        expect(db.getNotificationSuppressionRule(allNodes.id)).toBeDefined();
        db.deleteNotificationSuppressionRule(allNodes.id);
    });

    it('keeps the hub mute rule when the remote refuses the withdraw', async () => {
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
        const now = Date.now();
        const rule = db.createNotificationSuppressionRule({
            name: `Mute ${bp.name}`,
            node_id: node.id,
            stack_patterns: [bp.name],
            label_ids: null,
            categories: null,
            levels: null,
            applies_to: 'both',
            enabled: true,
            expires_at: null,
            schedule: null,
            created_at: now,
            updated_at: now,
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { code: 'stack_op_in_progress', error: 'busy' } });

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, nodeObj);

        expect(result.status).toBe('failed');
        expect(db.getNotificationSuppressionRule(rule.id)).toBeDefined();
        db.deleteNotificationSuppressionRule(rule.id);
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

    it('keeps the registry delivery refusal code when the gate refuses the apply', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const db = DatabaseService.getInstance();
        const nodeObj = db.getNode(node.id)!;
        const bpObj = db.getBlueprint(bp.id)!;

        // hasNameConflict probes the remote stack list before the apply;
        // satisfy it so the failure under test is the registry gate refusal.
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} });

        const outbound = await import('../helpers/registryDeliveryOutbound');
        vi.mocked(outbound.prepareOutboundRegistryDeliveryBody).mockResolvedValueOnce({
            ok: false as const,
            status: 409,
            code: 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE',
            error: 'Registry credentials unavailable for challenged image hosts',
        });

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('failed');
        expect(result.code).toBe('REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE');
        expect(result.error).toContain('[REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE]');
        expect(postSpy).not.toHaveBeenCalled();

        const dep = db.getDeployment(bp.id, node.id);
        expect(dep?.last_error).toContain('[REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE]');
    });
});

/**
 * A digest-pinned apply is only honored by a leaf that advertises
 * blueprint-digest-pins-v1. A leaf that predates the field drops it and
 * redeploys by tag, so the hub has to refuse rather than send the request and
 * assume the pin landed.
 */
describe('BlueprintService remote digest-pinned apply capability gate', () => {
    const pins = { app: 'nginx@sha256:' + 'a'.repeat(64) };

    /** Null capabilities means the /api/meta probe itself failed. */
    async function setup(capabilities: string[] | null) {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const db = DatabaseService.getInstance();
        const nodeObj = db.getNode(node.id)!;
        const bpObj = db.getBlueprint(bp.id)!;
        const { OFFLINE_META } = await import('../services/CapabilityRegistry');
        const probe: RemoteMetaProbe = capabilities === null
            ? { kind: 'transport_failure', detail: 'timeout' }
            : { kind: 'ok', meta: { ...OFFLINE_META, online: true, capabilities } };
        vi.spyOn(NodeRegistry.getInstance(), 'probeRemoteMeta').mockResolvedValue(probe);
        // hasNameConflict lists the remote stacks before the apply.
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: [] });
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { deployed: true } });
        const deploy = (digestPins?: Record<string, string>) =>
            BlueprintService.getInstance().deployAuthorizedMaterialization({
                blueprint: bpObj,
                node: nodeObj,
                composeContent: 'services: {}\n',
                marker: { blueprintId: bp.id, revision: bpObj.revision, lastApplied: Date.now() },
                auditPath: `/api/blueprints/${bp.id}/enforce-reapply`,
                digestPins,
            });
        return { db, bp, node, postSpy, deploy };
    }

    it('sends digestPins when the leaf advertises blueprint-digest-pins-v1', async () => {
        const { db, bp, node, postSpy, deploy } = await setup(['blueprint-digest-pins-v1']);
        const result = await deploy(pins);
        expect(result.status).toBe('active');
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect((postSpy.mock.calls[0][1] as { digestPins?: unknown }).digestPins).toEqual(pins);
        expect(db.getDeployment(bp.id, node.id)?.status).toBe('active');
    });

    it('fails with an upgrade-required error and never posts when the leaf lacks the capability', async () => {
        const { db, bp, node, postSpy, deploy } = await setup([]);
        const outbound = await import('../helpers/registryDeliveryOutbound');
        const result = await deploy(pins);
        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/does not support digest-pinned blueprint apply/);
        // The refusal happens before the delivery contract is even negotiated, so
        // nothing about this apply reaches the node.
        expect(vi.mocked(outbound.prepareOutboundRegistryDeliveryBody)).not.toHaveBeenCalled();
        expect(postSpy).not.toHaveBeenCalled();
        const dep = db.getDeployment(bp.id, node.id);
        expect(dep?.status).toBe('failed');
        expect(dep?.last_error).toMatch(/Upgrade that Sencho instance/);
    });

    it('fails closed and never posts when the leaf capability probe is unreachable', async () => {
        const { db, bp, node, postSpy, deploy } = await setup(null);
        const result = await deploy(pins);
        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/Could not confirm that remote node/);
        expect(postSpy).not.toHaveBeenCalled();
        expect(db.getDeployment(bp.id, node.id)?.status).toBe('failed');
    });

    it('does not gate plain (non-digest) applies on the capability', async () => {
        const { postSpy, deploy } = await setup([]);
        const result = await deploy(undefined);
        expect(result.status).toBe('active');
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect((postSpy.mock.calls[0][1] as { digestPins?: unknown }).digestPins).toBeUndefined();
    });
});

/**
 * The ownership probe's remote arm reads the leaf's stack list to learn whether
 * a directory by this name exists at all. The leaf answers with the stack names
 * themselves, so the entries are the names. Reading them as objects carrying a
 * name made the match silently match nothing, which reported every remote name
 * as clear from the day this arm was written: Check again released the row while
 * the conflicting stack was still there, the preview never flagged the
 * collision, and only the leaf's own apply-local check held.
 */
describe('BlueprintService hasNameConflict remote arm', () => {
    const LIST_URL = 'https://remote.example.com:1852/api/stacks';
    const LEAF_NOT_FOUND = { status: 404, data: { error: 'File not found', code: 'NOT_FOUND' } };

    /**
     * Answer the list URL with `listBody` and every other URL (the marker read)
     * with `markerBody`. Without this split, a test mocking both calls the same
     * way proves nothing about which one the probe actually made.
     */
    function stubLeaf(listBody: unknown, markerBody?: unknown) {
        return vi.spyOn(axios, 'get').mockImplementation((url: string) => {
            if (String(url) === LIST_URL) {
                return Promise.resolve({ status: 200, data: listBody });
            }
            return Promise.resolve(markerBody);
        });
    }

    it('sees a remote collision in the leaf stack list, which answers with the names', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        // The listing is the leaf's own shape, a string array of stack names. The
        // marker read reports the file absent, which means an unmanaged stack.
        stubLeaf([bpObj.name], LEAF_NOT_FOUND);

        expect(await BlueprintService.getInstance().hasNameConflict(bpObj.name, nodeObj, bpObj.id)).toBe(true);
    });

    it('reports no collision when the leaf list has no such stack, and does not read the marker', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        const getSpy = stubLeaf(['someone-elses-stack']);

        expect(await BlueprintService.getInstance().hasNameConflict(bpObj.name, nodeObj, bpObj.id)).toBe(false);
        // Only the list was asked. A leaf that lists no such stack has nothing
        // more to say about it, and a marker read would be a request made for a
        // fact the answer already settled.
        expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('reports no collision on a leaf with no stacks at all', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        stubLeaf([]);

        expect(await BlueprintService.getInstance().hasNameConflict(bpObj.name, nodeObj, bpObj.id)).toBe(false);
    });

    it('refuses rather than reporting a clear name when the stack list is not readable', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        for (const listBody of [
            { stacks: [bpObj.name] },
            [{ name: bpObj.name }],
            [7],
            // The name is not among the readable entries, and something else in
            // the list could have been it. "Not in what I could read" is not
            // "not there".
            ['some-other-stack', { name: bpObj.name }],
        ]) {
            stubLeaf(listBody);

            // Both the listing refusal and the marker-failure refusal throw this
            // one type, so the message is what tells them apart: the unreadable
            // list names the node, a failed marker read names the stack.
            const error = await BlueprintService.getInstance()
                .hasNameConflict(bpObj.name, nodeObj, bpObj.id)
                .then(() => null, (err: unknown) => err);

            expect(error, `the list ${JSON.stringify(listBody)} must not read as a clear name`)
                .toBeInstanceOf(BlueprintOwnershipProbeError);
            expect(error instanceof Error ? error.message : String(error)).toContain('stack list');
        }
    });

    it('still answers from the marker when an unreadable entry sits beside the readable name', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        // The name is present in the part of the list this version can read, so
        // the presence question is settled whatever the other entry was. A guard
        // that refused here would brick every remote deploy on a leaf that
        // appended one metadata entry, over a question that was already answered.
        stubLeaf(['some-other-stack', { serviceCount: 3 }, bpObj.name], LEAF_NOT_FOUND);

        expect(await BlueprintService.getInstance().hasNameConflict(bpObj.name, nodeObj, bpObj.id)).toBe(true);
    });

    it('keeps a rechecked remote row in conflict while the conflicting stack is still there', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'name_conflict',
            last_error: 'a stack named this already exists',
        });

        stubLeaf([bpObj.name], LEAF_NOT_FOUND);

        const result = await BlueprintService.getInstance().recheckNameConflict(bpObj, nodeObj);

        expect(result.cleared).toBe(false);
        const row = DatabaseService.getInstance().getDeployment(bp.id, node.id);
        expect(row?.status).toBe('name_conflict');
        // The original reason survives, so the row still tells the operator why
        // it is parked rather than looking like a conflict nothing explained.
        expect(row?.last_error).toContain('already exists');
    });

    it('releases a rechecked remote row once the name is free on the leaf', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'name_conflict',
            last_error: 'a stack named this already exists',
        });

        stubLeaf([]);

        const result = await BlueprintService.getInstance().recheckNameConflict(bpObj, nodeObj);

        expect(result.cleared).toBe(true);
        expect(result.deployment.status).toBe('pending');
        expect(DatabaseService.getInstance().getDeployment(bp.id, node.id)?.status).toBe('pending');
    });

    it('records a deploy as failed, not as a conflict, when ownership cannot be verified', async () => {
        const node = seedRemoteNode();
        const bp = seedBlueprint([node.id]);
        const nodeObj = DatabaseService.getInstance().getNode(node.id)!;
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        // The deploy's own gate is "may I write here", and a probe that could not
        // find out does not answer it. It is recorded as `failed` rather than
        // `name_conflict` because a conflict is a claim about what is on the
        // node, and telling the operator an unowned stack is sitting there on
        // the strength of a transport failure is the error the probe's whole
        // discrimination exists to avoid. Pinned here so a future change to the
        // unreadable-list guard does not quietly move this row's meaning.
        stubLeaf({ stacks: [bpObj.name] });
        // A rejected mock rather than a bare spy: if the guard ever regresses to
        // reporting the name free, the deploy would otherwise reach for the real
        // network and turn a fast failure into a slow, unreachable one.
        const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(new Error('must not deploy with ownership unverified'));

        const result = await BlueprintService.getInstance().deployToNode(bpObj, nodeObj);

        expect(result.status).toBe('failed');
        expect(result.error).toContain('stack list');
        expect(postSpy).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().getDeployment(bp.id, node.id)?.status).toBe('failed');
    });
});

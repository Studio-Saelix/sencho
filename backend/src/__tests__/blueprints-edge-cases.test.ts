/**
 * Edge-case coverage for the Blueprints feature that the existing suites leave open:
 *   - PUT /:id refusing to disable a blueprint that still has active deployments (409).
 *   - POST / rejecting a selector that exceeds the 200-entry cap (400).
 *   - DELETE /:id blocking only on live stateful deployments, not never-deployed reviews.
 *   - checkForDrift flagging revision drift when the on-node marker is stale.
 *   - withdrawFromNode refusing to act when the marker belongs to a different blueprint.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import axios from 'axios';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { newGitOpsId } from '../services/gitops/directApplication';
import type { Node } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let adminCookie: string;
let counter = 0;

function seedNode(): { id: number; name: string } {
    counter += 1;
    const name = `bp-edge-node-${counter}`;
    const db = DatabaseService.getInstance().getDb();
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(name, Date.now());
    return { id: result.lastInsertRowid as number, name };
}

/**
 * A real remote node row, so a test that exercises the remote marker read goes
 * through the same lookup the drift check does. A node that only exists on the
 * object literal the test passes in is not the same thing, and a marker
 * classification that returns early for a missing node would pass against it.
 */
function seedRemoteNode(): Node {
    counter += 1;
    const db = DatabaseService.getInstance().getDb();
    const id = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'remote', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(`bp-edge-remote-${counter}`, Date.now()).lastInsertRowid as number;
    return DatabaseService.getInstance().getNode(id)!;
}

/**
 * The proxy target a remote node needs before the remote read is reachable.
 *
 * Must be awaited. NodeRegistry is imported dynamically because it pulls
 * DatabaseService in at module scope, and this file loads DatabaseService only
 * after the test database exists.
 */
async function stubProxyTarget(node: Node): Promise<void> {
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const registry = NodeRegistry.getInstance();
    vi.spyOn(registry, 'getProxyTarget').mockReturnValue({
        nodeId: node.id,
        apiUrl: 'https://leaf.example.test:1852',
        apiToken: 'test-token',
        trustedLoopback: false,
    } as unknown as ReturnType<typeof registry.getProxyTarget>);
}

function seedBlueprint(nodeIds: number[], classification: 'stateless' | 'stateful' = 'stateless') {
    counter += 1;
    return DatabaseService.getInstance().createBlueprint({
        name: `bp-edge-${counter}`,
        description: null,
        compose_content: 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: nodeIds },
        drift_mode: 'suggest',
        classification,
        classification_reasons: [],
        enabled: true,
        created_by: 'admin',
    });
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ BlueprintService } = await import('../services/BlueprintService'));

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    // Reset developer mode so the diagnostics matrix below is order-independent.
    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

/**
 * Acknowledge a generation and its artifact set for one target.
 *
 * A drift check can only classify a target it can name an expected identity
 * for, so a test that exercises marker or digest semantics needs a target that
 * has actually been deployed. Without this the check has nothing to compare and
 * reports missing evidence, which is a different test.
 */
async function acknowledgeInlineTarget(
    appId: string,
    nodeId: number,
    generationId: string,
    artifactSetId: string,
): Promise<void> {
    const { GitOpsStore, emptyTargetRow } = await import('../services/gitops/store');
    GitOpsStore.getInstance().upsertTarget({
        ...emptyTargetRow(appId, nodeId, Date.now()),
        desired_generation_id: generationId,
        applied_generation_id: generationId,
        deployed_generation_id: generationId,
        expected_artifact_set_id: artifactSetId,
        latest_artifact_set_id: artifactSetId,
    });
}

/**
 * An application with one accepted generation, one exact artifact set, and an
 * acknowledged target: the minimum a drift check needs before it can say
 * anything about marker or digest state.
 */
async function seedAcknowledgedInlineApp(
    appId: string,
    blueprintId: number,
    nodeId: number,
): Promise<void> {
    const { GitOpsStore } = await import('../services/gitops/store');
    const store = GitOpsStore.getInstance();
    const genId = newGitOpsId();
    const artId = newGitOpsId();
    store.insertGeneration({
        id: genId,
        application_id: appId,
        commit_sha: 'a'.repeat(40),
        repo_url: `inline://blueprint/${blueprintId}`,
        configured_ref: 'inline',
        resolved_ref_kind: null,
        repo_identity_json: JSON.stringify({ host: 'inline', pathname: `/blueprint/${blueprintId}` }),
        manifest_version: 1,
        candidate_dir: `generations/inline-${genId}`,
        applied_dir: `generations/inline-${genId}-applied`,
        expected_invocation_json: '{}',
        materialization_fingerprint: 'a'.repeat(64),
        validation_ok: 1,
        plan_blocked: 0,
        change_plan_fingerprint: null,
        operation_id: 'op-acknowledged',
        trigger: 'test',
        actor: null,
        previous_generation_id: null,
        redacted_limitations_json: '[]',
        portable_manifest_json: null,
        compose_inputs_json: null,
        source_policy_evidence_json: null,
        security_policy_evidence_json: null,
        support_requirements_json: null,
        compatibility_requirements_json: null,
        secret_capability_json: null,
        created_at: Date.now(),
    });
    store.insertArtifactSet({
        id: artId,
        generation_id: genId,
        evidence_version: 1,
        authoritative: 0,
        qualification: 'exact',
        evidence_json: JSON.stringify({ kind: 'exact', identity: `exact:${'a'.repeat(64)}` }),
        created_at: Date.now(),
    });
    const app = store.getApplication(appId)!;
    app.accepted_generation_id = genId;
    app.artifact_set_id = artId;
    app.latest_artifact_set_id = artId;
    store.writeApplicationPointers(app);
    await acknowledgeInlineTarget(appId, nodeId, genId, artId);
}

describe('Blueprint route edge cases', () => {
    it('refuses to disable a blueprint whose repair is held, because its workload still runs', async () => {
        // A hold is a decision not to overwrite the workload, not a statement that
        // the workload is gone. Leaving this status out of the disable guard let a
        // Blueprint be disabled while its containers kept running unattended.
        const node = seedNode();
        const bp = seedBlueprint([node.id]);
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'repair_held',
            applied_revision: bp.revision,
            drift_summary: 'the rollout for this target was superseded',
        });

        const res = await request(app)
            .put(`/api/blueprints/${bp.id}`)
            .set('Cookie', adminCookie)
            .send({ enabled: false });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('has_active_deployments');
        expect(DatabaseService.getInstance().getBlueprint(bp.id)?.enabled).toBe(true);
    });

    it('refuses to disable a blueprint that still has an active deployment', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id]);
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'active',
            applied_revision: bp.revision,
        });

        const res = await request(app)
            .put(`/api/blueprints/${bp.id}`)
            .set('Cookie', adminCookie)
            .send({ enabled: false });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('has_active_deployments');
        // The blueprint must remain enabled.
        expect(DatabaseService.getInstance().getBlueprint(bp.id)?.enabled).toBe(true);
    });

    it('rejects a node selector that exceeds the 200-entry cap', async () => {
        const ids = Array.from({ length: 201 }, (_, i) => i + 1);
        const res = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send({
                name: 'bp-edge-oversized',
                compose_content: 'services:\n  app:\n    image: nginx\n',
                selector: { type: 'nodes', ids },
                drift_mode: 'suggest',
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('200');
        expect(DatabaseService.getInstance().listBlueprints()).toHaveLength(0);
    });
});

describe('Blueprint delete guard', () => {
    // Rows with no stack of ours on the node must not block delete, AND the route must not run the
    // withdraw primitive for them: there is nothing Sencho owns to remove. A name_conflict is an
    // unmanaged same-name stack, so it is excluded even though it may carry a last_deployed_at
    // timestamp. When withdraw does run, ownership is enforced under the delete lock.
    it.each([
        { label: 'never-deployed pending review', status: 'pending_state_review' as const, last_deployed_at: null },
        { label: 'first-deploy failure', status: 'failed' as const, last_deployed_at: null },
        { label: 'unmanaged same-name stack', status: 'name_conflict' as const, last_deployed_at: Date.now() },
    ])('deletes a stateful blueprint with a $label without touching the node', async ({ status, last_deployed_at }) => {
        const node = seedNode();
        const bp = seedBlueprint([node.id], 'stateful');
        DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: node.id, status, last_deployed_at });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });

        const res = await request(app)
            .delete(`/api/blueprints/${bp.id}`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(204);
        // Critical: never withdraw a row we did not deploy; it could destroy an unmanaged stack.
        expect(withdrawSpy).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().getBlueprint(bp.id)).toBeUndefined();
        // The blueprint-delete cascade removes the leftover row.
        expect(DatabaseService.getInstance().listDeployments(bp.id)).toHaveLength(0);
    });

    // A stack Sencho deployed and still owns (last_deployed_at set) blocks delete regardless of its
    // current status, so the operator makes the snapshot-vs-destroy choice. failed and deploying
    // carry over last_deployed_at from the prior deploy, so they block too.
    it.each(['active', 'drifted', 'correcting', 'evict_blocked', 'failed', 'deploying'] as const)(
        'refuses to delete a stateful blueprint with a deployed %s deployment',
        async (status) => {
            const node = seedNode();
            const bp = seedBlueprint([node.id], 'stateful');
            DatabaseService.getInstance().upsertDeployment({
                blueprint_id: bp.id,
                node_id: node.id,
                status,
                applied_revision: bp.revision,
                last_deployed_at: Date.now(),
            });

            const res = await request(app)
                .delete(`/api/blueprints/${bp.id}`)
                .set('Cookie', adminCookie);

            expect(res.status).toBe(409);
            expect(res.body.code).toBe('stateful_deployments_blocking');
            expect(DatabaseService.getInstance().getBlueprint(bp.id)).toBeDefined();
        },
    );

    it('withdraws an owned deployment before deleting a stateless blueprint', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id]); // stateless: the guard is skipped, so the loop runs
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'active',
            applied_revision: bp.revision,
            last_deployed_at: Date.now(),
        });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });

        const res = await request(app)
            .delete(`/api/blueprints/${bp.id}`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(204);
        // A deployed, owned stack must still be withdrawn from the node before the blueprint goes.
        expect(withdrawSpy).toHaveBeenCalledTimes(1);
        expect(DatabaseService.getInstance().getBlueprint(bp.id)).toBeUndefined();
    });

    it('refuses to delete a stateless blueprint when pre-delete withdraw fails', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id]);
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'failed',
            applied_revision: bp.revision,
            last_deployed_at: Date.now(),
            last_error: 'Remote node lacks withdraw-local',
        });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({
            status: 'failed',
            error: 'Remote node does not support atomic blueprint withdraw',
        });

        const res = await request(app)
            .delete(`/api/blueprints/${bp.id}`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('withdraw_failed_blocking_delete');
        expect(res.body.nodeId).toBe(node.id);
        expect(withdrawSpy).toHaveBeenCalledTimes(1);
        expect(DatabaseService.getInstance().getBlueprint(bp.id)).toBeDefined();
        expect(DatabaseService.getInstance().listDeployments(bp.id)).toHaveLength(1);
    });

    it('refuses to delete when a pending review still has a deployed stack (revision drift)', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id], 'stateful');
        // pending_state_review carried over from a prior deploy keeps last_deployed_at set,
        // so the old stack is still on the node and delete must refuse.
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'pending_state_review',
            applied_revision: bp.revision,
            last_deployed_at: Date.now(),
        });

        const res = await request(app)
            .delete(`/api/blueprints/${bp.id}`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('stateful_deployments_blocking');
        expect(DatabaseService.getInstance().getBlueprint(bp.id)).toBeDefined();
    });

    it('counts only the live deployment, not the never-deployed review, in a mixed set', async () => {
        const liveNode = seedNode();
        const reviewNode = seedNode();
        const bp = seedBlueprint([liveNode.id, reviewNode.id], 'stateful');
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: liveNode.id,
            status: 'active',
            applied_revision: bp.revision,
            last_deployed_at: Date.now(),
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: reviewNode.id,
            status: 'pending_state_review',
        });

        const res = await request(app)
            .delete(`/api/blueprints/${bp.id}`)
            .set('Cookie', adminCookie);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('stateful_deployments_blocking');
        // Only the live deployment blocks; the never-deployed review is excluded from the count.
        expect(res.body.error).toContain('1 live deployment');
    });
});

describe('BlueprintService marker edge cases', () => {
    it('flags revision drift when the on-node marker is stale', async () => {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        // A live application is required before marker/digest comparison runs.
        const { GitOpsStore } = await import('../services/gitops/store');
        const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const appId = newGitOpsId();
        GitOpsStore.getInstance().insertApplication(blankInlineApplication(appId, bp.id, Date.now()));
        await seedAcknowledgedInlineApp(appId, bp.id, localNode.id);

        vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({ kind: 'present', marker: {
            blueprintId: bp.id,
            revision: bpObj.revision + 5,
            lastApplied: 0,
        } });

        const result = await BlueprintService.getInstance().checkForDrift(bpObj, localNode);

        expect(result.kind).toBe('drifted');
        if (result.kind === 'drifted') {
            expect(result.reason).toContain('revision drift');
        }
    });

    it('returns unverified when no recordable GitOps application exists', async () => {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        const result = await BlueprintService.getInstance().checkForDrift(bpObj, localNode);

        expect(result.kind).toBe('unverified');
        if (result.kind === 'unverified') {
            expect(result.reason).toMatch(/no recordable/i);
        }
    });

    it('returns unverified when a remote node has no proxy target', async () => {
        // Exercises the real read: the marker is not mocked, because the whole
        // point is what readMarker does when it cannot reach the node at all. A
        // mocked marker here made this pass through the earlier
        // "no GitOps target for this node" return instead, so it asserted
        // nothing about the path it is named for.
        const remoteNode = seedRemoteNode();
        const bp = seedBlueprint([remoteNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const { GitOpsStore } = await import('../services/gitops/store');
        const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const appId = newGitOpsId();
        GitOpsStore.getInstance().insertApplication(blankInlineApplication(appId, bp.id, Date.now()));
        await seedAcknowledgedInlineApp(appId, bp.id, remoteNode.id);
        const { NodeRegistry } = await import('../services/NodeRegistry');
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);

        const result = await BlueprintService.getInstance().checkForDrift(bpObj, remoteNode);

        expect(result.kind).toBe('unverified');
        if (result.kind === 'unverified') {
            expect(result.reason).toContain('marker file could not be read');
        }
    });

    it('reports a marker read that fails on a remote node as unverified, not drift', async () => {
        // The regression this pins: a transport failure used to arrive as the
        // same null as an absent marker, so the check answered `drifted` on the
        // revision cause and Enforce went on to attempt a repair against a node
        // that had just demonstrated it could not be read.
        const remoteNode = seedRemoteNode();
        const bp = seedBlueprint([remoteNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const { GitOpsStore } = await import('../services/gitops/store');
        const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const appId = newGitOpsId();
        GitOpsStore.getInstance().insertApplication(blankInlineApplication(appId, bp.id, Date.now()));
        await seedAcknowledgedInlineApp(appId, bp.id, remoteNode.id);
        await stubProxyTarget(remoteNode);
        vi.spyOn(axios, 'get').mockRejectedValue(new Error('socket hang up'));

        const result = await BlueprintService.getInstance().checkForDrift(bpObj, remoteNode);

        expect(result.kind).toBe('unverified');
        if (result.kind === 'unverified') {
            expect(result.reason, 'the reason must name the transport failure').toContain('socket hang up');
        }
    });

    it('still reports an absent marker on a remote node as revision drift', async () => {
        // The companion to the case above, and the one that protects the absent
        // path. The leaf reports ENOENT as 404 with its not-found code, which is
        // a fact about the node, and it has to keep being reported as drift.
        const remoteNode = seedRemoteNode();
        const bp = seedBlueprint([remoteNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const { GitOpsStore } = await import('../services/gitops/store');
        const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const appId = newGitOpsId();
        GitOpsStore.getInstance().insertApplication(blankInlineApplication(appId, bp.id, Date.now()));
        await seedAcknowledgedInlineApp(appId, bp.id, remoteNode.id);
        await stubProxyTarget(remoteNode);
        vi.spyOn(axios, 'get').mockResolvedValue({
            status: 404,
            data: { error: 'File not found', code: 'NOT_FOUND' },
        });

        const result = await BlueprintService.getInstance().checkForDrift(bpObj, remoteNode);

        expect(result.kind).toBe('drifted');
        if (result.kind === 'drifted') {
            expect(result.reason).toBe('marker file missing on node');
            expect(result.cause).toBe('revision');
        }
    });

    it.each([
        ['a non-200 answer', { status: 500, data: { error: 'boom' } }, 'HTTP 500: boom'],
        ['a body with no content', { status: 200, data: { content: 42 } }, 'no file content'],
        ['a body that does not parse', { status: 200, data: { content: 'not json' } }, 'could not be parsed'],
        // A 404 the leaf did not shape. A leaf predating the files route, an
        // apiUrl pointing at the wrong base path, and a middlebox all answer
        // 404, and treating one as an absent marker would report a node nobody
        // could read as drifted, which is the error this discrimination removes.
        ['a bare 404 with no body', { status: 404, data: '<!doctype html><title>404</title>' }, 'HTTP 404'],
        ['a 404 from another API', { status: 404, data: { error: 'Unknown endpoint', code: 'ROUTE_NOT_FOUND' } }, 'HTTP 404: Unknown endpoint'],
    ])('reads a remote marker as failed on %s', async (_label, answer, expected) => {
        // The result type, not the verdict: an unreadable marker and an absent
        // one must never collapse back into the same value.
        const remoteNode = seedRemoteNode();
        await stubProxyTarget(remoteNode);
        vi.spyOn(axios, 'get').mockResolvedValue(answer);

        const read = await BlueprintService.getInstance().readMarker('bp-edge-marker', remoteNode);

        expect(read.kind).toBe('failed');
        if (read.kind === 'failed') {
            expect(read.error).toContain(expected);
        }
    });

    it('reads a remote marker the leaf reported absent as missing, and a parseable one as present', async () => {
        const { buildBlueprintMarker } = await import('../helpers/blueprintMarker');
        const remoteNode = seedRemoteNode();
        await stubProxyTarget(remoteNode);

        // The leaf's own not-found answer, which is the only thing that means the
        // marker is absent rather than that this node could not be read.
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: { error: 'File not found', code: 'NOT_FOUND' } });
        expect(await BlueprintService.getInstance().readMarker('bp-edge-marker', remoteNode)).toEqual({ kind: 'missing' });

        vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            data: { content: JSON.stringify(buildBlueprintMarker({ blueprintId: 7, revision: 3, lastApplied: 0 })) },
        });
        const present = await BlueprintService.getInstance().readMarker('bp-edge-marker', remoteNode);
        expect(present.kind).toBe('present');
        if (present.kind === 'present') expect(present.marker.blueprintId).toBe(7);
    });

    it('refuses a remote create whose marker could not be read, as unverifiable rather than as a conflict', async () => {
        // hasNameConflict answers "may I write here", and a node that could not be
        // read does not answer that. It previously reported an unreadable marker
        // as a conflict, which told the operator a stack they do not own was
        // sitting on the node. The refusal is unchanged in both cases; what the
        // operator is told is not.
        const { BlueprintOwnershipProbeError } = await import('../services/BlueprintService');
        const remoteNode = seedRemoteNode();
        await stubProxyTarget(remoteNode);
        vi.spyOn(axios, 'get').mockImplementation((url: string) => {
            // The stack listing answers, so the probe gets as far as the marker;
            // only the marker read fails.
            if (String(url).includes('/api/stacks?')) {
                return Promise.resolve({ status: 200, data: [{ name: 'bp-edge-conflict' }] });
            }
            return Promise.reject(new Error('socket hang up'));
        });

        await expect(
            BlueprintService.getInstance().hasNameConflict('bp-edge-conflict', remoteNode, 1),
        ).rejects.toBeInstanceOf(BlueprintOwnershipProbeError);
    });

    it('reads a local marker that is genuinely absent as missing, not failed', async () => {
        // Only a real ENOENT may produce `missing` on the local arm.
        const localNode = DatabaseService.getInstance().getNodes()[0];

        const read = await BlueprintService.getInstance().readMarker('no-such-stack-anywhere', localNode);

        expect(read).toEqual({ kind: 'missing' });
    });

    it('detects digest drift when marker and containers match but observation identity differs', async () => {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const { GitOpsStore } = await import('../services/gitops/store');
        const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const store = GitOpsStore.getInstance();
        const appId = newGitOpsId();
        const genId = newGitOpsId();
        const artId = newGitOpsId();
        const expectedIdentity = `exact:${'a'.repeat(64)}`;
        store.insertApplication(blankInlineApplication(appId, bp.id, Date.now()));
        store.insertGeneration({
            id: genId,
            application_id: appId,
            commit_sha: 'a'.repeat(40),
            repo_url: `inline://blueprint/${bp.id}`,
            configured_ref: 'inline',
            resolved_ref_kind: null,
            repo_identity_json: JSON.stringify({ host: 'inline', pathname: `/blueprint/${bp.id}` }),
            manifest_version: 1,
            candidate_dir: `generations/inline-${genId}`,
            applied_dir: `generations/inline-${genId}-applied`,
            expected_invocation_json: '{}',
            materialization_fingerprint: 'a'.repeat(64),
            validation_ok: 1,
            plan_blocked: 0,
            change_plan_fingerprint: null,
            operation_id: 'op-digest-drift',
            trigger: 'test',
            actor: null,
            previous_generation_id: null,
            redacted_limitations_json: '[]',
            portable_manifest_json: null,
            compose_inputs_json: null,
            source_policy_evidence_json: null,
            security_policy_evidence_json: null,
            support_requirements_json: null,
            compatibility_requirements_json: null,
            secret_capability_json: null,
            created_at: Date.now(),
        });
        store.insertArtifactSet({
            id: artId,
            generation_id: genId,
            evidence_version: 1,
            authoritative: 0,
            qualification: 'exact',
            evidence_json: JSON.stringify({ kind: 'exact', identity: expectedIdentity }),
            created_at: Date.now(),
        });
        const app = store.getApplication(appId)!;
        app.accepted_generation_id = genId;
        app.artifact_set_id = artId;
        app.latest_artifact_set_id = artId;
        store.writeApplicationPointers(app);
        await acknowledgeInlineTarget(appId, localNode.id, genId, artId);

        vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({ kind: 'present', marker: {
            blueprintId: bp.id,
            revision: bpObj.revision,
            lastApplied: 0,
        } });
        const svc = BlueprintService.getInstance() as unknown as {
            containerHealth: () => Promise<{ kind: 'running' }>;
            observeRuntimeIdentity: () => Promise<import('../services/gitops/json').ObservedArtifactIdentity>;
        };
        vi.spyOn(svc, 'containerHealth').mockResolvedValue({ kind: 'running' });
        vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue({
            kind: 'exact',
            identity: `exact:${'b'.repeat(64)}`,
            observedAt: Date.now(),
        });

        const drifted = await BlueprintService.getInstance().checkForDrift(bpObj, localNode);
        expect(drifted.kind).toBe('drifted');
        if (drifted.kind === 'drifted') {
            expect(drifted.reason).toMatch(/identity differs/i);
        }

        vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue({
            kind: 'exact',
            identity: expectedIdentity,
            observedAt: Date.now(),
        });
        const matched = await BlueprintService.getInstance().checkForDrift(bpObj, localNode);
        expect(matched.kind).toBe('matched');

        vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue({
            kind: 'stale',
            identity: expectedIdentity,
            observedAt: Date.now(),
        });
        const unverified = await BlueprintService.getInstance().checkForDrift(bpObj, localNode);
        expect(unverified.kind).toBe('unverified');
    });

    it('matches mixed-platform observations against the approved child, not a shared fingerprint', async () => {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const { GitOpsStore } = await import('../services/gitops/store');
        const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const {
            encodeArtifactEvidenceJson,
            encodeObservedArtifactIdentity,
        } = await import('../services/gitops/json');
        const amd = `sha256:${'a'.repeat(64)}`;
        const arm = `sha256:${'b'.repeat(64)}`;
        const index = `sha256:${'1'.repeat(64)}`;
        const expectedService = {
            serviceName: 'web',
            authoredRef: 'nginx:latest',
            source: 'registry' as const,
            platform: 'linux/amd64',
            indexDigest: index,
            platformDigest: amd,
            platformVariants: [
                { platform: 'linux/amd64', digest: amd },
                { platform: 'linux/arm64', digest: arm },
            ],
            localDigests: null,
            buildContextFingerprint: null,
            producedImageId: null,
            failureClass: null,
            resolvedAt: 1,
        };
        const store = GitOpsStore.getInstance();
        const appId = newGitOpsId();
        const genId = newGitOpsId();
        const artId = newGitOpsId();
        store.insertApplication(blankInlineApplication(appId, bp.id, Date.now()));
        store.insertGeneration({
            id: genId,
            application_id: appId,
            commit_sha: 'a'.repeat(40),
            repo_url: `inline://blueprint/${bp.id}`,
            configured_ref: 'inline',
            resolved_ref_kind: null,
            repo_identity_json: JSON.stringify({ host: 'inline', pathname: `/blueprint/${bp.id}` }),
            manifest_version: 1,
            candidate_dir: `generations/inline-${genId}`,
            applied_dir: `generations/inline-${genId}-applied`,
            expected_invocation_json: '{}',
            materialization_fingerprint: 'a'.repeat(64),
            validation_ok: 1,
            plan_blocked: 0,
            change_plan_fingerprint: null,
            operation_id: 'op-mixed-arch',
            trigger: 'test',
            actor: null,
            previous_generation_id: null,
            redacted_limitations_json: '[]',
            portable_manifest_json: null,
            compose_inputs_json: null,
            source_policy_evidence_json: null,
            security_policy_evidence_json: null,
            support_requirements_json: null,
            compatibility_requirements_json: null,
            secret_capability_json: null,
            created_at: Date.now(),
        });
        store.insertArtifactSet({
            id: artId,
            generation_id: genId,
            evidence_version: 1,
            authoritative: 0,
            qualification: 'exact',
            evidence_json: encodeArtifactEvidenceJson({
                kind: 'exact',
                identity: `exact:${'e'.repeat(64)}`,
                services: [expectedService],
            }),
            created_at: Date.now(),
        });
        const app = store.getApplication(appId)!;
        app.accepted_generation_id = genId;
        app.artifact_set_id = artId;
        app.latest_artifact_set_id = artId;
        store.writeApplicationPointers(app);
        await acknowledgeInlineTarget(appId, localNode.id, genId, artId);

        vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({ kind: 'present', marker: {
            blueprintId: bp.id,
            revision: bpObj.revision,
            lastApplied: 0,
        } });
        const svc = BlueprintService.getInstance() as unknown as {
            containerHealth: () => Promise<{ kind: 'running' }>;
            observeRuntimeIdentity: () => Promise<import('../services/gitops/json').ObservedArtifactIdentity>;
        };
        vi.spyOn(svc, 'containerHealth').mockResolvedValue({ kind: 'running' });
        vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue(JSON.parse(encodeObservedArtifactIdentity({
            kind: 'exact',
            identity: `exact:${'f'.repeat(64)}`,
            observedAt: Date.now(),
            services: [{
                ...expectedService,
                platform: 'linux/arm64',
                platformDigest: arm,
                localDigests: [arm],
                platformVariants: null,
            }],
        })));

        const matched = await BlueprintService.getInstance().checkForDrift(bpObj, localNode);
        expect(matched.kind).toBe('matched');
    });

    it('holds for a target that never acknowledged an artifact record', async () => {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const { GitOpsStore, emptyTargetRow } = await import('../services/gitops/store');
        const { blankInlineApplication } = await import('../services/gitops/blueprintProducers');
        const { newGitOpsId: newId } = await import('../services/gitops/directApplication');
        GitOpsStore.getInstance().insertApplication(blankInlineApplication(newId(), bp.id, Date.now()));
        // The target exists but has acknowledged nothing: the state a node is in
        // between being asked to hold a Blueprint and the first rollout landing.
        GitOpsStore.getInstance().upsertTarget(
            emptyTargetRow(GitOpsStore.getInstance().getLiveBlueprintApplication(bp.id)!.id, localNode.id, Date.now()),
        );
        vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({ kind: 'present', marker: {
            blueprintId: bp.id,
            revision: bpObj.revision,
            lastApplied: 0,
        } });
        const svc = BlueprintService.getInstance() as unknown as {
            containerHealth: () => Promise<{ kind: 'running' }>;
            observeRuntimeIdentity: () => Promise<import('../services/gitops/json').ObservedArtifactIdentity>;
        };
        vi.spyOn(svc, 'containerHealth').mockResolvedValue({ kind: 'running' });
        vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue({
            kind: 'exact',
            identity: `exact:${'a'.repeat(64)}`,
            observedAt: Date.now(),
        });

        // A target that was never acknowledged has no expected identity to
        // compare against, so the check cannot classify it either way. That is
        // unverified, carrying the block that says Enforce may not act, so the
        // reconciler can still put the decision on the row.
        const result = await BlueprintService.getInstance().checkForDrift(bpObj, localNode);
        expect(result.kind).toBe('unverified');
        if (result.kind === 'unverified') {
            expect(result.repairBlock?.reason).toBe('evidence_incomplete');
        }
    });

    it('refuses to withdraw when the marker belongs to a different blueprint', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const composeDir = process.env.COMPOSE_DIR!;
        const localNode = DatabaseService.getInstance().getNodes()[0];
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?')
            .run(composeDir, localNode.id);
        const refreshed = DatabaseService.getInstance().getNode(localNode.id)!;
        const bp = seedBlueprint([refreshed.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: refreshed.id,
            status: 'active',
            applied_revision: bpObj.revision,
            last_deployed_at: Date.now(),
        });

        const stackDir = path.join(composeDir, bpObj.name);
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
        fs.writeFileSync(
            path.join(stackDir, '.blueprint.json'),
            JSON.stringify({ blueprintId: bp.id + 999, revision: 1, lastApplied: 0 }),
        );

        const { DeployedStackDeletionService } = await import('../services/DeployedStackDeletionService');
        const deleteSpy = vi.spyOn(DeployedStackDeletionService.getInstance(), 'deleteDeployedStack');

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, refreshed);

        expect(result.status).toBe('name_conflict');
        // deleteDeployedStack is invoked but returns name_conflict without mutating.
        expect(deleteSpy).toHaveBeenCalled();
        const dep = DatabaseService.getInstance().getDeployment(bp.id, refreshed.id);
        expect(dep).toBeDefined();
        expect(dep?.status).toBe('name_conflict');
        expect(fs.existsSync(path.join(stackDir, 'compose.yaml'))).toBe(true);
    });
});

describe('BlueprintService developer-mode diagnostics', () => {
    // withdrawFromNode emits its "withdraw inputs" diagnostic before the deletion
    // service runs. An absent stack directory is enough to exercise logging without Docker.
    function arrangeWithdraw() {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        return { bpObj, localNode };
    }

    it('does not emit diagnostic logs when developer mode is off', async () => {
        const { bpObj, localNode } = arrangeWithdraw();
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await BlueprintService.getInstance().withdrawFromNode(bpObj, localNode);

        expect(infoSpy.mock.calls.some(([m]) => String(m).includes('[BlueprintService:diag]'))).toBe(false);
    });

    it('emits diagnostic logs when developer mode is on', async () => {
        DatabaseService.getInstance().updateGlobalSetting('developer_mode', '1');
        const { bpObj, localNode } = arrangeWithdraw();
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await BlueprintService.getInstance().withdrawFromNode(bpObj, localNode);

        expect(infoSpy.mock.calls.some(([m]) => String(m).includes('[BlueprintService:diag]'))).toBe(true);
    });
});

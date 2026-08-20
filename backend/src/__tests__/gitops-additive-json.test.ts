/**
 * Exact API shapes for the additive GitOps revision fields on the Blueprint,
 * node-label, and node surfaces.
 *
 * Two things are being defended here. The first is that the fields are
 * genuinely additive: the routes keep their status codes, the two DELETEs stay
 * 204 with no body, and the pre-existing keys are untouched. The second is that
 * `gitopsRevisions` reports only what a mutation actually moved. A label or a
 * cordon that no selector reacts to must answer with an empty list rather than
 * every Blueprint in the fleet, because a consumer reading that list as "these
 * changed" would otherwise invalidate the whole catalog over an edit nobody can
 * observe.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let adminCookie: string;
let counter = 0;

function seedNode(): { id: number; name: string } {
    counter += 1;
    const name = `additive-node-${counter}`;
    const result = DatabaseService.getInstance().getDb().prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(name, Date.now());
    return { id: result.lastInsertRowid as number, name };
}

/** A Blueprint inserted straight into the table, so no GitOps application exists for it. */
function seedUnmodelledBlueprint() {
    counter += 1;
    return DatabaseService.getInstance().createBlueprint({
        name: `additive-unmodelled-${counter}`,
        description: null,
        compose_content: 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: [] },
        drift_mode: 'suggest',
        classification: 'stateless',
        classification_reasons: [],
        enabled: true,
        created_by: 'admin',
    });
}

/** A minimal live Direct application row, for the stack-name resolution cases. */
function directApplication(id: string, stackName: string): import('../services/gitops/types').GitOpsApplicationRow {
    const now = Date.now();
    return {
        id,
        lifecycle_key: `direct:${stackName}`,
        lifecycle_status: 'active',
        target_mode: 'direct',
        stack_name: stackName,
        blueprint_id: null,
        configured_repo_url: 'https://github.com/example/repo.git',
        repo_identity_json: '{"host":"github.com","pathname":"/example/repo.git"}',
        configured_ref: 'main',
        compose_paths_json: '["compose.yaml"]',
        context_dir: null,
        sync_env: 0,
        env_path: null,
        materialization_fingerprint: 'a'.repeat(64),
        desired_commit_sha: null,
        fetched_commit_sha: null,
        candidate_generation_id: null,
        accepted_generation_id: null,
        candidate_plan_blocked: 0,
        review_required: 0,
        artifact_set_id: null,
        latest_artifact_set_id: null,
        intent_revision_id: null,
        rollout_candidate_id: null,
        rollout_generation_id: null,
        source_acceptance_ref: null,
        placement_approval_ref: null,
        rollout_authorization_ref: null,
        legacy_combined_approval_ref: null,
        preflight_fingerprint: null,
        latest_operation_id: null,
        active_operation_id: null,
        active_operation_stage: null,
        active_operation_at: null,
        active_generation_id: null,
        pause_at: null,
        pause_reason: null,
        partial_json: null,
        failure_stage: null,
        failure_class: null,
        failure_at: null,
        retry_at: null,
        retry_count: 0,
        suspended_at: null,
        recovery_ref: null,
        recovery_phase: null,
        interruption_stage: null,
        interruption_at: null,
        interruption_operation_id: null,
        interruption_generation_id: null,
        evidence_fresh_at: null,
        evidence_limitations_json: null,
        created_at: now,
        updated_at: now,
    };
}

/** Create through the route, which is the path that activates an application. */
async function createBlueprint(selector: { type: string; ids?: number[]; all?: string[]; any?: string[] }) {
    counter += 1;
    const res = await request(app)
        .post('/api/blueprints')
        .set('Cookie', adminCookie)
        .send({
            name: `additive-bp-${counter}`,
            compose_content: 'services:\n  app:\n    image: nginx\n',
            selector,
        });
    expect(res.status).toBe(201);
    return res;
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM gitops_history').run();
    db.prepare('DELETE FROM gitops_target_current').run();
    db.prepare('DELETE FROM gitops_rollout_candidates').run();
    db.prepare('DELETE FROM gitops_intent_revisions').run();
    db.prepare('DELETE FROM gitops_applications').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM node_labels').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

describe('Blueprint routes carry gitopsRevision', () => {
    it('projects the live application the create activated, and reports it identically on list and detail', async () => {
        const created = await createBlueprint({ type: 'nodes', ids: [] });
        expect(created.body.gitopsRevision).toMatchObject({
            schemaVersion: 1,
            targetMode: 'inline_blueprint',
            lifecycleStatus: 'active',
            blueprintId: created.body.id,
        });
        const applicationId = created.body.gitopsRevision.applicationId;
        expect(typeof applicationId).toBe('string');

        // The same application id has to come back from every surface, or two
        // views of one Blueprint would disagree about which application is live.
        const detail = await request(app).get(`/api/blueprints/${created.body.id}`).set('Cookie', adminCookie);
        expect(detail.status).toBe(200);
        expect(detail.body.gitopsRevision.applicationId).toBe(applicationId);

        const list = await request(app).get('/api/blueprints').set('Cookie', adminCookie);
        expect(list.status).toBe(200);
        const row = list.body.find((b: { id: number }) => b.id === created.body.id);
        expect(row.gitopsRevision.applicationId).toBe(applicationId);
    });

    it('gives a Blueprint with no application the uniform not-applicable shape', async () => {
        const bp = seedUnmodelledBlueprint();
        const detail = await request(app).get(`/api/blueprints/${bp.id}`).set('Cookie', adminCookie);
        expect(detail.status).toBe(200);
        // Not an omitted key and not a throw: the catalog needs one shape across
        // rows whether or not migration has brought a Blueprint into the model.
        expect(detail.body.gitopsRevision).toMatchObject({
            schemaVersion: 1,
            targetMode: 'not_applicable',
            applicationId: null,
            facets: null,
        });
    });

    it('carries gitopsRevision on update and on pin, and leaves the existing keys alone', async () => {
        const node = seedNode();
        const created = await createBlueprint({ type: 'nodes', ids: [node.id] });

        const updated = await request(app)
            .put(`/api/blueprints/${created.body.id}`)
            .set('Cookie', adminCookie)
            .send({ description: 'revised' });
        expect(updated.status).toBe(200);
        expect(updated.body.description).toBe('revised');
        expect(updated.body.id).toBe(created.body.id);
        expect(updated.body.gitopsRevision.applicationId).toBe(created.body.gitopsRevision.applicationId);

        const pinned = await request(app)
            .put(`/api/blueprints/${created.body.id}/pin`)
            .set('Cookie', adminCookie)
            .send({ nodeId: node.id });
        expect(pinned.status).toBe(200);
        expect(pinned.body.pinned_node_id).toBe(node.id);
        expect(pinned.body.gitopsRevision.applicationId).toBe(created.body.gitopsRevision.applicationId);
    });

    it('keeps DELETE at 204 with no body', async () => {
        const created = await createBlueprint({ type: 'nodes', ids: [] });
        const res = await request(app).delete(`/api/blueprints/${created.body.id}`).set('Cookie', adminCookie);
        expect(res.status).toBe(204);
        expect(res.body).toEqual({});
        expect(res.text).toBeFalsy();
    });
});

describe('Projection resolution reaches every application that owns a surface', () => {
    it('reports a detached Blueprint as detached rather than as never modelled', async () => {
        const created = await createBlueprint({ type: 'nodes', ids: [] });
        const applicationId = created.body.gitopsRevision.applicationId;
        const store = (await import('../services/gitops/store')).GitOpsStore.getInstance();
        const tx = (await import('../services/gitops/transitions')).GitOpsTransitions.getInstance();
        tx.applicationTombstoned(applicationId, 'detached', {
            operationId: 'op-detach-test', actor: 'tester', trigger: 'manual', at: Date.now(),
        });
        expect(store.getLiveBlueprintApplication(created.body.id)).toBeUndefined();

        const detail = await request(app).get(`/api/blueprints/${created.body.id}`).set('Cookie', adminCookie);
        expect(detail.status).toBe(200);
        // The tombstone keeps the identity as frozen fact so the projection can
        // still say what this was. Answering not_applicable would report a
        // Blueprint that was deliberately detached exactly like one that never
        // had Git at all.
        expect(detail.body.gitopsRevision).toMatchObject({
            applicationId,
            lifecycleStatus: 'detached',
        });
        // An inline Blueprint has no Git source, so its source facet is
        // not_applicable regardless of lifecycle. The Direct case below is what
        // exercises not_live.
        expect(detail.body.gitopsRevision.facets.source.status).toBe('not_applicable');
    });

    it('reports a detached Direct source as not_live, which nothing could reach before', async () => {
        const store = (await import('../services/gitops/store')).GitOpsStore.getInstance();
        const tx = (await import('../services/gitops/transitions')).GitOpsTransitions.getInstance();
        const application = directApplication('app-direct-detach', 'detached-direct-stack');
        tx.activateDirect({
            application,
            nodeId: seedNode().id,
            envelope: { operationId: 'op-direct-detach', actor: 'tester', trigger: 'manual', at: Date.now() },
        });
        tx.applicationTombstoned(application.id, 'detached', {
            operationId: 'op-direct-detach-2', actor: 'tester', trigger: 'manual', at: Date.now(),
        });
        expect(store.getLiveDirectApplication('detached-direct-stack')).toBeUndefined();
        expect(store.getDetachedDirectApplication('detached-direct-stack')?.id).toBe(application.id);

        // The tombstone keeps repository, ref, and SHA pointers as frozen facts
        // so the projection can still say what was there. Before this lookup
        // existed, the source deriver's not_live branch had no way to be
        // reached and a deliberate detach read as "never had Git".
        const { projectStackRevision } = await import('../helpers/gitopsResponse');
        const projection = projectStackRevision('detached-direct-stack');
        expect(projection).toMatchObject({ applicationId: application.id, lifecycleStatus: 'detached' });
        if (projection.targetMode === 'not_applicable') throw new Error('expected an application');
        expect(projection.facets.source).toMatchObject({ status: 'not_live', lifecycleStatus: 'detached' });
    });

    it('does not resurrect a deleted application for a stack name that gets reused', async () => {
        const tx = (await import('../services/gitops/transitions')).GitOpsTransitions.getInstance();
        const application = directApplication('app-reuse', 'reused-name-stack');
        tx.activateDirect({
            application,
            nodeId: seedNode().id,
            envelope: { operationId: 'op-reuse', actor: 'tester', trigger: 'manual', at: Date.now() },
        });
        tx.applicationTombstoned(application.id, 'deleted', {
            operationId: 'op-reuse-2', actor: 'tester', trigger: 'manual', at: Date.now(),
        });

        // Deletion means the stack is gone, so a directory of that name now is
        // a different stack. Reporting the old repository and SHA against it
        // would disclose one stack's Git identity through another's name.
        const { projectStackRevision } = await import('../helpers/gitopsResponse');
        expect(projectStackRevision('reused-name-stack')).toMatchObject({ targetMode: 'not_applicable' });
    });

    it('says why when the application it resolved has gone missing', async () => {
        const created = await createBlueprint({ type: 'nodes', ids: [] });
        const store = (await import('../services/gitops/store')).GitOpsStore.getInstance();
        const live = store.getLiveBlueprintApplication(created.body.id);
        // Resolve the row, then delete it before the projection re-reads it by
        // id. That is the window the two non-transactional reads leave open.
        vi.spyOn(store, 'getLiveBlueprintApplication').mockImplementation((id: number) => {
            DatabaseService.getInstance().getDb()
                .prepare('DELETE FROM gitops_applications WHERE blueprint_id = ?').run(id);
            return live;
        });

        const detail = await request(app).get(`/api/blueprints/${created.body.id}`).set('Cookie', adminCookie);
        expect(detail.status).toBe(200);
        expect(detail.body.gitopsRevision.targetMode).toBe('not_applicable');
        // The distinguishing fact: an unmodelled Blueprint carries no limitation.
        expect(detail.body.gitopsRevision.limitations).toEqual([
            expect.objectContaining({ code: 'application_row_missing' }),
        ]);
    });

    it('leaves an unmodelled Blueprint with no limitation, so the two stay distinguishable', async () => {
        const bp = seedUnmodelledBlueprint();
        const detail = await request(app).get(`/api/blueprints/${bp.id}`).set('Cookie', adminCookie);
        expect(detail.body.gitopsRevision.limitations).toEqual([]);
    });
});

describe('Node-label routes report only the Blueprints a label moved', () => {
    it('carries gitopsRevisions for a Blueprint whose selector reacts to the label', async () => {
        const node = seedNode();
        const created = await createBlueprint({ type: 'labels', all: ['edge'] });

        const res = await request(app)
            .post(`/api/node-labels/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ label: 'edge' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ nodeId: node.id, label: 'edge' });
        expect(res.body.gitopsRevisions).toHaveLength(1);
        expect(res.body.gitopsRevisions[0]).toMatchObject({
            blueprintId: created.body.id,
            applicationId: created.body.gitopsRevision.applicationId,
        });
    });

    it('reports an empty list for a label no selector mentions', async () => {
        const node = seedNode();
        await createBlueprint({ type: 'nodes', ids: [] });

        const res = await request(app)
            .post(`/api/node-labels/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ label: 'unrelated' });
        expect(res.status).toBe(201);
        expect(res.body.gitopsRevisions).toEqual([]);
    });

    it('keeps DELETE at 204 with no body', async () => {
        const node = seedNode();
        await request(app)
            .post(`/api/node-labels/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ label: 'edge' });

        const res = await request(app)
            .delete(`/api/node-labels/${node.id}/edge`)
            .set('Cookie', adminCookie);
        expect(res.status).toBe(204);
        expect(res.body).toEqual({});
        expect(res.text).toBeFalsy();
    });
});

describe('Node routes carry gitopsRevisions', () => {
    it('carries the field on cordon, empty because a cordon revises no intent', async () => {
        const node = seedNode();
        await createBlueprint({ type: 'nodes', ids: [node.id] });

        const res = await request(app).post(`/api/nodes/${node.id}/cordon`).set('Cookie', adminCookie).send({});
        expect(res.status).toBe(200);
        expect(res.body.cordoned).toBe(true);
        // Deliberately empty, and asserted so the reason is not lost. A cordon
        // suppresses new placements; it does not change what a Blueprint asks
        // for, and `listDesiredNodes` reports what is asked for. The set is
        // therefore identical either side of the write, so nothing is revised
        // and nothing is reported. The field is still present, so a consumer
        // reads one shape across every mutation.
        expect(res.body.gitopsRevisions).toEqual([]);
    });

    it('carries the field on uncordon', async () => {
        const node = seedNode();
        await createBlueprint({ type: 'nodes', ids: [node.id] });
        await request(app).post(`/api/nodes/${node.id}/cordon`).set('Cookie', adminCookie).send({});

        const res = await request(app).post(`/api/nodes/${node.id}/uncordon`).set('Cookie', adminCookie).send({});
        expect(res.status).toBe(200);
        expect(res.body.cordoned).toBe(false);
        expect(res.body.gitopsRevisions).toEqual([]);
    });

    it('orders revisions by blueprintId ascending when a mutation moves several', async () => {
        const node = seedNode();
        const first = await createBlueprint({ type: 'labels', all: ['fleet'] });
        const second = await createBlueprint({ type: 'labels', all: ['fleet'] });

        const res = await request(app)
            .post(`/api/node-labels/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ label: 'fleet' });
        expect(res.status).toBe(201);
        // Ordering is the contract, not the order the producer happened to visit
        // the Blueprints in, which is a Map iteration order.
        const ids = res.body.gitopsRevisions.map((r: { blueprintId: number }) => r.blueprintId);
        expect(ids).toEqual([first.body.id, second.body.id].sort((a, b) => a - b));
    });

    it('reports the Blueprints that lost a target when a node is deleted', async () => {
        const node = seedNode();
        const bp = await createBlueprint({ type: 'nodes', ids: [node.id] });
        const applicationId = bp.body.gitopsRevision.applicationId;
        // A target has to exist on the node for the deletion to retire one. The
        // route reads the owners before the tombstone, which is the only moment
        // the link from target back to Blueprint still exists.
        DatabaseService.getInstance().getDb().prepare(
            `INSERT INTO gitops_target_current (application_id, node_id, target_status, updated_at)
             VALUES (?, ?, 'active', ?)`,
        ).run(applicationId, node.id, Date.now());

        const res = await request(app).delete(`/api/nodes/${node.id}`).set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.gitopsRevisions.map((r: { blueprintId: number }) => r.blueprintId)).toEqual([bp.body.id]);
    });

    it('still reports a node deletion as successful when the revision projection fails', async () => {
        const node = seedNode();
        await createBlueprint({ type: 'nodes', ids: [node.id] });
        // The write commits before the decoration is built. If a projection
        // fault escaped, the operator would be told a hard delete failed and
        // would retry it, and the retry answers "Node not found": two wrong
        // answers about an operation that actually succeeded.
        const store = (await import('../services/gitops/store')).GitOpsStore.getInstance();
        vi.spyOn(store, 'getLiveBlueprintApplication').mockImplementation(() => {
            throw new Error('projection exploded');
        });

        const res = await request(app).delete(`/api/nodes/${node.id}`).set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, gitopsRevisions: [] });
        // And the node really is gone, so the success it reported was true.
        expect(DatabaseService.getInstance().getNode(node.id)).toBeUndefined();
    });

    it('reports an empty list when a deleted node held no Blueprint target', async () => {
        const node = seedNode();
        const res = await request(app).delete(`/api/nodes/${node.id}`).set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, gitopsRevisions: [] });
    });
});

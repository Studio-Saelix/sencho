/**
 * Approval-gated reconciler safety: pending / malformed / drifted approval must
 * not mutate the fleet; confirmed place/remove only authorizes matching nodes.
 * These tests call the real reconcileOne path (not a mocked reconcileConfirmedPlan).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import {
    intentFingerprint,
    serializeApprovedBlast,
} from '../services/blueprintApproval';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let NodeLabelService: typeof import('../services/NodeLabelService').NodeLabelService;
let counter = 0;

function seedNode(opts: {
    type?: 'local' | 'remote';
    mode?: string;
    status?: string;
    last_successful_contact?: number | null;
    pilot_last_seen?: number | null;
} = {}): { id: number; name: string } {
    counter += 1;
    const name = `bp-gate-node-${counter}`;
    const db = DatabaseService.getInstance().getDb();
    const type = opts.type ?? 'local';
    const mode = opts.mode ?? 'proxy';
    const status = opts.status ?? 'online';
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at, last_successful_contact, pilot_last_seen)
         VALUES (?, ?, ?, '/tmp/compose', 0, ?, ?, ?, ?)`,
    ).run(
        name,
        type,
        mode,
        status,
        Date.now(),
        opts.last_successful_contact ?? null,
        opts.pilot_last_seen ?? null,
    );
    return { id: result.lastInsertRowid as number, name };
}

function createBp(opts: {
    nodeIds?: number[];
    labelsAny?: string[];
    classification?: 'stateless' | 'stateful';
    compose?: string;
}) {
    counter += 1;
    return DatabaseService.getInstance().createBlueprint({
        name: `bp-gate-${counter}`,
        description: null,
        compose_content: opts.compose ?? 'services:\n  app:\n    image: nginx\n',
        selector: opts.labelsAny
            ? { type: 'labels', any: opts.labelsAny, all: [] }
            : { type: 'nodes', ids: opts.nodeIds ?? [] },
        drift_mode: 'observe',
        classification: opts.classification ?? 'stateless',
        classification_reasons: opts.classification === 'stateful' ? ['named volume'] : [],
        enabled: true,
        created_by: 'admin',
    });
}

function approvePlace(blueprintId: number, nodeIds: number[]) {
    const bp = DatabaseService.getInstance().getBlueprint(blueprintId)!;
    DatabaseService.getInstance().setBlueprintApproval(blueprintId, {
        intentFingerprint: intentFingerprint(bp),
        blastJson: serializeApprovedBlast(nodeIds.map(nodeId => ({ nodeId, outcome: 'place' as const }))),
        approvedBy: 'admin',
    });
}

function approveRemove(blueprintId: number, nodeIds: number[]) {
    const bp = DatabaseService.getInstance().getBlueprint(blueprintId)!;
    DatabaseService.getInstance().setBlueprintApproval(blueprintId, {
        intentFingerprint: intentFingerprint(bp),
        blastJson: serializeApprovedBlast(nodeIds.map(nodeId => ({ nodeId, outcome: 'remove' as const }))),
        approvedBy: 'admin',
    });
}

/** Migrate the blueprint into GitOps and open a placement-approved generation. */
async function openGitOpsPlacement(opts: {
    blueprintId: number;
    placeNodeIds: number[];
    requiredNodeIds: number[];
}): Promise<{ id: string }> {
    const { migrateInlineBlueprints } = await import('../services/gitops/migrate');
    const { GitOpsStore } = await import('../services/gitops/store');
    const { GitOpsTransitions } = await import('../services/gitops/transitions');
    const { encodeGitOpsApprovedTargetEffectJson } = await import('../services/gitops/json');
    const { newGitOpsId } = await import('../services/gitops/directApplication');
    migrateInlineBlueprints();
    const gitopsApp = GitOpsStore.getInstance().getLiveBlueprintApplication(opts.blueprintId)!;
    const bp = DatabaseService.getInstance().getBlueprint(opts.blueprintId)!;
    GitOpsTransitions.getInstance().placementApproved({
        applicationId: gitopsApp.id,
        approvalId: newGitOpsId(),
        intentRevisionId: gitopsApp.intent_revision_id!,
        blastJson: encodeGitOpsApprovedTargetEffectJson(
            opts.placeNodeIds.map((nodeId) => ({ nodeId, outcome: 'place' as const })),
        ),
        requiredNodeIds: opts.requiredNodeIds,
        fingerprint: intentFingerprint(bp),
        actor: 'admin',
        envelope: {
            operationId: newGitOpsId(),
            actor: 'admin',
            trigger: 'test',
            at: Date.now(),
        },
        rolloutGenerationId: newGitOpsId(),
        candidateId: gitopsApp.rollout_candidate_id!,
        authority: 'operator',
        policyProvenanceJson: null,
    });
    return gitopsApp;
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));
    ({ BlueprintService } = await import('../services/BlueprintService'));
    ({ NodeLabelService } = await import('../services/NodeLabelService'));
    adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM node_labels').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

describe('reconcileOne approval gate (real path)', () => {
    it('does not deploy or withdraw when approval is pending', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        expect(bp.approval_status).toBe('pending');

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });

        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().listDeployments(bp.id)).toEqual([]);
    });

    /** Approve `bp` for placement on `nodeId`, then sever that placement in
     *  the canonical model so every auto-decision path sees it as tombstoned. */
    async function seedSeveredPlacement(bpId: number, nodeId: number): Promise<void> {
        const db = DatabaseService.getInstance().getDb();
        const bp = DatabaseService.getInstance().getBlueprint(bpId)!;
        db.prepare(
            `UPDATE blueprints SET approval_status = 'approved',
                approved_intent_fingerprint = ?,
                approved_blast_json = ?
             WHERE id = ?`,
        ).run(
            intentFingerprint(bp),
            serializeApprovedBlast([{ nodeId, outcome: 'place' as const }]),
            bpId,
        );

        const { migrateInlineBlueprints } = await import('../services/gitops/migrate');
        const { GitOpsStore, emptyTargetRow } = await import('../services/gitops/store');
        migrateInlineBlueprints();
        const gitopsApp = GitOpsStore.getInstance().getLiveBlueprintApplication(bpId)!;
        GitOpsStore.getInstance().upsertTarget({
            ...emptyTargetRow(gitopsApp.id, nodeId, Date.now()),
            target_status: 'tombstoned',
        });
    }

    function seedDeployment(bpId: number, nodeId: number, status: string, appliedRevision: number | null): void {
        DatabaseService.getInstance().getDb().prepare(
            `INSERT INTO blueprint_deployments (blueprint_id, node_id, status, applied_revision, last_deployed_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(bpId, nodeId, status, appliedRevision, Date.now());
    }

    it('does not auto-place onto a tombstoned target', async () => {
        // A withdraw (or node delete) severs the placement in the model. The
        // tick must treat that as authoritative instead of resurrecting the
        // workload behind the projection's back; only an explicit deploy
        // re-opens the placement.
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        await seedSeveredPlacement(bp.id, node.id);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('does not auto-redeploy a stale revision onto a tombstoned target', async () => {
        // Severance also blocks the update path: an existing deployment that
        // lagged behind the blueprint must wait for an explicit deploy, never
        // catch up on its own while the model says the placement is gone.
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        await seedSeveredPlacement(bp.id, node.id);
        seedDeployment(bp.id, node.id, 'active', bp.revision - 1);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('does not redeploy a failed placement onto a tombstoned target', async () => {
        // A failed run on a severed placement is evidence of the severance, not
        // a retry request. Redeploying here would undo the withdraw the model
        // already recorded.
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        await seedSeveredPlacement(bp.id, node.id);
        seedDeployment(bp.id, node.id, 'failed', bp.revision);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('does not mutate when approval_status is approved but blast JSON is malformed', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        const db = DatabaseService.getInstance().getDb();
        db.prepare(
            `UPDATE blueprints SET approval_status = 'approved',
                approved_intent_fingerprint = ?,
                approved_blast_json = '{bad'
             WHERE id = ?`,
        ).run(intentFingerprint(bp), bp.id);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().listDeployments(bp.id)).toEqual([]);
    });

    it('does not mutate when the intent fingerprint has drifted', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        approvePlace(bp.id, [node.id]);
        DatabaseService.getInstance().updateBlueprint(bp.id, {
            compose_content: 'services:\n  app:\n    image: nginx:alpine\n',
        });

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        expect(refreshed.approval_status).toBe('pending');
    });

    it('deploys only place-authorized nodes after confirmation', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = createBp({ nodeIds: [nodeA.id, nodeB.id] });
        approvePlace(bp.id, [nodeA.id]);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(deploySpy).toHaveBeenCalled();
        const deployedIds = deploySpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(deployedIds).toContain(nodeA.id);
        expect(deployedIds).not.toContain(nodeB.id);
        expect(withdrawSpy).not.toHaveBeenCalled();
    });

    it('withdraws only remove-authorized nodes after confirmation', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        // Empty desired set so both live rows become remove candidates.
        const bp = createBp({ nodeIds: [] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeA.id,
            status: 'active',
            last_deployed_at: Date.now(),
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeB.id,
            status: 'active',
            last_deployed_at: Date.now(),
        });
        approveRemove(bp.id, [nodeA.id]);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).toHaveBeenCalled();
        const withdrawnIds = withdrawSpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(withdrawnIds).toContain(nodeA.id);
        expect(withdrawnIds).not.toContain(nodeB.id);
    });

    it('does not place on a newly labeled node without reapproval', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        NodeLabelService.getInstance().addLabel(nodeA.id, 'web');
        const bp = createBp({ labelsAny: ['web'] });
        approvePlace(bp.id, [nodeA.id]);

        NodeLabelService.getInstance().addLabel(nodeB.id, 'web');

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        const deployedIds = deploySpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(deployedIds).not.toContain(nodeB.id);
        expect(deployedIds).toContain(nodeA.id);
    });

    it('pin clears approval so post-pin reconcileOne does not mutate', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        approvePlace(bp.id, [node.id]);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        const pinRes = await request(app)
            .put(`/api/blueprints/${bp.id}/pin`)
            .set('Cookie', adminCookie)
            .send({ nodeId: node.id });
        expect(pinRes.status).toBe(200);
        expect(pinRes.body.approval_status).toBe('pending');

        // Pin route fires reconcileOne async; also call explicitly for determinism.
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();
    });
});

describe('reconcileConfirmedPlan fingerprint gate', () => {
    it('does not deploy when approval fingerprint no longer matches live compose', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        // Simulate an approved row whose fingerprint lags a concurrent compose edit.
        const staleFp = intentFingerprint(bp);
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE blueprints SET compose_content = ?,
                approval_status = 'approved',
                approved_intent_fingerprint = ?,
                approved_blast_json = ?,
                approved_at = ?,
                approved_by = 'admin'
             WHERE id = ?`,
        ).run(
            'services:\n  app:\n    image: nginx:evil\n',
            staleFp,
            serializeApprovedBlast([{ nodeId: node.id, outcome: 'place' }]),
            Date.now(),
            bp.id,
        );

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });

        const result = await BlueprintReconciler.getInstance().reconcileConfirmedPlan(bp.id, [
            { nodeId: node.id, action: 'create' },
        ]);

        expect(result.outcomes).toEqual([]);
        expect(result.refused).toBe(true);
        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();
    });

    it('deploys authorized actions when approval fingerprint matches live intent', async () => {
        const authorized = seedNode();
        const unauthorized = seedNode();
        const bp = createBp({ nodeIds: [authorized.id, unauthorized.id] });
        approvePlace(bp.id, [authorized.id]);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });

        const result = await BlueprintReconciler.getInstance().reconcileConfirmedPlan(bp.id, [
            { nodeId: authorized.id, action: 'create' },
            { nodeId: unauthorized.id, action: 'create' },
        ]);

        expect(result.refused).toBeFalsy();
        expect(deploySpy).toHaveBeenCalledTimes(1);
        expect(deploySpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: bp.id, compose_content: bp.compose_content }),
            expect.objectContaining({ id: authorized.id }),
        );
        expect(withdrawSpy).not.toHaveBeenCalled();
        expect(result.outcomes).toEqual([{
            nodeId: authorized.id,
            nodeName: authorized.name,
            action: 'create',
            status: 'ok',
        }]);
    });

    it('keeps the registry delivery refusal code on a failed deploy outcome', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        approvePlace(bp.id, [node.id]);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({
            status: 'failed',
            error: 'Remote deploy failed',
            code: 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE',
        });

        const result = await BlueprintReconciler.getInstance().reconcileConfirmedPlan(bp.id, [
            { nodeId: node.id, action: 'create' },
        ]);

        expect(deploySpy).toHaveBeenCalledTimes(1);
        expect(result.refused).toBeFalsy();
        expect(result.outcomes).toEqual([{
            nodeId: node.id,
            nodeName: node.name,
            action: 'create',
            status: 'failed',
            error: 'Remote deploy failed',
            code: 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE',
        }]);
    });
});

describe('Accept/Evict STALE_GUARD', () => {
    it('refuses Accept without a valid place approval', async () => {
        const node = seedNode();
        const bp = createBp({
            nodeIds: [node.id],
            classification: 'stateful',
            compose: 'services:\n  app:\n    image: nginx\n    volumes:\n      - data:/data\nvolumes:\n  data:\n',
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'pending_state_review',
        });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/accept/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ mode: 'fresh' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('STALE_GUARD');
    });

    it('refuses Evict from evict_blocked without a valid remove approval', async () => {
        const node = seedNode();
        const bp = createBp({
            nodeIds: [],
            classification: 'stateful',
            compose: 'services:\n  app:\n    image: nginx\n    volumes:\n      - data:/data\nvolumes:\n  data:\n',
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'evict_blocked',
            last_deployed_at: Date.now(),
        });
        approvePlace(bp.id, [node.id]); // place-only; evict needs remove

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'evict_and_destroy' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('STALE_GUARD');
    });

    it('refuses Evict on an active deployment without remove approval', async () => {
        const node = seedNode();
        const bp = createBp({
            nodeIds: [node.id],
            classification: 'stateful',
            compose: 'services:\n  app:\n    image: nginx\n    volumes:\n      - data:/data\nvolumes:\n  data:\n',
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'active',
            last_deployed_at: Date.now(),
        });
        approvePlace(bp.id, [node.id]);

        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'evict_and_destroy' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('STALE_GUARD');
        expect(withdrawSpy).not.toHaveBeenCalled();
    });

    it('allows standard withdraw on an active stateless deployment without remove approval', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'active',
            last_deployed_at: Date.now(),
        });
        approvePlace(bp.id, [node.id]);

        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'standard' });
        expect(res.status).toBe(200);
        expect(withdrawSpy).toHaveBeenCalledOnce();
    });
});

describe('approval defaults and corrupt-approval fail-closed', () => {
    it('new blueprints persist pending approval columns', () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        expect(bp.approval_status).toBe('pending');
        expect(bp.approved_intent_fingerprint).toBeNull();
        expect(bp.approved_blast_json).toBeNull();
        expect(bp.approved_at).toBeNull();
        expect(bp.approved_by).toBeNull();
    });

    it('approved rows without a usable blast stay pending for effective approval and do not mutate', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        const db = DatabaseService.getInstance().getDb();
        db.prepare(
            `UPDATE blueprints SET approval_status = 'approved',
                approved_intent_fingerprint = NULL,
                approved_blast_json = NULL
             WHERE id = ?`,
        ).run(bp.id);

        const detail = await request(app).get(`/api/blueprints/${bp.id}`).set('Cookie', adminCookie);
        expect(detail.status).toBe(200);
        expect(detail.body.effectiveApproval).toBe('pending');

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('withholds a place outside the frozen GitOps placement set and keeps the nodes it covers', async () => {
        // The operator's blast names a node the frozen set dropped, which is
        // what a node-driven roster change leaves behind. That narrows the blast
        // to the frozen set instead of invalidating the whole approval, so the
        // node the approval covers still deploys.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = createBp({ nodeIds: [nodeA.id, nodeB.id] });
        approvePlace(bp.id, [nodeA.id, nodeB.id]);
        await openGitOpsPlacement({
            blueprintId: bp.id,
            placeNodeIds: [nodeA.id],
            requiredNodeIds: [nodeA.id],
        });

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        const deployedIds = deploySpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(deployedIds).toContain(nodeA.id);
        expect(deployedIds).not.toContain(nodeB.id);

        // The surface reads the narrowed blast too. Reporting approved over a
        // plan the tick will not run would leave it waiting with nothing on
        // screen to prompt for Apply.
        const preview = await request(app).get(`/api/blueprints/${bp.id}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('reapproval_required');
    });

    it('withholds a remove the frozen GitOps placement set still requires', async () => {
        const nodeA = seedNode();
        const bp = createBp({ nodeIds: [] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeA.id,
            status: 'active',
            last_deployed_at: Date.now(),
        });
        approveRemove(bp.id, [nodeA.id]);
        await openGitOpsPlacement({
            blueprintId: bp.id,
            placeNodeIds: [nodeA.id],
            requiredNodeIds: [nodeA.id],
        });

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();
        // Nothing was executed, so the approval stands: it is the withdrawn node
        // the frozen set still requires that waits for the operator.
        const stored = DatabaseService.getInstance().getBlueprint(bp.id)!;
        expect(stored.approval_status).toBe('approved');
        expect(stored.approved_intent_fingerprint).not.toBeNull();
    });

    it('allows dual-write legacy approval when placement_approval_ref is still null', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        approvePlace(bp.id, [node.id]);
        const { migrateInlineBlueprints } = await import('../services/gitops/migrate');
        const { GitOpsStore } = await import('../services/gitops/store');
        migrateInlineBlueprints();
        const gitopsApp = GitOpsStore.getInstance().getLiveBlueprintApplication(bp.id)!;
        expect(gitopsApp.placement_approval_ref).toBeNull();
        expect(gitopsApp.legacy_combined_approval_ref).not.toBeNull();

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        expect(deploySpy).toHaveBeenCalled();
        expect(deploySpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(node.id);
    });

    it('refuses when placement_approval_ref is stale against the current intent', async () => {
        const node = seedNode();
        const bp = createBp({ nodeIds: [node.id] });
        approvePlace(bp.id, [node.id]);
        const gitopsApp = await openGitOpsPlacement({
            blueprintId: bp.id,
            placeNodeIds: [node.id],
            requiredNodeIds: [node.id],
        });
        // Point placement at a different intent so resolveApprovalRef fails closed.
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE gitops_approvals SET intent_revision_id = ? WHERE id = (
                SELECT placement_approval_ref FROM gitops_applications WHERE id = ?
             )`,
        ).run('intent-stale-missing', gitopsApp.id);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        expect(deploySpy).not.toHaveBeenCalled();
    });
});

describe('policy placement authority on an automatic rollout', () => {
    /**
     * An Inline Blueprint in the state an operator's edit leaves behind: the
     * legacy combined approval is pending, and the only current authority is the
     * decomposed placement approval the policy wrote.
     */
    async function seedPolicyPlacedInline(opts: {
        rollout: 'manual' | 'automatic';
        initialNodeIds: number[];
        addedNodeIds: number[];
        alsoChangeCompose?: boolean;
    }): Promise<number> {
        const { commitBlueprintCreate, commitBlueprintUpdate } = await import('../services/gitops/blueprintProducers');
        const { GitOpsStore } = await import('../services/gitops/store');
        const { GitOpsTransitions } = await import('../services/gitops/transitions');
        const { encodeGitOpsApprovedTargetEffectJson } = await import('../services/gitops/json');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const desiredIdsFor = (bp: import('../services/DatabaseService').Blueprint): number[] =>
            BlueprintReconciler.getInstance()
                .listDesiredNodes(bp, DatabaseService.getInstance().getNodes())
                .map((n) => n.id);

        counter += 1;
        const bp = commitBlueprintCreate({
            name: `bp-gate-policy-${counter}`,
            description: null,
            compose_content: 'services:\n  app:\n    image: nginx\n',
            selector: { type: 'nodes', ids: opts.initialNodeIds },
            drift_mode: 'observe',
            classification: 'stateless',
            classification_reasons: [],
            enabled: true,
            created_by: 'admin',
        }, desiredIdsFor);

        const app = GitOpsStore.getInstance().getLiveBlueprintApplication(bp.id)!;
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE gitops_applications
                SET placement_policy = 'bounded_auto', rollout_authorization_policy = ?
              WHERE id = ?`,
        ).run(opts.rollout, app.id);

        // A prior placement authority over the initial set, so the change is an
        // ordinary single addition rather than a first placement.
        GitOpsTransitions.getInstance().placementApproved({
            applicationId: app.id,
            approvalId: newGitOpsId(),
            intentRevisionId: app.intent_revision_id!,
            blastJson: encodeGitOpsApprovedTargetEffectJson(
                opts.initialNodeIds.map((nodeId) => ({ nodeId, outcome: 'place' as const })),
            ),
            requiredNodeIds: opts.initialNodeIds,
            fingerprint: null,
            actor: 'admin',
            envelope: { operationId: newGitOpsId(), actor: 'admin', trigger: 'test', at: Date.now() },
            rolloutGenerationId: newGitOpsId(),
            candidateId: app.rollout_candidate_id!,
            authority: 'operator',
            policyProvenanceJson: null,
        });

        // The initial placement has run, so its nodes are retained deployments
        // rather than nodes waiting for a first deploy. The change under test is
        // then an ordinary single addition on top of a running set.
        for (const nodeId of opts.initialNodeIds) {
            DatabaseService.getInstance().getDb().prepare(
                `INSERT INTO blueprint_deployments (blueprint_id, node_id, status, applied_revision, last_deployed_at)
                 VALUES (?, ?, 'active', ?, ?)`,
            ).run(bp.id, nodeId, bp.revision, Date.now());
        }

        // The operational edit the policy answers. The legacy approval clears,
        // and the policy writes the placement approval the reconciler used to
        // record and then ignore.
        const nextSelector = { type: 'nodes' as const, ids: [...opts.initialNodeIds, ...opts.addedNodeIds] };
        commitBlueprintUpdate(
            bp.id,
            opts.alsoChangeCompose
                ? {
                    selector: nextSelector,
                    compose_content: 'services:\n  app:\n    image: nginx:alpine\n',
                    bumpRevision: true,
                }
                : { selector: nextSelector },
            'admin',
            desiredIdsFor,
        );
        return bp.id;
    }

    /**
     * The mirror image of the addition fixture: the operator shrinks the
     * roster, and the policy writes the placement approval that authorizes
     * withdrawing the node it left behind. The withdrawn node carries the
     * observation a deploy leaves, which is the evidence a removal is judged by.
     */
    async function seedPolicyRemovalInline(opts: {
        rollout: 'manual' | 'automatic';
        keptNodeIds: number[];
        removedNodeIds: number[];
    }): Promise<number> {
        const { commitBlueprintCreate, commitBlueprintUpdate } = await import('../services/gitops/blueprintProducers');
        const { GitOpsStore, emptyTargetRow } = await import('../services/gitops/store');
        const { GitOpsTransitions } = await import('../services/gitops/transitions');
        const { encodeGitOpsApprovedTargetEffectJson } = await import('../services/gitops/json');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const desiredIdsFor = (bp: import('../services/DatabaseService').Blueprint): number[] =>
            BlueprintReconciler.getInstance()
                .listDesiredNodes(bp, DatabaseService.getInstance().getNodes())
                .map((n) => n.id);

        const allNodeIds = [...opts.keptNodeIds, ...opts.removedNodeIds];
        counter += 1;
        const bp = commitBlueprintCreate({
            name: `bp-gate-policy-removal-${counter}`,
            description: null,
            compose_content: 'services:\n  app:\n    image: nginx\n',
            selector: { type: 'nodes', ids: allNodeIds },
            drift_mode: 'observe',
            classification: 'stateless',
            classification_reasons: [],
            enabled: true,
            created_by: 'admin',
        }, desiredIdsFor);

        const app = GitOpsStore.getInstance().getLiveBlueprintApplication(bp.id)!;
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE gitops_applications
                SET placement_policy = 'bounded_auto', rollout_authorization_policy = ?
              WHERE id = ?`,
        ).run(opts.rollout, app.id);

        GitOpsTransitions.getInstance().placementApproved({
            applicationId: app.id,
            approvalId: newGitOpsId(),
            intentRevisionId: app.intent_revision_id!,
            blastJson: encodeGitOpsApprovedTargetEffectJson(
                allNodeIds.map((nodeId) => ({ nodeId, outcome: 'place' as const })),
            ),
            requiredNodeIds: allNodeIds,
            fingerprint: null,
            actor: 'admin',
            envelope: { operationId: newGitOpsId(), actor: 'admin', trigger: 'test', at: Date.now() },
            rolloutGenerationId: newGitOpsId(),
            candidateId: app.rollout_candidate_id!,
            authority: 'operator',
            policyProvenanceJson: null,
        });

        for (const nodeId of allNodeIds) {
            DatabaseService.getInstance().getDb().prepare(
                `INSERT INTO blueprint_deployments (blueprint_id, node_id, status, applied_revision, last_deployed_at)
                 VALUES (?, ?, 'active', ?, ?)`,
            ).run(bp.id, nodeId, bp.revision, Date.now());
        }
        for (const nodeId of opts.removedNodeIds) {
            GitOpsStore.getInstance().upsertTarget({
                ...emptyTargetRow(app.id, nodeId, Date.now()),
                target_status: 'active',
                observed_artifact_identity_json: JSON.stringify({ kind: 'exact', identity: 'sha256:served', observedAt: 1 }),
            });
        }

        commitBlueprintUpdate(
            bp.id,
            { selector: { type: 'nodes' as const, ids: opts.keptNodeIds } },
            'admin',
            desiredIdsFor,
        );
        return bp.id;
    }

    it('executes the placement a policy approved without a legacy approval', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });

        const { GitOpsStore } = await import('../services/gitops/store');
        const live = GitOpsStore.getInstance().getLiveBlueprintApplication(blueprintId)!;
        expect(live.placement_approval_ref).not.toBeNull();
        expect(DatabaseService.getInstance().getBlueprint(blueprintId)!.approval_status).toBe('pending');

        const checkSpy = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({ kind: 'matched' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        // The added node is placed. The retained one is only observed, because
        // the policy decided the node set and never saw the compose.
        const checkedIds = checkSpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(checkedIds).toContain(nodeA.id);
        const deployedIds = deploySpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(deployedIds).toContain(nodeB.id);
        expect(deployedIds).not.toContain(nodeA.id);
    });

    it('leaves a combined compose and roster edit to the operator', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
            alsoChangeCompose: true,
        });

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        // The placement policy saw the roster, not the compose edit, so the
        // retained node's content update is not its to authorize. The whole plan
        // waits for the operator rather than partly executing.
        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('pending');
    });

    it('reports the composed approval as approved on the preview, the detail and the list', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.status).toBe(200);
        expect(preview.body.effectiveApproval).toBe('approved');
        // The authority has to be named, because the plan is approved by the
        // policy's decomposed placement approval and not by the combined one.
        expect(preview.body.approvalAuthority).toBe('configured_policy');

        const detail = await request(app).get(`/api/blueprints/${blueprintId}`).set('Cookie', adminCookie);
        expect(detail.status).toBe(200);
        expect(detail.body.effectiveApproval).toBe('approved');

        const list = await request(app).get('/api/blueprints').set('Cookie', adminCookie);
        expect(list.status).toBe(200);
        const row = list.body.find((b: { id: number }) => b.id === blueprintId);
        expect(row.effectiveApproval).toBe('approved');
    });

    it('prefers a covering policy approval over a current combined approval the plan has outgrown', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });

        // A combined approval that names only the retained node. The policy
        // approval covers the whole plan and is bound to the current intent, so
        // the tick runs under it and the combined approval is left in place as
        // the fallback rather than discarded.
        const bp = DatabaseService.getInstance().getBlueprint(blueprintId)!;
        DatabaseService.getInstance().setBlueprintApproval(blueprintId, {
            intentFingerprint: intentFingerprint(bp),
            blastJson: serializeApprovedBlast([{ nodeId: nodeA.id, outcome: 'place' as const }]),
            approvedBy: 'admin',
        });

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('approved');
        expect(preview.body.approvalAuthority).toBe('configured_policy');

        const checkSpy = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({ kind: 'matched' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        expect(deploySpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(nodeB.id);
        expect(checkSpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(nodeA.id);
        expect(DatabaseService.getInstance().getBlueprint(blueprintId)!.approval_status).toBe('approved');
    });

    it('refuses an action whose outcome does not match the approval effect for that node', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });
        const bp = DatabaseService.getInstance().getBlueprint(blueprintId)!;
        const reconciler = BlueprintReconciler.getInstance();

        // The approval places B, so withdrawing B is not its to authorize.
        expect(reconciler.policyPlacementAuthorizedActions(bp, [{ nodeId: nodeB.id, action: 'remove' }])).toBeNull();
        // A check on a node the approval does not retain is not its to authorize either.
        expect(reconciler.policyPlacementAuthorizedActions(bp, [{ nodeId: 987654, action: 'check_observe' }])).toBeNull();
    });

    it('stops executing a policy approval once the placement policy is revoked', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });

        // Revoked through the route an operator writes through. Taking the
        // placement policy back is a statement that no further change is placed
        // without them, and the approval that policy wrote has to stop with it
        // rather than wait for someone to flip rollout authorization too.
        const revoked = await request(app)
            .post(`/api/gitops/applications/bp:${blueprintId}/placement-policy`)
            .set('Cookie', adminCookie)
            .send({ policy: 'operator' });
        expect(revoked.status).toBe(200);

        const { GitOpsStore } = await import('../services/gitops/store');
        const live = GitOpsStore.getInstance().getLiveBlueprintApplication(blueprintId)!;
        expect(live.placement_policy).toBe('operator');
        // The pointer is left in place: revocation stops execution at the
        // execution-time check rather than by withdrawing it.
        expect(live.placement_approval_ref).not.toBeNull();

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);
        expect(deploySpy).not.toHaveBeenCalled();

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).not.toBe('approved');
    });

    it('waits for the operator when the rollout policy is manual', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'manual',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);
        expect(deploySpy).not.toHaveBeenCalled();

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('pending');
    });

    it('does not execute a placement approval an operator made', async () => {
        // The policy path runs where no operator decided, so only a policy's
        // own approval may execute under it. An operator's approval is not a
        // licence to skip the combined Apply it was made through.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });

        const { GitOpsStore } = await import('../services/gitops/store');
        const live = GitOpsStore.getInstance().getLiveBlueprintApplication(blueprintId)!;
        expect(live.placement_approval_ref).not.toBeNull();
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE gitops_approvals SET authority = 'operator' WHERE id = ?`,
        ).run(live.placement_approval_ref);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);
        expect(deploySpy).not.toHaveBeenCalled();

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('pending');
    });

    it('does not execute a policy approval for a non-inline application', async () => {
        // The combined approval is the executor for an Inline Blueprint. Another
        // target mode executes through its own authority, not this path.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });

        const { GitOpsStore } = await import('../services/gitops/store');
        const live = GitOpsStore.getInstance().getLiveBlueprintApplication(blueprintId)!;
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE gitops_applications
                SET target_mode = 'blueprint', configured_repo_url = 'https://example.invalid/x.git'
              WHERE id = ?`,
        ).run(live.id);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);
        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('executes a policy-approved removal through the reconciler', async () => {
        const kept = seedNode();
        const removed = seedNode();
        const blueprintId = await seedPolicyRemovalInline({
            rollout: 'automatic',
            keptNodeIds: [kept.id],
            removedNodeIds: [removed.id],
        });

        const { GitOpsStore } = await import('../services/gitops/store');
        const live = GitOpsStore.getInstance().getLiveBlueprintApplication(blueprintId)!;
        expect(live.placement_approval_ref).not.toBeNull();

        const checkSpy = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({ kind: 'matched' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        const withdrawnIds = withdrawSpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(withdrawnIds).toContain(removed.id);
        expect(deploySpy).not.toHaveBeenCalled();
        const checkedIds = checkSpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(checkedIds).toContain(kept.id);
    });

    it('does not re-place an added node the fleet already runs', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });

        const checkSpy = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({ kind: 'matched' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);
        expect(deploySpy.mock.calls.map(c => (c[1] as { id: number }).id)).toEqual([nodeB.id]);

        // The placement landed between ticks: the added node now runs the
        // revision, so the next tick only checks it.
        const revision = DatabaseService.getInstance().getBlueprint(blueprintId)!.revision;
        DatabaseService.getInstance().getDb().prepare(
            `INSERT INTO blueprint_deployments (blueprint_id, node_id, status, applied_revision, last_deployed_at)
             VALUES (?, ?, 'active', ?, ?)`,
        ).run(blueprintId, nodeB.id, revision, Date.now());

        checkSpy.mockClear();
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        expect(deploySpy.mock.calls.length).toBe(1);
        const checkedIds = checkSpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(checkedIds).toContain(nodeB.id);
    });

    it('waits when a retained node needs a content update', async () => {
        // A failed deployment on a retained node is an uncovered update, so the
        // placement policy must not place the added node around it.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE blueprint_deployments SET status = 'failed' WHERE blueprint_id = ? AND node_id = ?`,
        ).run(blueprintId, nodeA.id);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);
        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('waits when the compose edit lands while a retained node is mid-deploy', async () => {
        // The retained node emits an informational row while mid-deploy, so it
        // drops out of the plan and cannot fail the coverage count. The revision
        // it still runs is what keeps the added node from receiving compose the
        // policy never saw.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
            alsoChangeCompose: true,
        });
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE blueprint_deployments SET status = 'deploying' WHERE blueprint_id = ? AND node_id = ?`,
        ).run(blueprintId, nodeA.id);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);
        expect(deploySpy).not.toHaveBeenCalled();

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('pending');
    });

    it('waits for Apply before repairing a retained node under Enforce', async () => {
        // Drift mode is deliberately not an operational field, so the policy's
        // placement approval survives the switch. What it cannot cover is the
        // repair it then asks for: a retained node rolling out compose the
        // approval never confirmed, which is a deployment, not an observation.
        // Drift mode is part of the intent fingerprint, so the operator's
        // combined approval is stale too and the whole plan waits for Apply.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const blueprintId = await seedPolicyPlacedInline({
            rollout: 'automatic',
            initialNodeIds: [nodeA.id],
            addedNodeIds: [nodeB.id],
        });
        const { commitBlueprintUpdate } = await import('../services/gitops/blueprintProducers');
        const desiredIdsFor = (bp: import('../services/DatabaseService').Blueprint): number[] =>
            BlueprintReconciler.getInstance()
                .listDesiredNodes(bp, DatabaseService.getInstance().getNodes())
                .map((n) => n.id);
        commitBlueprintUpdate(blueprintId, { drift_mode: 'enforce' }, 'admin', desiredIdsFor);

        vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockImplementation(async (_blueprint, node) =>
            node.id === nodeA.id
                ? { kind: 'drifted', reason: 'container config differs', cause: 'container' }
                : { kind: 'matched' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        // Neither the repair nor the added node's placement runs.
        expect(deploySpy).not.toHaveBeenCalled();

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('pending');
    });

    /**
     * An Inline Blueprint an operator placed, whose roster then moves because a
     * node gains or loses a label. The label route snapshots placement before
     * and after the write and hands the pair to `recordPlacementShift`, which
     * mints the new intent and runs the policy; these tests reproduce that pair
     * directly so the producer, the policy and the reconciler all run.
     */
    async function seedAppliedInlineWithLabel(opts: {
        initialNodes: { id: number }[];
    }): Promise<{ blueprintId: number }> {
        const { commitBlueprintCreate } = await import('../services/gitops/blueprintProducers');
        const { GitOpsStore, emptyTargetRow } = await import('../services/gitops/store');
        const { GitOpsTransitions } = await import('../services/gitops/transitions');
        const { encodeGitOpsApprovedTargetEffectJson } = await import('../services/gitops/json');
        const { newGitOpsId } = await import('../services/gitops/directApplication');
        const desiredIdsFor = (bp: import('../services/DatabaseService').Blueprint): number[] =>
            BlueprintReconciler.getInstance()
                .listDesiredNodes(bp, DatabaseService.getInstance().getNodes())
                .map((n) => n.id);

        for (const node of opts.initialNodes) {
            NodeLabelService.getInstance().addLabel(node.id, 'web');
        }
        counter += 1;
        const bp = commitBlueprintCreate({
            name: `bp-gate-label-${counter}`,
            description: null,
            compose_content: 'services:\n  app:\n    image: nginx\n',
            selector: { type: 'labels', any: ['web'], all: [] },
            drift_mode: 'observe',
            classification: 'stateless',
            classification_reasons: [],
            enabled: true,
            created_by: 'admin',
        }, desiredIdsFor);

        const app = GitOpsStore.getInstance().getLiveBlueprintApplication(bp.id)!;
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE gitops_applications SET placement_policy = 'bounded_auto' WHERE id = ?`,
        ).run(app.id);

        // The operator's Apply leaves both approvals behind: the combined one on
        // the Blueprint and the decomposed operator placement approval the apply
        // route writes beside it.
        DatabaseService.getInstance().setBlueprintApproval(bp.id, {
            intentFingerprint: intentFingerprint(bp),
            blastJson: serializeApprovedBlast(
                opts.initialNodes.map((node) => ({ nodeId: node.id, outcome: 'place' as const })),
            ),
            approvedBy: 'admin',
        });
        GitOpsTransitions.getInstance().placementApproved({
            applicationId: app.id,
            approvalId: newGitOpsId(),
            intentRevisionId: app.intent_revision_id!,
            blastJson: encodeGitOpsApprovedTargetEffectJson(
                opts.initialNodes.map((node) => ({ nodeId: node.id, outcome: 'place' as const })),
            ),
            requiredNodeIds: opts.initialNodes.map((node) => node.id),
            fingerprint: null,
            actor: 'admin',
            envelope: { operationId: newGitOpsId(), actor: 'admin', trigger: 'blueprint_apply', at: Date.now() },
            rolloutGenerationId: newGitOpsId(),
            candidateId: app.rollout_candidate_id!,
            authority: 'operator',
            policyProvenanceJson: null,
        });
        for (const node of opts.initialNodes) {
            DatabaseService.getInstance().getDb().prepare(
                `INSERT INTO blueprint_deployments (blueprint_id, node_id, status, applied_revision, last_deployed_at)
                 VALUES (?, ?, 'active', ?, ?)`,
            ).run(bp.id, node.id, bp.revision, Date.now());
            // The observation a deploy leaves, which is the evidence a later
            // removal of this node is judged by.
            GitOpsStore.getInstance().upsertTarget({
                ...emptyTargetRow(app.id, node.id, Date.now()),
                target_status: 'active',
                observed_artifact_identity_json: JSON.stringify({ kind: 'exact', identity: 'sha256:served', observedAt: 1 }),
            });
        }
        return { blueprintId: bp.id };
    }

    /** The label route's pair: snapshot, mutate, snapshot, hand to the producer. */
    async function shiftPlacementByLabel(blueprintId: number, mutate: () => void): Promise<void> {
        const { recordPlacementShift, snapshotPlacementWith } = await import('../services/gitops/nodePlacementProducers');
        const bp = DatabaseService.getInstance().getBlueprint(blueprintId)!;
        const desiredIdsFor = (target: import('../services/DatabaseService').Blueprint): number[] =>
            BlueprintReconciler.getInstance()
                .listDesiredNodes(target, DatabaseService.getInstance().getNodes())
                .map((n) => n.id);
        const before = snapshotPlacementWith(desiredIdsFor, [bp]);
        mutate();
        const after = snapshotPlacementWith(desiredIdsFor, [bp]);
        recordPlacementShift(before, after, 'admin', 'node_label_add');
    }

    it('executes a label-driven addition the policy approves while the combined approval stays in place', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const { blueprintId } = await seedAppliedInlineWithLabel({ initialNodes: [nodeA] });

        // The rollout policy is set through the route the interface writes
        // through, not by seeding the column, because an Inline Blueprint with
        // no reachable way to set it is exactly the configuration that made the
        // policy approval inert.
        const policy = await request(app)
            .post(`/api/gitops/applications/bp:${blueprintId}/rollout/authorization-policy`)
            .set('Cookie', adminCookie)
            .send({ policy: 'automatic' });
        expect(policy.status).toBe(200);

        await shiftPlacementByLabel(blueprintId, () => {
            expect(NodeLabelService.getInstance().addLabel(nodeB.id, 'web').ok).toBe(true);
        });

        const { GitOpsStore } = await import('../services/gitops/store');
        const live = GitOpsStore.getInstance().getLiveBlueprintApplication(blueprintId)!;
        expect(live.placement_approval_ref).not.toBeNull();
        // The policy path is preferred, not substituted for the operator's
        // approval: the combined approval survives as the fallback for a tick
        // the policy cannot cover.
        expect(DatabaseService.getInstance().getBlueprint(blueprintId)!.approval_status).toBe('approved');

        const checkSpy = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({ kind: 'matched' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        expect(deploySpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(nodeB.id);
        expect(checkSpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(nodeA.id);

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('approved');
        expect(preview.body.approvalAuthority).toBe('configured_policy');
    });

    it('keeps checking a retained node when a label-driven addition waits under manual rollout', async () => {
        // The policy cannot execute the added node under a manual rollout, so
        // the operator's combined approval stays the executor: the retained node
        // keeps its drift check (and would keep an Enforce repair) while the
        // added node waits for Apply. Suspending the whole tick here would stop
        // drift observation for a running Blueprint on a routine label change.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const { blueprintId } = await seedAppliedInlineWithLabel({ initialNodes: [nodeA] });

        await shiftPlacementByLabel(blueprintId, () => {
            expect(NodeLabelService.getInstance().addLabel(nodeB.id, 'web').ok).toBe(true);
        });

        const checkSpy = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({ kind: 'matched' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);
        expect(deploySpy).not.toHaveBeenCalled();
        expect(checkSpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(nodeA.id);

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('reapproval_required');
    });

    it('keeps checking a retained node when a label-driven removal waits under manual rollout', async () => {
        // The removal mirror of the addition case. The policy approved the
        // withdrawal, so the placement pointer moved and the operator's combined
        // approval now names a node the placement dropped. That narrows the
        // approval to the nodes the placement still retains instead of
        // invalidating it: A keeps its drift check and B waits for Apply.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const { blueprintId } = await seedAppliedInlineWithLabel({ initialNodes: [nodeA, nodeB] });

        await shiftPlacementByLabel(blueprintId, () => {
            expect(NodeLabelService.getInstance().removeLabel(nodeB.id, 'web')).toBe(true);
        });

        const checkSpy = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({ kind: 'matched' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        expect(checkSpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(nodeA.id);
        expect(withdrawSpy).not.toHaveBeenCalled();
        expect(deploySpy).not.toHaveBeenCalled();
        // The approval is not discarded. What waits is the node it no longer
        // covers, which is the difference between a policy declining a change
        // and a policy retiring the operator's authority.
        expect(DatabaseService.getInstance().getBlueprint(blueprintId)!.approval_status).toBe('approved');

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('reapproval_required');
    });

    it('keeps the operator approval when the policy cannot run a label-driven removal', async () => {
        // Automatic rollout, but the retained node is in flight on an older
        // revision, so the policy approval cannot resolve to a full plan and the
        // operator's approval is the executor again. Nothing runs (the retained
        // node is mid-deploy and the withdrawal was never in its blast), and the
        // approval is still standing for the checks it does authorize.
        const nodeA = seedNode();
        const nodeB = seedNode();
        const { blueprintId } = await seedAppliedInlineWithLabel({ initialNodes: [nodeA, nodeB] });

        const policy = await request(app)
            .post(`/api/gitops/applications/bp:${blueprintId}/rollout/authorization-policy`)
            .set('Cookie', adminCookie)
            .send({ policy: 'automatic' });
        expect(policy.status).toBe(200);

        await shiftPlacementByLabel(blueprintId, () => {
            expect(NodeLabelService.getInstance().removeLabel(nodeB.id, 'web')).toBe(true);
        });
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE blueprint_deployments
                SET status = 'deploying', applied_revision = applied_revision - 1
              WHERE blueprint_id = ? AND node_id = ?`,
        ).run(blueprintId, nodeA.id);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();
        expect(DatabaseService.getInstance().getBlueprint(blueprintId)!.approval_status).toBe('approved');
    });

    it('executes a label-driven removal the policy approves', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const { blueprintId } = await seedAppliedInlineWithLabel({ initialNodes: [nodeA, nodeB] });

        const policy = await request(app)
            .post(`/api/gitops/applications/bp:${blueprintId}/rollout/authorization-policy`)
            .set('Cookie', adminCookie)
            .send({ policy: 'automatic' });
        expect(policy.status).toBe(200);

        await shiftPlacementByLabel(blueprintId, () => {
            expect(NodeLabelService.getInstance().removeLabel(nodeB.id, 'web')).toBe(true);
        });

        const checkSpy = vi.spyOn(BlueprintService.getInstance(), 'checkForDrift').mockResolvedValue({ kind: 'matched' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        expect(withdrawSpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(nodeB.id);
        expect(deploySpy).not.toHaveBeenCalled();
        expect(checkSpy.mock.calls.map(c => (c[1] as { id: number }).id)).toContain(nodeA.id);
    });

    it('keeps a failed retained retry running while the policy cannot cover the plan', async () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const { blueprintId } = await seedAppliedInlineWithLabel({ initialNodes: [nodeA] });

        const policy = await request(app)
            .post(`/api/gitops/applications/bp:${blueprintId}/rollout/authorization-policy`)
            .set('Cookie', adminCookie)
            .send({ policy: 'automatic' });
        expect(policy.status).toBe(200);

        await shiftPlacementByLabel(blueprintId, () => {
            expect(NodeLabelService.getInstance().addLabel(nodeB.id, 'web').ok).toBe(true);
        });
        // A failed retained deployment is a retry the policy does not authorize,
        // so the plan falls back to the operator's combined approval: the retry
        // runs and the added node waits, rather than the tick stopping whole.
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE blueprint_deployments SET status = 'failed' WHERE blueprint_id = ? AND node_id = ?`,
        ).run(blueprintId, nodeA.id);

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        await BlueprintReconciler.getInstance().reconcileOne(blueprintId);

        const deployedIds = deploySpy.mock.calls.map(c => (c[1] as { id: number }).id);
        expect(deployedIds).toContain(nodeA.id);
        expect(deployedIds).not.toContain(nodeB.id);

        const preview = await request(app).get(`/api/blueprints/${blueprintId}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('reapproval_required');
    });

    it('waits for Apply on a first placement under both automatic policies', async () => {
        const nodeA = seedNode();
        const { commitBlueprintCreate } = await import('../services/gitops/blueprintProducers');
        const desiredIdsFor = (bp: import('../services/DatabaseService').Blueprint): number[] =>
            BlueprintReconciler.getInstance()
                .listDesiredNodes(bp, DatabaseService.getInstance().getNodes())
                .map((n) => n.id);
        // No operator Apply: the selector matches nothing yet, so no content has
        // ever been confirmed and no deployment anchors the revision check.
        counter += 1;
        const bp = commitBlueprintCreate({
            name: `bp-gate-first-${counter}`,
            description: null,
            compose_content: 'services:\n  app:\n    image: nginx\n',
            selector: { type: 'labels', any: ['web'], all: [] },
            drift_mode: 'observe',
            classification: 'stateless',
            classification_reasons: [],
            enabled: true,
            created_by: 'admin',
        }, desiredIdsFor);

        const placement = await request(app)
            .post(`/api/gitops/applications/bp:${bp.id}/placement-policy`)
            .set('Cookie', adminCookie)
            .send({ policy: 'bounded_auto' });
        expect(placement.status).toBe(200);
        const rollout = await request(app)
            .post(`/api/gitops/applications/bp:${bp.id}/rollout/authorization-policy`)
            .set('Cookie', adminCookie)
            .send({ policy: 'automatic' });
        expect(rollout.status).toBe(200);

        // The node gaining the label is the first placement the policy sees: a
        // single stateless addition, so the policy records an approval even
        // though nothing has ever been placed.
        await shiftPlacementByLabel(bp.id, () => {
            expect(NodeLabelService.getInstance().addLabel(nodeA.id, 'web').ok).toBe(true);
        });

        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        await BlueprintReconciler.getInstance().reconcileOne(bp.id);
        // With nothing already placed, the policy would be approving compose no
        // operator ever confirmed, so the first placement waits for Apply.
        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();

        const preview = await request(app).get(`/api/blueprints/${bp.id}/preview`).set('Cookie', adminCookie);
        expect(preview.body.effectiveApproval).toBe('pending');
    });
});

describe('preview health and warning totals', () => {
    it('includes reachabilityNote in blocker copy for offline remotes', async () => {
        const node = seedNode({
            type: 'remote',
            mode: 'proxy',
            status: 'offline',
            last_successful_contact: Math.floor(Date.now() / 1000) - 10,
        });
        const bp = createBp({ nodeIds: [node.id] });
        const preview = await request(app).get(`/api/blueprints/${bp.id}/preview`).set('Cookie', adminCookie);
        expect(preview.status).toBe(200);
        const change = preview.body.changes.find((c: { nodeId: number }) => c.nodeId === node.id);
        expect(change.reachabilityNote).toMatch(/offline/i);
        expect(change.severity).toBe('blocker');
        const blocker = preview.body.blockers.find((b: { id: string }) => b.id.includes(String(node.id)));
        expect(blocker.message).toMatch(/offline|unknown/i);
    });

    it('counts requirement and compatibility warnings in summary.warning', async () => {
        const node = seedNode();
        const bp = createBp({
            nodeIds: [node.id],
            compose: 'services:\n  app:\n    image: nginx\n    environment:\n      - DB_PASSWORD=${DB_PASSWORD}\n',
        });
        // Force a classification reason into the blueprint row for compat warnings.
        DatabaseService.getInstance().getDb().prepare(
            `UPDATE blueprints SET classification_reasons = ? WHERE id = ?`,
        ).run(JSON.stringify(['uses named volumes']), bp.id);

        const preview = await request(app).get(`/api/blueprints/${bp.id}/preview`).set('Cookie', adminCookie);
        expect(preview.status).toBe(200);
        expect(preview.body.warnings.length).toBeGreaterThan(0);
        expect(preview.body.summary.warning).toBe(preview.body.warnings.length);
        expect(preview.body.summary.blocker).toBe(preview.body.blockers.length);
    });
});

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

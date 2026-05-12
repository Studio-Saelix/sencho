/**
 * BlueprintReconciler decision-logic tests.
 *
 * The reconciler's `computeDecision` is the load-bearing pure logic. Given
 * a blueprint, an actual deployment table, and a desired node set, it must
 * decide for each node whether to deploy, withdraw, drift-check, state-review,
 * or evict-block. We test that decision in isolation by accessing the
 * private method via a type-cast, mirroring the AutoHealService.shouldHeal
 * pattern.
 *
 * Local deploy / remote HTTP / actual `docker compose` invocation are not
 * exercised here; they're integration concerns covered by the manual
 * lifecycle in the plan.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { Blueprint, Node } from '../services/DatabaseService';
import type { ReconcileDecision } from '../services/BlueprintReconciler';

type ReconcilerWithCompute = { computeDecision: (blueprint: Blueprint, allNodes: Node[]) => ReconcileDecision };

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let NodeLabelService: typeof import('../services/NodeLabelService').NodeLabelService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let counter = 0;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));
    ({ NodeLabelService } = await import('../services/NodeLabelService'));
    ({ BlueprintService } = await import('../services/BlueprintService'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM node_labels').run();
    db.prepare("DELETE FROM nodes WHERE is_default = 0").run();
    db.prepare("UPDATE global_settings SET value = '0' WHERE key = 'developer_mode'").run();
    vi.restoreAllMocks();
});

function seedNode(): number {
    counter += 1;
    const db = DatabaseService.getInstance().getDb();
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`
    ).run(`bp-test-${counter}`, Date.now());
    return result.lastInsertRowid as number;
}

function seedBlueprint(opts: {
    name?: string;
    classification?: 'stateless' | 'stateful' | 'unknown';
    drift_mode?: 'observe' | 'suggest' | 'enforce';
    nodeIds?: number[];
    revision?: number;
}) {
    counter += 1;
    const name = opts.name ?? `bp-${counter}`;
    return DatabaseService.getInstance().createBlueprint({
        name,
        description: null,
        compose_content: 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: opts.nodeIds ?? [] },
        drift_mode: opts.drift_mode ?? 'suggest',
        classification: opts.classification ?? 'stateless',
        classification_reasons: [],
        enabled: true,
        created_by: null,
    });
}

describe('BlueprintReconciler.computeDecision', () => {
    it('queues deploy for a stateless blueprint targeting a fresh node', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.stateReview).toEqual([]);
    });

    it('queues state-review (not deploy) for a stateful blueprint targeting a fresh node', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.stateReview.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.deploy).toEqual([]);
    });

    it('queues drift-check for an active deployment whose revision matches', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.check.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.deploy).toEqual([]);
    });

    it('queues redeploy when the blueprint revision moved past the deployed revision', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision - 1,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeId);
    });

    it('queues state-review when a stateful deployment revision moves', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision - 1,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.stateReview.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.deploy).toEqual([]);
    });

    it('queues stateless eviction when a node leaves the selector', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.withdraw.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.evictBlocked).toEqual([]);
    });

    it('queues evict_blocked (not auto-withdraw) when a STATEFUL deployment leaves the selector', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.evictBlocked.map((n: { id: number }) => n.id)).toContain(nodeId);
        expect(decision.withdraw).toEqual([]);
    });

    it('skips deployments already in pending_state_review or evict_blocked or name_conflict', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const nodeC = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeA, nodeB, nodeC] });
        DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: nodeA, status: 'pending_state_review' });
        DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: nodeB, status: 'evict_blocked' });
        DatabaseService.getInstance().upsertDeployment({ blueprint_id: bp.id, node_id: nodeC, status: 'name_conflict' });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy).toEqual([]);
        expect(decision.check).toEqual([]);
        expect(decision.withdraw).toEqual([]);
    });

    it('skips new placements onto cordoned nodes (cordon filter)', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, 'maintenance');
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy).toEqual([]);
        expect(decision.stateReview).toEqual([]);
    });

    it('skips state-review for stateful blueprints landing on cordoned nodes', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, null);
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.stateReview).toEqual([]);
        expect(decision.deploy).toEqual([]);
    });

    it('still redeploys for revision drift on a cordoned node (existing deployment, not a new placement)', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, null);
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision - 1,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeId);
    });

    it('still drift-checks active deployments on a cordoned node', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, null);
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeId] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: nodeId,
            status: 'active',
            applied_revision: bp.revision,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.check.map((n: { id: number }) => n.id)).toContain(nodeId);
    });

    it('honors pin override: desired set is exactly the pinned node, regardless of selector', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeA] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeB);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeB);
        expect(decision.deploy.map((n: { id: number }) => n.id)).not.toContain(nodeA);
    });

    it('pin overrides cordon: pinned blueprint deploys onto a cordoned node', () => {
        const nodeId = seedNode();
        DatabaseService.getInstance().setNodeCordoned(nodeId, true, null);
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeId);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeId);
    });

    it('pin to a non-existent node yields an empty desired set', () => {
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, 999_999);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.deploy).toEqual([]);
        expect(decision.stateReview).toEqual([]);
    });

    it('pin shrinks the desired set: stateless deployments on non-pinned nodes are queued for withdraw', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeA, nodeB] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id, node_id: nodeA, status: 'active', applied_revision: bp.revision,
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id, node_id: nodeB, status: 'active', applied_revision: bp.revision,
        });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeA);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.check.map((n: { id: number }) => n.id)).toContain(nodeA);
        expect(decision.withdraw.map((n: { id: number }) => n.id)).toContain(nodeB);
        expect(decision.evictBlocked).toEqual([]);
    });

    it('pin shrinks the desired set: stateful deployments on non-pinned nodes are queued for evict_blocked', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeA, nodeB] });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id, node_id: nodeA, status: 'active', applied_revision: bp.revision,
        });
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id, node_id: nodeB, status: 'active', applied_revision: bp.revision,
        });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeA);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.evictBlocked.map((n: { id: number }) => n.id)).toContain(nodeB);
        expect(decision.withdraw).toEqual([]);
    });

    it('deleting the pinned node clears the pin from the blueprint', () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeId);
        expect(DatabaseService.getInstance().getBlueprint(bp.id)!.pinned_node_id).toBe(nodeId);
        DatabaseService.getInstance().deleteNode(nodeId);
        expect(DatabaseService.getInstance().getBlueprint(bp.id)!.pinned_node_id).toBeNull();
    });

    it('clearing the pin restores selector behavior on the next tick', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [nodeA] });
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, nodeB);
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, null);
        const refreshed = DatabaseService.getInstance().getBlueprint(bp.id)!;
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(refreshed, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeA);
        expect(decision.deploy.map((n: { id: number }) => n.id)).not.toContain(nodeB);
    });

    it('matches via labels selector and respects label changes', () => {
        const nodeA = seedNode();
        const nodeB = seedNode();
        NodeLabelService.getInstance().addLabel(nodeA, 'prod');
        NodeLabelService.getInstance().addLabel(nodeB, 'staging');
        const bp = DatabaseService.getInstance().createBlueprint({
            name: 'caddy-via-labels',
            description: null,
            compose_content: 'services:\n  caddy:\n    image: caddy\n',
            selector: { type: 'labels', any: ['prod'], all: [] },
            drift_mode: 'suggest',
            classification: 'stateless',
            classification_reasons: [],
            enabled: true,
            created_by: null,
        });
        const reconciler = BlueprintReconciler.getInstance() as unknown as ReconcilerWithCompute;
        const allNodes = DatabaseService.getInstance().getNodes();
        const decision = reconciler.computeDecision(bp, allNodes);
        expect(decision.deploy.map((n: { id: number }) => n.id)).toContain(nodeA);
        expect(decision.deploy.map((n: { id: number }) => n.id)).not.toContain(nodeB);
    });
});

describe('BlueprintReconciler developer-mode diagnostics', () => {
    it('does not emit diagnostic logs when developer mode is off', async () => {
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(infoSpy.mock.calls.some(([message]) => String(message).includes('[BlueprintReconciler:diag]'))).toBe(false);
    });

    it('emits diagnostic decision logs when developer mode is on', async () => {
        DatabaseService.getInstance().updateGlobalSetting('developer_mode', '1');
        const nodeId = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [nodeId] });
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await BlueprintReconciler.getInstance().reconcileOne(bp.id);

        expect(infoSpy.mock.calls.some(([message]) => String(message).includes('[BlueprintReconciler:diag]'))).toBe(true);
    });
});

describe('BlueprintService marker parsing + name-conflict guard', () => {
    it('parseMarker accepts a well-formed marker', () => {
        const marker = BlueprintService.parseMarker(JSON.stringify({ blueprintId: 7, revision: 3, lastApplied: 12345 }));
        expect(marker).toEqual({ blueprintId: 7, revision: 3, lastApplied: 12345 });
    });

    it('parseMarker rejects an invalid marker', () => {
        expect(BlueprintService.parseMarker('not json')).toBeNull();
        expect(BlueprintService.parseMarker(JSON.stringify({ revision: 1 }))).toBeNull();
        expect(BlueprintService.parseMarker(JSON.stringify({ blueprintId: 'nope', revision: 1 }))).toBeNull();
    });
});
